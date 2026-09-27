import { describe, expect, it } from 'vitest';
import { mergeText } from '../src/lib/merge';

describe('mergeText', () => {
  it('takes the side that changed', () => {
    expect(mergeText('a\n', 'a\n', 'a\nb\n')).toBe('a\nb\n');
    expect(mergeText('a\n', 'a\nb\n', 'a\n')).toBe('a\nb\n');
  });

  it('merges edits to different paragraphs', () => {
    const base = 'Morning.\n\nAfternoon.\n\nEvening.\n';
    const local = 'Morning coffee.\n\nAfternoon.\n\nEvening.\n';
    const remote = 'Morning.\n\nAfternoon.\n\nEvening walk.\n';
    expect(mergeText(base, local, remote)).toBe('Morning coffee.\n\nAfternoon.\n\nEvening walk.\n');
  });

  it('merges edits to different words of the same paragraph', () => {
    const base = 'I went to the store and bought milk.';
    const local = 'I drove to the store and bought milk.';
    const remote = 'I went to the store and bought bread.';
    expect(mergeText(base, local, remote)).toBe('I drove to the store and bought bread.');
  });

  it('keeps both versions when edits truly collide', () => {
    const base = 'Today was fine.';
    const local = 'Today was great.';
    const remote = 'Today was awful.';
    const merged = mergeText(base, local, remote);
    expect(merged).toContain('Today was great.');
    expect(merged).toContain('Today was awful.');
  });

  it('keeps both appends to the end of an entry', () => {
    const base = 'Line one.\n';
    const merged = mergeText(base, 'Line one.\nFrom phone.\n', 'Line one.\nFrom laptop.\n');
    expect(merged.startsWith('Line one.\n')).toBe(true);
    expect(merged).toContain('From phone.');
    expect(merged).toContain('From laptop.');
    expect(merged.match(/Line one\./g)).toHaveLength(1);
  });

  it('combines entries written independently', () => {
    expect(mergeText(null, 'phone', 'laptop')).toBe('laptop\n\nphone');
    expect(mergeText(null, 'hello', 'hello world')).toBe('hello world');
    expect(mergeText(null, '', 'remote')).toBe('remote');
    expect(mergeText(null, 'Shared.\n\nPhone.\n', 'Laptop.\n\nShared.\n')).toBe('Laptop.\n\nShared.\n\nPhone.\n');
  });

  it('never loses text on random edits', () => {
    const words = 'the quick brown fox jumps over lazy dog and cat'.split(' ');
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
    const edit = (s: string) => {
      const parts = s.split(' ');
      parts.splice(rand(parts.length + 1), rand(2), words[rand(words.length)] + rand(100));
      return parts.join(' ');
    };
    for (let i = 0; i < 300; i++) {
      const base = Array.from({ length: 12 }, () => words[rand(words.length)]).join(' ');
      const local = edit(base);
      const remote = edit(base);
      const merged = mergeText(base, local, remote);
      for (const w of [...local.split(' '), ...remote.split(' ')].filter((w) => /\d/.test(w))) {
        expect(merged).toContain(w);
      }
    }
  });
});
