/// <reference lib="webworker" />
import { SearchIndex } from './index';
import { journalSource } from './source';
import type { FromWorker, ToWorker } from './protocol';

/**
 * Background thread that owns the search index. Typing only ever posts a
 * date here; reading entries, running the model and scoring all happen off
 * the UI thread.
 */

/** Wait for a pause in typing before re-indexing the day being written. */
const CHANGE_DEBOUNCE_MS = 8_000;
const MODEL_ID = 'gte-small-q8';

const post = (m: FromWorker) => self.postMessage(m);
let index: Promise<SearchIndex> | null = null;
const changed = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      const { assets } = m;
      index = SearchIndex.open({
        name: m.repo,
        source: journalSource(m.repo),
        modelId: MODEL_ID,
        // The runtime is a separate chunk, loaded only once a vector is needed.
        loadEmbedder: async () => {
          const [{ loadEmbedder }, vocab] = await Promise.all([
            import('./embedder'),
            fetch(assets.vocab).then((r) => {
              if (!r.ok) throw new Error('The search model is not included in this build');
              return r.text();
            }),
          ]);
          return loadEmbedder({ model: assets.model, vocab });
        },
        onStatus: (status) => post({ type: 'status', status }),
      });
      void index.then((i) => i.start());
      break;
    }
    case 'changed':
      for (const d of m.dates) changed.add(d);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const dates = [...changed];
        changed.clear();
        void index?.then((i) => i.noteChanged(dates));
      }, CHANGE_DEBOUNCE_MS);
      break;
    case 'warm':
      void index?.then((i) => i.warm());
      break;
    case 'search':
      void index
        ?.then((i) => i.search(m.query))
        .then(
          (response) => post({ type: 'results', id: m.id, response }),
          (err) => post({ type: 'failed', id: m.id, error: err instanceof Error ? err.message : String(err) }),
        );
      break;
  }
};
