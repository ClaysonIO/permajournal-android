import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { JournalDb } from '../src/lib/db';
import { chunkText, hashText, MAX_CHUNK } from '../src/search/chunk';
import { SearchIndex, SEARCH_DB_PREFIX, queryTerms, type Embedder, type SearchStatus } from '../src/search/index';
import { journalSource } from '../src/search/source';
import { WordPiece } from '../src/search/tokenizer';

/** Toy embedder: a few "topics", each a list of words that mean the same thing. */
const TOPICS = [
  ['beach', 'sea', 'ocean', 'waves', 'swim', 'swimming', 'coast'],
  ['work', 'office', 'meeting', 'boss', 'deadline', 'job'],
  ['dog', 'puppy', 'walk', 'vet'],
];
function fakeEmbedder() {
  const calls: string[] = [];
  const embedder: Embedder = {
    async embed(text) {
      calls.push(text);
      const v = new Float32Array(TOPICS.length + 1);
      for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
        const i = TOPICS.findIndex((t) => t.includes(w));
        if (i >= 0) v[i] += 1;
      }
      v[TOPICS.length] = 0.01;
      const norm = Math.hypot(...v);
      return v.map((x) => x / norm);
    },
  };
  return { embedder, calls };
}

let n = 0;
async function setup(entries: Record<string, string>, load?: () => Promise<Embedder>) {
  const name = `search-${n++}`;
  const db = await JournalDb.open(name);
  for (const [date, text] of Object.entries(entries)) await db.saveLocal(date, text);
  const fake = fakeEmbedder();
  const statuses: SearchStatus[] = [];
  const open = () =>
    SearchIndex.open({
      name,
      source: journalSource(name),
      modelId: 'fake',
      loadEmbedder: load ?? (async () => fake.embedder),
      onStatus: (s) => statuses.push(s),
    });
  const index = await open();
  return { name, db, index, open, statuses, ...fake };
}

describe('chunkText', () => {
  it('keeps short entries whole and joins short paragraphs', () => {
    expect(chunkText('One line.')).toEqual(['One line.']);
    expect(chunkText('# Monday\n\nShort one.\n\nAnother.')).toEqual(['# Monday\nShort one.\nAnother.']);
    expect(chunkText('  \n\n ')).toEqual([]);
  });

  it('splits long text at sentence ends without losing words', () => {
    const sentence = 'The quick brown fox jumps over the lazy dog near the river bank. ';
    const text = `${sentence.repeat(30)}\n\n${sentence.repeat(30)}`;
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK);
      expect(c.endsWith('bank.')).toBe(true);
    }
    expect(chunks.join(' ').split(/\s+/).length).toBe(text.trim().split(/\s+/).length);
  });

  it('cuts a sentence that is longer than a chunk', () => {
    const chunks = chunkText('word '.repeat(500));
    expect(chunks.every((c) => c.length <= MAX_CHUNK)).toBe(true);
    expect(chunks.join(' ').split(' ').length).toBe(500);
  });

  it('hashes text stably', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
  });
});

describe('WordPiece', () => {
  const vocab = ['[PAD]', '[UNK]', '[CLS]', '[SEP]', 'walk', '##ing', '##ed', 'cafe', 'the', ',', '!', 'un', '##walk'].join('\n');
  const tok = new WordPiece(vocab);
  it('lowercases, strips accents, splits punctuation and word pieces', () => {
    expect(tok.encode('Walking, the Café!')).toEqual([2, 4, 5, 9, 8, 7, 10, 3]);
    expect(tok.encode('unwalked zebra')).toEqual([2, 11, 12, 6, 1, 3]);
  });
  it('truncates to the model limit, keeping [SEP]', () => {
    const ids = tok.encode('the '.repeat(50), 8);
    expect(ids).toHaveLength(8);
    expect(ids.at(-1)).toBe(3);
  });
});

