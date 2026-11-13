/**
 * BERT WordPiece tokenizer (uncased), matching the one the embedding
 * model was trained with: lowercase, strip accents, split on whitespace and
 * punctuation, then greedy longest-match against the vocabulary.
 */
export class WordPiece {
  private ids = new Map<string, number>();
  private cls: number;
  private sep: number;
  private unk: number;

  constructor(vocab: string) {
    vocab.split('\n').forEach((line, i) => {
      const token = line.replace(/\r$/, '');
      if (token) this.ids.set(token, i);
    });
    this.cls = this.need('[CLS]');
    this.sep = this.need('[SEP]');
    this.unk = this.need('[UNK]');
  }

  private need(token: string): number {
    const id = this.ids.get(token);
    if (id === undefined) throw new Error(`Vocabulary has no ${token}`);
    return id;
  }

  /** Token ids including [CLS] and [SEP], truncated to `maxLength`. */
  encode(text: string, maxLength = 512): number[] {
    const out = [this.cls];
    const limit = maxLength - 1;
    for (const word of basicTokens(text)) {
      if (out.length >= limit) break;
      for (const id of this.pieces(word)) {
        if (out.length >= limit) break;
        out.push(id);
      }
    }
    out.push(this.sep);
    return out;
  }

  private pieces(word: string): number[] {
    const chars = Array.from(word);
    if (chars.length > 100) return [this.unk];
    const out: number[] = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (end > start) {
        const piece = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
        found = this.ids.get(piece);
        if (found !== undefined) break;
        end--;
      }
      if (found === undefined) return [this.unk];
      out.push(found);
      start = end;
    }
    return out;
  }
}

const PUNCT = /\p{P}/u;
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const CJK = /[一-鿿㐀-䶿豈-﫿\u{20000}-\u{2a6df}\u{2a700}-\u{2ceaf}\u{2f800}-\u{2fa1f}]/u;

function basicTokens(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    // Control and format characters are dropped; replacement characters too.
    .replace(/[\0�]|(?![\t\n\r])[\p{Cc}\p{Cf}]/gu, '');
  const out: string[] = [];
  let word = '';
  const push = () => {
    if (word) out.push(word);
    word = '';
  };
  for (const ch of cleaned) {
    if (/\s/.test(ch)) push();
    else if (ASCII_PUNCT.test(ch) || PUNCT.test(ch) || CJK.test(ch)) {
      push();
      out.push(ch);
    } else word += ch;
  }
  push();
  return out;
}
