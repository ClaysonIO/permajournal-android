import * as ort from 'onnxruntime-web/wasm';
import { WordPiece } from './tokenizer';
import type { Embedder } from './index';

/**
 * gte-small (8-bit quantized, 384 dimensions) on ONNX Runtime's WebAssembly backend.
 * The model, its vocabulary and the runtime (bundled by Vite) all ship inside the app; nothing
 * is fetched from the network. Only ever imported from the search worker.
 */
export interface ModelFiles {
  model: string | Uint8Array;
  vocab: string;
}

export async function loadEmbedder(files: ModelFiles): Promise<Embedder> {
  // One thread: the WebView isn't cross-origin isolated, and a single
  // background thread is all we want to take from the device anyway.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;

  const tokenizer = new WordPiece(files.vocab);
  const session = await ort.InferenceSession.create(files.model as string, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  const wantsTypes = session.inputNames.includes('token_type_ids');

  return {
    async embed(text: string): Promise<Float32Array> {
      const ids = tokenizer.encode(text);
      const n = ids.length;
      const dims = [1, n];
      const feeds: Record<string, ort.Tensor> = {
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), dims),
        attention_mask: new ort.Tensor('int64', new BigInt64Array(n).fill(1n), dims),
      };
      if (wantsTypes) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(n), dims);
      const result = await session.run(feeds);
      const hidden = result[session.outputNames[0]];
      const data = hidden.data as Float32Array;
      const width = hidden.dims[2];

      // Mean-pool the token vectors, then scale to unit length.
      const out = new Float32Array(width);
      for (let t = 0; t < n; t++) {
        const row = t * width;
        for (let i = 0; i < width; i++) out[i] += data[row + i];
      }
      let norm = 0;
      for (let i = 0; i < width; i++) norm += out[i] * out[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < width; i++) out[i] /= norm;
      return out;
    },
  };
}