describe('SearchIndex', () => {
  const entries = {
    '2026-08-01': 'Spent the day at the beach. The waves were huge.',
    '2026-08-02': 'Long meeting at the office about the deadline.',
    '2026-08-03': 'Took the puppy to the vet. Rain all afternoon.',
  };

  it('indexes the journal and finds entries by meaning and by words', async () => {
    const { index, statuses } = await setup(entries);
    await index.start();
    expect(index.status).toMatchObject({ phase: 'ready', entries: 3, embedded: 3, model: 'ready' });
    expect(statuses[0].phase).toBe('scanning');

    // No word in common with the entry: found through the vectors.
    const sea = await index.search('swimming in the ocean');
    expect(sea.semantic).toBe(true);
    expect(sea.hits.map((h) => h.date)).toEqual(['2026-08-01']);
    expect(sea.hits[0].match).toBe('meaning');

    // A word the toy model knows nothing about: found as a keyword.
    const rain = await index.search('rain');
    expect(rain.hits.map((h) => h.date)).toEqual(['2026-08-03']);
    expect(rain.hits[0].match).toBe('words');
    expect(rain.terms).toEqual(['rain']);

    expect((await index.search('zzz')).hits).toEqual([]);
    expect((await index.search('  ')).hits).toEqual([]);
  });

  it('answers from keywords before the model has loaded, then with vectors', async () => {
    let release!: (e: Embedder) => void;
    const gate = new Promise<Embedder>((r) => (release = r));
    const { index, embedder } = await setup(entries, () => gate);
    const done = index.start();
    while (index.status.phase === 'scanning') await new Promise((r) => setTimeout(r, 1));
    const early = await index.search('ocean beach');
    expect(early.semantic).toBe(false);
    expect(early.hits).toEqual([]); // "ocean" isn't written anywhere
    expect((await index.search('beach')).hits.map((h) => h.date)).toEqual(['2026-08-01']);
    release(embedder);
    await done;
    expect((await index.search('ocean beach')).hits[0].date).toBe('2026-08-01');
  });

  it('keeps working by keywords when the model cannot be loaded', async () => {
    const { index } = await setup(entries, async () => {
      throw new Error('no model');
    });
    await index.start();
    expect(index.status).toMatchObject({ phase: 'ready', embedded: 0, model: 'unavailable', error: 'no model' });
    expect((await index.search('deadline')).hits.map((h) => h.date)).toEqual(['2026-08-02']);
  });

  it('recovers when reading the journal or embedding fails', async () => {
    const name = `search-${n++}`;
    const db = await JournalDb.open(name);
    for (const [date, text] of Object.entries(entries)) await db.saveLocal(date, text);
    const real = journalSource(name);
    const { embedder } = fakeEmbedder();
    let readFailures = 1;
    let embedFailures = 1;
    const statuses: SearchStatus[] = [];
    const index = await SearchIndex.open({
      name,
      modelId: 'fake',
      retryMs: 1,
      source: {
        get: (d) => real.get(d),
        batch: async (after, limit) => {
          if (readFailures-- > 0) throw new Error('read failed');
          return real.batch(after, limit);
        },
      },
      loadEmbedder: async () => ({
        embed: async (t) => {
          if (embedFailures-- > 0) throw new Error('embed failed');
          return embedder.embed(t);
        },
      }),
      onStatus: (s) => statuses.push(s),
    });
    await index.start();
    expect(statuses.map((s) => s.error)).toEqual(expect.arrayContaining(['read failed', 'embed failed']));
    expect(index.status).toMatchObject({ phase: 'ready', entries: 3, embedded: 3 });
    expect(index.status.error).toBeUndefined();
  });

  it('re-embeds only the passages that changed', async () => {
    const para = (topic: string) => `${`All about the ${topic} today. `.repeat(10)}`.trim();
    const { db, index, calls } = await setup({ '2026-08-01': `${para('beach')}\n\n${para('office')}` });
    await index.start();
    expect(calls).toHaveLength(2);

    await db.saveLocal('2026-08-01', `${para('beach')}\n\n${para('puppy')}`);
    index.noteChanged(['2026-08-01']);
    await index.idle();
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain('puppy');
    expect((await index.search('office')).hits).toEqual([]);
    expect((await index.search('vet')).hits.map((h) => h.date)).toEqual(['2026-08-01']);
  });

  it('persists vectors and catches up with changes made while it was closed', async () => {
    const first = await setup(entries);
    await first.index.start();
    first.index.close();
    const before = first.calls.length;

    await first.db.saveLocal('2026-08-02', ''); // deleted
    await first.db.saveLocal('2026-08-04', 'Walked along the coast.');
    const index = await first.open();
    expect(index.status.entries).toBe(3);
    await index.start();
    expect(first.calls.length).toBe(before + 1); // only the new day
    expect(index.status).toMatchObject({ entries: 3, embedded: 3 });
    expect((await index.search('deadline')).hits).toEqual([]);
    expect((await index.search('sea')).hits.map((h) => h.date).sort()).toEqual(['2026-08-01', '2026-08-04']);
  });

  it('lets a search go ahead of background indexing', async () => {
    const many: Record<string, string> = {};
    for (let i = 1; i <= 20; i++) many[`2026-07-${String(i).padStart(2, '0')}`] = `Day ${i} at the office.`;
    const { index, calls } = await setup(many);
    const done = index.start();
    while (index.status.model !== 'ready') await new Promise((r) => setTimeout(r, 1));
    await index.search('beach');
    expect(calls.indexOf('beach')).toBeLessThan(19);
    await done;
    expect(index.status.embedded).toBe(20);
  });

  it('is removed by deleting its database, without touching the journal', async () => {
    const { name, db, index } = await setup(entries);
    await index.start();
    // Deleting while it is still open (as on sign-out) makes it let go.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(SEARCH_DB_PREFIX + name);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    const names = (await indexedDB.databases()).map((d) => d.name);
    expect(names).not.toContain(SEARCH_DB_PREFIX + name);
    expect(await db.getText('2026-08-01')).toContain('beach');
  });

  it('does not create a journal database that is not there', async () => {
    await expect(journalSource('missing').get('2026-01-01')).rejects.toBeTruthy();
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain('permajournal:missing');
  });

  it('ignores filler words in queries', () => {
    expect(queryTerms('What did I do at the Beach?')).toEqual(['beach']);
    expect(queryTerms('the')).toEqual(['the']);
  });
});
