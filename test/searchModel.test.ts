import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadEmbedder } from '../src/search/embedder';
import { WordPiece } from '../src/search/tokenizer';

/** Runs the real model. Needs `npm run search:assets` first; skipped otherwise. */
const dir = 'public/models/gte-small';
const present = existsSync(`${dir}/model_quantized.onnx`);

describe.skipIf(!present)('embedding model', () => {
  it('tokenizes like the reference tokenizer', () => {
    const tok = new WordPiece(readFileSync(`${dir}/vocab.txt`, 'utf8'));
    // Ids produced by the Hugging Face tokenizer for this model.
    const cases: { text: string; ids: number[] }[] = JSON.parse(readFileSync('test/fixtures/tokenizer.json', 'utf8'));
    for (const c of cases) expect(tok.encode(c.text), c.text).toEqual(c.ids);
  });

  it('puts related sentences closer together than unrelated ones', async () => {
    const e = await loadEmbedder({
      model: new Uint8Array(readFileSync(`${dir}/model_quantized.onnx`)),
      vocab: readFileSync(`${dir}/vocab.txt`, 'utf8'),
    });
    const cos = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);
    const q = await e.embed('a walk by the sea');
    const beach = await e.embed('We strolled along the beach at sunset and watched the waves.');
    const taxes = await e.embed('Spent the evening filling in tax forms and sorting receipts.');
    expect(q).toHaveLength(384);
    expect(cos(q, q)).toBeCloseTo(1, 4);
    expect(cos(q, beach)).toBeGreaterThan(0.83);
    expect(cos(q, taxes)).toBeLessThan(0.78);
  }, 30_000);
});
