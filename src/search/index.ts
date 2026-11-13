import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { chunkText, hashText } from './chunk';

/**
 * The on-device search index: every entry split into passages, each with an
 * embedding vector, in its own IndexedDB database. It is built from the
 * journal database and can always be rebuilt from it, so deleting it loses
 * nothing. Runs inside the search worker.
 */

export const SEARCH_DB_PREFIX = 'permajournal-search:';

export interface Embedder {
  /** A unit-length vector for the text. */
  embed(text: string): Promise<Float32Array>;
}

export interface SourceEntry {
  date: string;
  text: string;
}

/** Read access to the journal's entries. */
export interface EntrySource {
  /** Up to `limit` entries with dates after `after`, in date order. */
  batch(after: string | null, limit: number): Promise<SourceEntry[]>;
  get(date: string): Promise<string>;
}

interface StoredChunk {
  /** Passage text. */
  t: string;
  /** Hash of the text, so an edit only re-embeds the passages it touched. */
  h: number;
  /** Embedding scaled to int8, or null until the model has got to it. */
  v: Int8Array | null;
}

interface StoredDoc {
  date: string;
  hash: number;
  chunks: StoredChunk[];
}

interface Chunk extends StoredChunk {
  /** Lower-cased text for keyword matching; kept in memory only. */
  l: string;
}

interface Doc {
  date: string;
  hash: number;
  chunks: Chunk[];
}

interface Schema extends DBSchema {
  docs: { key: string; value: StoredDoc };
  meta: { key: string; value: unknown };
}

export type ModelState = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface SearchStatus {
  /** `scanning` until the index has been compared with the journal once. */
  phase: 'scanning' | 'indexing' | 'ready';
  /** Entries in the index. */
  entries: number;
  /** Entries whose passages all have vectors. */
  embedded: number;
  model: ModelState;
  error?: string;
}

export interface SearchHit {
  date: string;
  snippet: string;
  score: number;
  /** How the passage matched: by its words, by its meaning, or both. */
  match: 'words' | 'meaning' | 'both';
}

export interface SearchResponse {
  hits: SearchHit[];
  /** Query words to highlight in snippets. */
  terms: string[];
  /** Whether vectors were used for this answer. */
  semantic: boolean;
}

const SCAN_BATCH = 100;
const RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;
/**
 * A passage is "related" to a query when its similarity stands out from the
 * rest of the journal's (z-score) and clears the model's floor: gte-small
 * scores unrelated English text around 0.75–0.8.
 */
const MIN_SIMILARITY = 0.8;
const MIN_Z = 1.5;
/** Below this many passages the journal is too small for statistics. */
const MIN_FOR_STATS = 50;
/** Containing every query word is worth as much as standing out by this many deviations. */
const WORDS_WEIGHT = 2;
const PHRASE_WEIGHT = 1;
const SNIPPET_LENGTH = 220;

const STOPWORDS = new Set(
  'a an and are as at be but by did do for from had has have how i in is it me my of on or so that the their then there this to was we were what when where who why with you'.split(
    ' ',
  ),
);

/** Lets searches jump ahead of background indexing for the model. */
class Gate {
  private busy = false;
  private high: (() => void)[] = [];
  private low: (() => void)[] = [];

  async run<T>(priority: 'high' | 'low', fn: () => Promise<T>): Promise<T> {
    if (this.busy) await new Promise<void>((r) => (priority === 'high' ? this.high : this.low).push(r));
    this.busy = true;
    try {
      return await fn();
    } finally {
      const next = this.high.shift() ?? this.low.shift();
      if (next) next(); // hand the gate straight to the next waiter
      else this.busy = false;
    }
  }
}

export interface SearchIndexOptions {
  name: string;
  source: EntrySource;
  /** Identifies the model; the vectors are discarded when it changes. */
  modelId: string;
  /** Called the first time a vector is needed. */
  loadEmbedder: () => Promise<Embedder>;
  onStatus?: (s: SearchStatus) => void;
  /** First pause before retrying failed indexing; doubles each time. */
  retryMs?: number;
}

export class SearchIndex {
  private docs = new Map<string, Doc>();
  private dirty = new Set<string>();
  private pumping: Promise<void> | null = null;
  private scanned = false;
  private closed = false;
  private gate = new Gate();
  private embedder: Promise<Embedder> | null = null;
  private model: ModelState = 'idle';
  /** Why the model could not be loaded. */
  private error: string | undefined;
  /** Why the last indexing attempt failed; cleared when one succeeds. */
  private workError: string | undefined;
  private queryVectors = new Map<string, Float32Array>();
  private lastStatus = '';

  private constructor(
    private db: IDBPDatabase<Schema>,
    private opts: SearchIndexOptions,
  ) {}

