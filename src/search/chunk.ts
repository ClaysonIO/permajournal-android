/**
 * Split an entry into passages for the embedding model. A day often covers
 * several unrelated things, and a vector for one topic matches a query far
 * better than a vector for three, so passages are kept small: a paragraph
 * each, with very short ones (headings, one-liners) joined to their
 * neighbour and long ones split at sentence ends.
 */
export const MAX_CHUNK = 400;
const MIN_CHUNK = 40;

export function chunkText(text: string, max = MAX_CHUNK): string[] {
  const paragraphs = text
    .replace(/&#x20;/g, ' ')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const out: string[] = [];
  let current = '';
  const flush = () => {
    if (current) out.push(current);
    current = '';
  };
  for (const p of paragraphs) {
    for (const piece of p.length > max ? splitLong(p, max) : [p]) {
      // A heading or one-liner stays with what follows it; anything longer stands alone.
      if (current.length >= MIN_CHUNK || current.length + 1 + piece.length > max) flush();
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  flush();
  return out;
}

function splitLong(p: string, max: number): string[] {
  const sentences = p.match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) ?? [p];
  const out: string[] = [];
  let current = '';
  for (let s of sentences) {
    // A single sentence longer than the limit is cut at word boundaries.
    while (s.length > max) {
      if (current) {
        out.push(current.trim());
        current = '';
      }
      let cut = s.lastIndexOf(' ', max);
      if (cut < max / 2) cut = max;
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut);
    }
    if (current.length + s.length > max) {
      out.push(current.trim());
      current = '';
    }
    current += s;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Fast 53-bit string hash (cyrb53); used to notice changed text, not for security. */
export function hashText(s: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
