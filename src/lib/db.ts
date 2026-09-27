import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb';
import { mergeText } from './merge';

/**
 * Local-first storage. Every keystroke lands here first; the sync engine
 * reconciles it with GitHub in the background.
 */
export interface EntryRecord {
  date: string;
  text: string;
  /** Blob sha of the remote version this entry is based on; null if never synced. */
  sha: string | null;
  /** Text of that remote version, kept while dirty for three-way merges. */
  base: string | null;
  /** Local changes not yet pushed. An empty dirty entry with a sha is a pending delete. */
  dirty: boolean;
  updatedAt: number;
}

/** Small per-entry row so the month bar and history never load full texts. */
export interface EntrySummary {
  date: string;
  words: number;
  preview: string;
  dirty: boolean;
}

export interface RemoteChange {
  date: string;
  sha: string;
  text: string;
}

export interface PushedEntry {
  date: string;
  text: string;
  sha: string | null;
}

interface Schema extends DBSchema {
  entries: { key: string; value: EntryRecord };
  summaries: { key: string; value: EntrySummary };
  /** Keys of dirty entries, so finding work to push never scans full texts. */
  pending: { key: string; value: true };
  meta: { key: string; value: unknown };
}

const WRITE_STORES = ['entries', 'summaries', 'pending'] as const;
type WriteTx = IDBPTransaction<Schema, ('entries' | 'summaries' | 'pending')[], 'readwrite'>;

export type ChangeSource = 'local' | 'remote';
export interface ChangeEvent {
  dates: string[];
  source: ChangeSource;
}

export function countWords(text: string): number {
  const t = text.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

function summarize(e: EntryRecord): EntrySummary {
  return {
    date: e.date,
    words: countWords(e.text),
    // &#x20; is an artifact of older Markdown editors; don't show it in previews.
    preview: e.text.replace(/&#x20;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240),
    dirty: e.dirty,
  };
}

export class JournalDb {
  private listeners = new Set<(e: ChangeEvent) => void>();

  private constructor(private db: IDBPDatabase<Schema>) {}

  static async open(name: string): Promise<JournalDb> {
    const db = await openDB<Schema>(`permajournal:${name}`, 1, {
      upgrade(db) {
        db.createObjectStore('entries', { keyPath: 'date' });
        db.createObjectStore('summaries', { keyPath: 'date' });
        db.createObjectStore('pending');
        db.createObjectStore('meta');
      },
    });
    return new JournalDb(db);
  }

  static async destroy(name: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(`permajournal:${name}`);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  }

  close() {
    this.db.close();
  }

  onChange(fn: (e: ChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(dates: string[], source: ChangeSource) {
    if (dates.length === 0) return;
    for (const fn of this.listeners) fn({ dates, source });
  }

  async getEntry(date: string): Promise<EntryRecord | undefined> {
    return this.db.get('entries', date);
  }

  async getText(date: string): Promise<string> {
    return (await this.db.get('entries', date))?.text ?? '';
  }

  /** Dates with a non-empty entry. */
  async writtenDates(): Promise<string[]> {
    return this.db.getAllKeys('summaries');
  }

  async summaries(): Promise<EntrySummary[]> {
    return this.db.getAll('summaries');
  }

  async allEntries(): Promise<EntryRecord[]> {
    return this.db.getAll('entries');
  }

  async dirtyEntries(): Promise<EntryRecord[]> {
    const tx = this.db.transaction(['pending', 'entries']);
    const dates = await tx.objectStore('pending').getAllKeys();
    const entries = await Promise.all(dates.map((d) => tx.objectStore('entries').get(d)));
    return entries.filter((e): e is EntryRecord => !!e?.dirty);
  }

  async pendingCount(): Promise<number> {
    return this.db.count('pending');
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.db.get('meta', key)) as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.db.put('meta', value, key);
  }

  /** Save what the user typed. */
  async saveLocal(date: string, text: string): Promise<void> {
    const tx = this.db.transaction([...WRITE_STORES], 'readwrite');
    const existing = await tx.objectStore('entries').get(date);
    if (existing ? existing.text === text : text === '') {
      await tx.done;
      return;
    }
    const next: EntryRecord = existing
      ? {
          ...existing,
          text,
          dirty: true,
          base: existing.dirty ? existing.base : existing.sha ? existing.text : null,
          updatedAt: Date.now(),
        }
      : { date, text, sha: null, base: null, dirty: true, updatedAt: Date.now() };
    await this.write(tx, next);
    await tx.done;
    this.emit([date], 'local');
  }

  /** Apply files that changed on GitHub, merging with unpushed local edits. */
  async applyRemote(changes: RemoteChange[], removed: string[]): Promise<void> {
    const tx = this.db.transaction([...WRITE_STORES], 'readwrite');
    const store = tx.objectStore('entries');
    const touched: string[] = [];
    for (const c of changes) {
      const local = await store.get(c.date);
      if (local && local.sha === c.sha) continue;
      let next: EntryRecord;
      if (!local || !local.dirty) {
        next = { date: c.date, text: c.text, sha: c.sha, base: null, dirty: false, updatedAt: Date.now() };
      } else {
        const merged = mergeText(local.base, local.text, c.text);
        const dirty = merged !== c.text;
        next = { ...local, text: merged, sha: c.sha, base: dirty ? c.text : null, dirty, updatedAt: Date.now() };
      }
      await this.write(tx, next);
      touched.push(c.date);
    }
    for (const date of removed) {
      const local = await store.get(date);
      if (!local) continue;
      if (local.dirty) {
        // Deleted remotely but edited here: keep the edit and re-create the file.
        await this.write(tx, { ...local, sha: null, base: null });
      } else {
        await this.write(tx, { ...local, text: '', sha: null, dirty: false });
      }
      touched.push(date);
    }
    await tx.done;
    this.emit(touched, 'remote');
  }

  /** Record a successful push. Entries edited while the push was in flight stay dirty. */
  async markPushed(pushed: PushedEntry[]): Promise<void> {
    const tx = this.db.transaction([...WRITE_STORES], 'readwrite');
    const store = tx.objectStore('entries');
    const touched: string[] = [];
    for (const p of pushed) {
      const local = await store.get(p.date);
      if (!local) continue;
      if (local.text === p.text) {
        await this.write(tx, { ...local, sha: p.sha, base: null, dirty: false });
      } else {
        await this.write(tx, { ...local, sha: p.sha, base: p.sha ? p.text : null });
      }
      touched.push(p.date);
    }
    await tx.done;
    this.emit(touched, 'remote');
  }

  /** Forget which remote versions we've seen so the next sync re-reads everything. */
  async resetRemoteState(): Promise<void> {
    await this.db.delete('meta', 'remoteCommit');
    await this.db.delete('meta', 'remoteIndex');
  }

  private async write(tx: WriteTx, e: EntryRecord) {
    const entries = tx.objectStore('entries');
    const summaries = tx.objectStore('summaries');
    const pending = tx.objectStore('pending');
    if (e.text === '' && (e.sha === null || !e.dirty)) {
      // Nothing locally and nothing (left) to delete remotely.
      await Promise.all([entries.delete(e.date), summaries.delete(e.date), pending.delete(e.date)]);
      return;
    }
    await entries.put(e);
    if (e.text === '') await summaries.delete(e.date);
    else await summaries.put(summarize(e));
    if (e.dirty) await pending.put(true, e.date);
    else await pending.delete(e.date);
  }
}
