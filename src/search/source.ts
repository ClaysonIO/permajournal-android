import type { EntrySource, SourceEntry } from './index';

/**
 * Reads entries straight from the journal's IndexedDB database, so indexing
 * costs the UI thread nothing. Read-only, in short transactions; it never
 * creates or upgrades the database, and lets go of it if the app needs to.
 */
export function journalSource(name: string): EntrySource & { close(): void } {
  let opening: Promise<IDBDatabase> | null = null;
  let current: IDBDatabase | null = null;

  const open = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(`permajournal:${name}`);
      // The app owns the schema. If the database isn't there, don't make one.
      req.onupgradeneeded = () => req.transaction?.abort();
      req.onerror = () => {
        opening = null;
        reject(req.error ?? new Error('Journal database is not available'));
      };
      req.onsuccess = () => {
        const db = req.result;
        current = db;
        db.onversionchange = () => {
          db.close();
          opening = current = null;
        };
        resolve(db);
      };
    }));

  const request = async <T>(run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const req = run(db.transaction('entries', 'readonly').objectStore('entries'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };

  return {
    async batch(after, limit) {
      const range = after === null ? null : IDBKeyRange.lowerBound(after, true);
      const rows = await request<SourceEntry[]>((s) => s.getAll(range, limit));
      return rows.map((r) => ({ date: r.date, text: r.text }));
    },
    async get(date) {
      return (await request<SourceEntry | undefined>((s) => s.get(date)))?.text ?? '';
    },
    close() {
      current?.close();
      opening = current = null;
    },
  };
}