  static async open(opts: SearchIndexOptions): Promise<SearchIndex> {
    let index: SearchIndex | null = null;
    const db = await openDB<Schema>(SEARCH_DB_PREFIX + opts.name, 1, {
      upgrade(db) {
        db.createObjectStore('docs', { keyPath: 'date' });
        db.createObjectStore('meta');
      },
      // Signing out deletes this database: let go of it straight away.
      blocking() {
        index?.close();
      },
    });
    index = new SearchIndex(db, opts);
    if ((await db.get('meta', 'model')) !== opts.modelId) {
      const tx = db.transaction(['docs', 'meta'], 'readwrite');
      await tx.objectStore('docs').clear();
      await tx.objectStore('meta').put(opts.modelId, 'model');
      await tx.done;
    }
    for (const d of await db.getAll('docs')) {
      index.docs.set(d.date, { ...d, chunks: d.chunks.map((c) => ({ ...c, l: c.t.toLowerCase() })) });
    }
    index.report();
    return index;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Compare the index with the journal and bring it up to date in the background. */
  start(): Promise<void> {
    return this.pump();
  }

  /** Entries that changed in the journal. */
  noteChanged(dates: string[]) {
    for (const d of dates) this.dirty.add(d);
    void this.pump();
  }

  /** Load the model ahead of the first query. */
  warm() {
    void this.getEmbedder().catch(() => {});
  }

  /** Resolves when background work has caught up. */
  async idle(): Promise<void> {
    while (this.pumping) await this.pumping;
  }

  get status(): SearchStatus {
    let embedded = 0;
    for (const d of this.docs.values()) if (d.chunks.every((c) => c.v)) embedded++;
    const pending = embedded < this.docs.size && this.model !== 'unavailable';
    return {
      phase: !this.scanned ? 'scanning' : pending || this.dirty.size ? 'indexing' : 'ready',
      entries: this.docs.size,
      embedded,
      model: this.model,
      ...(this.workError || this.error ? { error: this.workError ?? this.error } : {}),
    };
  }

  private report() {
    const s = this.status;
    const key = JSON.stringify(s);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.opts.onStatus?.(s);
  }

  private getEmbedder(): Promise<Embedder> {
    if (!this.embedder) {
      this.model = 'loading';
      this.report();
      this.embedder = this.opts.loadEmbedder().then(
        (e) => {
          this.model = 'ready';
          this.report();
          return e;
        },
        (err) => {
          this.model = 'unavailable';
          this.error = err instanceof Error ? err.message : String(err);
          this.report();
          throw err;
        },
      );
    }
    return this.embedder;
  }

  // ---- Indexing ----

  private pump(): Promise<void> {
    this.pumping ??= this.workWithRetries().finally(() => {
      this.pumping = null;
      if (!this.closed) this.report();
    });
    return this.pumping;
  }

  /**
   * A failed read, write or embed must not leave the index half-built for the
   * rest of the session: keep trying, with longer and longer pauses (five
   * minutes at most). Nothing is lost by a failure; the next attempt picks up
   * whatever is still missing.
   */
  private async workWithRetries() {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.work();
        this.workError = undefined;
        return;
      } catch (err) {
        if (this.closed) return;
        this.workError = err instanceof Error ? err.message : String(err);
        this.report();
        const pause = Math.min((this.opts.retryMs ?? RETRY_MS) * 2 ** Math.min(attempt, 10), MAX_RETRY_MS);
        await new Promise((r) => setTimeout(r, pause));
        if (this.closed) return;
      }
    }
  }

  private async work() {
    if (!this.scanned) {
      await this.scan();
      this.scanned = true;
      this.report();
    }
    for (;;) {
      if (this.closed) return;
      if (this.dirty.size) {
        for (const date of [...this.dirty]) {
          await this.refresh(date, await this.opts.source.get(date));
          this.dirty.delete(date);
        }
        this.report();
        continue;
      }
      const doc = this.nextUnembedded();
      if (!doc || this.model === 'unavailable') return;
      await this.embedDoc(doc);
      this.report();
    }
  }

  /** Walk the journal, re-chunking entries whose text changed and dropping ones that are gone. */
  private async scan() {
    const seen = new Set<string>();
    let after: string | null = null;
    for (;;) {
      const batch = await this.opts.source.batch(after, SCAN_BATCH);
      if (this.closed) return;
      for (const e of batch) {
        if (e.text.trim() !== '') seen.add(e.date);
        await this.refresh(e.date, e.text);
      }
      if (batch.length < SCAN_BATCH) break;
      after = batch[batch.length - 1].date;
    }
    for (const date of [...this.docs.keys()]) if (!seen.has(date)) await this.refresh(date, '');
  }

  /** Make the stored passages for a day match its text, keeping vectors of passages that didn't change. */
  private async refresh(date: string, text: string) {
    const old = this.docs.get(date);
    if (text.trim() === '') {
      if (old) {
        this.docs.delete(date);
        await this.db.delete('docs', date);
      }
      return;
    }
    const hash = hashText(text);
    if (old?.hash === hash) return;
    const known = new Map(old?.chunks.filter((c) => c.v).map((c) => [c.h, c.v]));
    const chunks: Chunk[] = chunkText(text).map((t) => {
      const h = hashText(t);
      return { t, h, v: known.get(h) ?? null, l: t.toLowerCase() };
    });
    const doc: Doc = { date, hash, chunks };
    this.docs.set(date, doc);
    await this.store(doc);
  }

  private store(doc: Doc) {
    return this.db.put('docs', { date: doc.date, hash: doc.hash, chunks: doc.chunks.map(({ t, h, v }) => ({ t, h, v })) });
  }

  /** Newest first: recent days are the ones most likely to be searched for. */
  private nextUnembedded(): Doc | undefined {
    let best: Doc | undefined;
    for (const d of this.docs.values()) {
      if ((!best || d.date > best.date) && d.chunks.some((c) => !c.v)) best = d;
    }
    return best;
  }

  private async embedDoc(doc: Doc) {
    let embedder: Embedder;
    try {
      embedder = await this.getEmbedder();
    } catch {
      return; // keyword search still works; `model` is now 'unavailable'
    }
    for (const chunk of doc.chunks) {
      if (chunk.v) continue;
      // One passage at a time, so a search never waits for more than one.
      const v = await this.gate.run('low', () => embedder.embed(chunk.t));
      if (this.closed) return;
      chunk.v = quantize(v);
    }
    // The entry may have been edited while we were embedding it.
    if (this.docs.get(doc.date) === doc) await this.store(doc);
  }

  // ---- Searching ----

  async search(query: string, limit = 40): Promise<SearchResponse> {
    const q = query.replace(/\s+/g, ' ').trim().toLowerCase();
    const terms = queryTerms(q);
    if (terms.length === 0) return { hits: [], terms, semantic: false };

    // Use vectors if the model is up; otherwise answer from keywords now and
    // let the caller ask again once it has loaded.
    let qv: Float32Array | null = null;
    if (this.model === 'ready') {
      qv = this.queryVectors.get(q) ?? null;
      if (!qv) {
        const embedder = await this.getEmbedder();
        qv = await this.gate.run('high', () => embedder.embed(q));
        if (this.queryVectors.size > 50) this.queryVectors.clear();
        this.queryVectors.set(q, qv);
      }
    } else if (this.model === 'idle') {
      this.warm();
    }

    // Similarity of every passage, and how they are spread for this query.
    const sims = new Map<Chunk, number>();
    let mean = 0;
    let deviation = 1;
    if (qv) {
      let sum = 0;
      let squares = 0;
      for (const doc of this.docs.values()) {
        for (const chunk of doc.chunks) {
          if (!chunk.v) continue;
          const s = dot(qv, chunk.v);
          sims.set(chunk, s);
          sum += s;
          squares += s * s;
        }
      }
      if (sims.size >= MIN_FOR_STATS) {
        mean = sum / sims.size;
        deviation = Math.max(0.01, Math.sqrt(squares / sims.size - mean * mean));
      } else {
        mean = MIN_SIMILARITY;
        deviation = 0.02;
      }
    }

    const hits: SearchHit[] = [];
    for (const doc of this.docs.values()) {
      let best: { chunk: Chunk; score: number; match: SearchHit['match'] } | null = null;
      for (const chunk of doc.chunks) {
        let matched = 0;
        for (const t of terms) if (chunk.l.includes(t)) matched++;
        const allWords = matched === terms.length;
        const phrase = terms.length > 1 && chunk.l.includes(q);
        const similarity = sims.get(chunk);
        const z = similarity === undefined ? 0 : (similarity - mean) / deviation;
        const related = similarity !== undefined && similarity >= MIN_SIMILARITY && (sims.size < MIN_FOR_STATS || z >= MIN_Z);
        if (!allWords && !related) continue;
        // Squared, so having only some of the words counts for little.
        const score = z + WORDS_WEIGHT * (matched / terms.length) ** 2 + (phrase ? PHRASE_WEIGHT : 0);
        if (!best || score > best.score) {
          best = { chunk, score, match: allWords ? (related ? 'both' : 'words') : 'meaning' };
        }
      }
      if (best) hits.push({ date: doc.date, snippet: snippet(best.chunk, terms), score: best.score, match: best.match });
    }
    hits.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
    return { hits: hits.slice(0, limit), terms, semantic: qv !== null };
  }
}

export function queryTerms(query: string): string[] {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  const meaningful = words.filter((w) => !STOPWORDS.has(w) && w.length > 1);
  return meaningful.length ? meaningful : words;
}

function quantize(v: Float32Array): Int8Array {
  const out = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127)));
  return out;
}

function dot(q: Float32Array, v: Int8Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += q[i] * v[i];
  return sum / 127;
}

/** The part of a passage around the first matching word. */
function snippet(chunk: Chunk, terms: string[]): string {
  const text = chunk.t.replace(/\n/g, ' ');
  if (text.length <= SNIPPET_LENGTH) return text;
  let first = -1;
  for (const t of terms) {
    const i = chunk.l.indexOf(t);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  let start = Math.max(0, first - 60);
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space >= 0 && space < first) start = space + 1;
  }
  let end = Math.min(text.length, start + SNIPPET_LENGTH);
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space > start + SNIPPET_LENGTH / 2) end = space;
  }
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}
