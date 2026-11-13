// Puts the embedding model for on-device search (gte-small, 8-bit, MIT licence) into public/, so it ships
// inside the app. Downloaded once and checksum-verified; runs before every
// build and dev server start and does nothing when the files are already there.
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REVISION = '5927d1727bb12db490052a1b33265ad78058de08';
const BASE = `https://huggingface.co/Xenova/gte-small/resolve/${REVISION}`;
const MODEL_DIR = join(root, 'public/models/gte-small');

const downloads = [
  {
    url: `${BASE}/onnx/model_quantized.onnx`,
    to: join(MODEL_DIR, 'model_quantized.onnx'),
    sha256: '18dec105109b6004369799ca4761fb8fb413c64172c02147bcfac186b5c5f6cb',
  },
  {
    url: `${BASE}/vocab.txt`,
    to: join(MODEL_DIR, 'vocab.txt'),
    sha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
  },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const exists = (p) => stat(p).then(() => true, () => false);

for (const f of downloads) {
  if ((await exists(f.to)) && sha256(await readFile(f.to)) === f.sha256) continue;
  console.log(`Downloading ${f.url}`);
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== f.sha256) throw new Error(`${f.url}: checksum mismatch`);
  await mkdir(dirname(f.to), { recursive: true });
  await writeFile(f.to, buf);
}
