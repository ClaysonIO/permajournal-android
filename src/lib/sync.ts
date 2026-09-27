import type { JournalDb, PushedEntry, RemoteChange } from './db';
import { ENTRY_FILE } from './dates';
import { gitBlobSha } from './gitsha';
import { GitHubError, type JournalRemote, type RemoteHead } from './github';

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error' | 'auth';

export interface SyncState {
  phase: SyncPhase;
  pending: number;
  lastSyncAt: number | null;
  error: string | null;
  /** Download progress during a large pull (e.g. the first one). */
  progress: { done: number; total: number } | null;
}

const MAX_ATTEMPTS = 5;

/**
 * Keeps the local database and the GitHub branch converged:
 * pull what changed remotely (merging into unpushed edits), then push all
 * local edits as a single commit. If someone else pushed in between, the
 * branch update is rejected and we simply pull, merge and try again.
 */
export class SyncEngine {
  private running: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 0;
  private listeners = new Set<(s: SyncState) => void>();
  private online = true;
  private stopped = false;
  state: SyncState = { phase: 'idle', pending: 0, lastSyncAt: null, error: null, progress: null };

  constructor(
    private db: JournalDb,
    private remote: JournalRemote,
    private folder: string,
  ) {}

  async init(): Promise<void> {
    this.update({
      pending: await this.db.pendingCount(),
      lastSyncAt: (await this.db.getMeta<number>('lastSyncAt')) ?? null,
    });
  }

  subscribe(fn: (s: SyncState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private update(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  setOnline(online: boolean) {
    this.online = online;
    if (!online) {
      this.update({ phase: 'offline' });
    } else {
      this.retryDelay = 0;
      if (this.state.phase === 'offline') this.update({ phase: 'idle' });
      this.request();
    }
  }

  async notePendingChange() {
    this.update({ pending: await this.db.pendingCount() });
  }

  /** Ask for a sync after `delay` ms, coalescing with any already scheduled. */
  request(delay = 0) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, delay);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  /** Run a sync; if one is in flight, run another right after it. */
  syncNow(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.runOnce();
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runOnce() {
    if (this.stopped) return;
    if (!this.online) {
      this.update({ phase: 'offline' });
      return;
    }
    this.update({ phase: 'syncing', error: null });
    try {
      for (let attempt = 0; ; attempt++) {
        const head = await this.remote.getHead();
        if (!head) throw new Error('The branch has no commits yet.');
        await this.pull(head);
        const result = await this.push(head);
        if (result !== 'conflict') break;
        if (attempt + 1 >= MAX_ATTEMPTS) throw new Error('GitHub kept changing during sync; will retry.');
      }
      const now = Date.now();
      await this.db.setMeta('lastSyncAt', now);
      this.retryDelay = 0;
      this.update({ phase: 'idle', lastSyncAt: now, progress: null, pending: await this.db.pendingCount() });
    } catch (e) {
      const auth = e instanceof GitHubError && e.isAuth;
      const offline = !auth && !(e instanceof GitHubError) && e instanceof TypeError; // fetch network failure
      this.update({
        phase: auth ? 'auth' : offline ? 'offline' : 'error',
        error: e instanceof Error ? e.message : String(e),
        progress: null,
        pending: await this.db.pendingCount(),
      });
      if (!auth) {
        // Back off: 10s, 20s, 40s ... capped at 5 minutes.
        this.retryDelay = Math.min(this.retryDelay ? this.retryDelay * 2 : 10_000, 300_000);
        this.request(this.retryDelay);
      }
    }
  }

  private async pull(head: RemoteHead) {
    if ((await this.db.getMeta<string>('remoteCommit')) === head.commit) return;

    const known = (await this.db.getMeta<Record<string, string>>('remoteIndex')) ?? {};
    const files = await this.remote.listFolder(head.commit, this.folder);
    const index: Record<string, string> = {};
    for (const f of files) {
      const m = ENTRY_FILE.exec(f.name);
      if (m) index[m[1]] = f.sha;
    }

    const changedDates = Object.keys(index).filter((d) => known[d] !== index[d]);
    const removed = Object.keys(known).filter((d) => !(d in index));

    // Skip blobs we already have (e.g. ones we pushed ourselves).
    const toFetch: string[] = [];
    for (const d of changedDates) {
      if ((await this.db.getEntry(d))?.sha !== index[d]) toFetch.push(d);
    }

    const total = toFetch.length;
    const CHUNK = 200;
    for (let i = 0; i < toFetch.length; i += CHUNK) {
      if (total > CHUNK) this.update({ progress: { done: i, total } });
      const dates = toFetch.slice(i, i + CHUNK);
      const blobs = await this.remote.getBlobs(dates.map((d) => index[d]));
      const changes: RemoteChange[] = [];
      for (const d of dates) {
        const text = blobs.get(index[d]);
        if (text !== undefined) changes.push({ date: d, sha: index[d], text });
      }
      await this.db.applyRemote(changes, []);
    }
    if (removed.length) await this.db.applyRemote([], removed);

    await this.db.setMeta('remoteIndex', index);
    await this.db.setMeta('remoteCommit', head.commit);
  }

  private async push(head: RemoteHead): Promise<'ok' | 'conflict'> {
    const dirty = await this.db.dirtyEntries();
    if (dirty.length === 0) return 'ok';

    const files = dirty.map((e) => ({
      path: `${this.folder}/${e.date}.md`,
      content: e.text === '' ? null : e.text,
    }));
    const dates = dirty.map((e) => e.date).sort();
    const message = dates.length <= 3 ? `sync: ${dates.join(', ')}` : `sync: ${dates.length} entries (${dates[0]} … ${dates.at(-1)})`;

    const result = await this.remote.commit(head, files, message);
    if (result === 'conflict') return 'conflict';

    const pushed: PushedEntry[] = await Promise.all(
      dirty.map(async (e) => ({ date: e.date, text: e.text, sha: e.text === '' ? null : await gitBlobSha(e.text) })),
    );
    await this.db.markPushed(pushed);

    const index = { ...((await this.db.getMeta<Record<string, string>>('remoteIndex')) ?? {}) };
    for (const p of pushed) {
      if (p.sha) index[p.date] = p.sha;
      else delete index[p.date];
    }
    await this.db.setMeta('remoteIndex', index);
    await this.db.setMeta('remoteCommit', result.commit);
    return 'ok';
  }
}
