import type { SearchResponse, SearchStatus } from './index';
import type { FromWorker, ToWorker } from './protocol';

/** Kept in step with SEARCH_DB_PREFIX in ./index, which only the worker loads. */
const SEARCH_DB_PREFIX = 'permajournal-search:';

const INITIAL: SearchStatus = { phase: 'scanning', entries: 0, embedded: 0, model: 'idle' };

/**
 * The UI's handle on the search worker. Creating one costs nothing; the
 * worker (and with it all search code) is only loaded by `start()`.
 */
export class SearchService {
  private worker: Worker | null = null;
  private listeners = new Set<() => void>();
  private waiting = new Map<number, { resolve: (r: SearchResponse) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private disposed = false;
  status: SearchStatus = INITIAL;

  constructor(private repo: string) {}

  start() {
    if (this.worker || this.disposed) return;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'status') {
        this.status = m.status;
        for (const fn of this.listeners) fn();
        return;
      }
      const w = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      if (m.type === 'results') w?.resolve(m.response);
      else w?.reject(new Error(m.error));
    };
    const asset = (path: string) => new URL(path, document.baseURI).href;
    this.send({
      type: 'init',
      repo: this.repo,
      assets: {
        model: asset('models/gte-small/model_quantized.onnx'),
        vocab: asset('models/gte-small/vocab.txt'),
      },
    });
  }

  private send(m: ToWorker) {
    this.worker?.postMessage(m);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Tell the index which days changed. Before `start()` this is a no-op: the first scan finds them. */
  noteChanged(dates: string[]) {
    this.send({ type: 'changed', dates });
  }

  /** Load the model now, ahead of the first query. */
  warm() {
    this.start();
    this.send({ type: 'warm' });
  }

  search(query: string): Promise<SearchResponse> {
    this.start();
    if (!this.worker) return Promise.reject(new Error('Search is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.send({ type: 'search', id, query });
    });
  }

  dispose() {
    this.disposed = true;
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.waiting.values()) w.reject(new Error('Search is closed'));
    this.waiting.clear();
  }
}

/** Delete every search index on this device (all repositories). Used on sign-out. */
export async function destroySearchData(): Promise<void> {
  const all = (await indexedDB.databases?.().catch(() => [])) ?? [];
  const names = all.map((d) => d.name).filter((n): n is string => !!n && n.startsWith(SEARCH_DB_PREFIX));
  await Promise.all(
    names.map(
      (name) =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          // If a worker still has it open, the delete goes through as soon as it lets go.
          req.onsuccess = req.onerror = req.onblocked = () => resolve();
        }),
    ),
  );
}
