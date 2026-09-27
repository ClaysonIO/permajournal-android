import { diff3Merge, diffComm } from 'node-diff3';

/**
 * Merge two versions of a journal entry without ever losing text.
 *
 * `base` is the last version both sides agreed on (null when the entry was
 * created independently on both sides). Non-overlapping edits merge like git
 * would; overlapping edits are retried word-by-word, and if they still collide
 * both versions are kept (remote first, then local).
 */
export function mergeText(base: string | null, local: string, remote: string): string {
  if (local === remote) return local;
  if (base === null) return mergeUnrelated(local, remote);
  if (local === base) return remote;
  if (remote === base) return local;

  const regions = diff3Merge(splitLines(local), splitLines(base), splitLines(remote), {
    excludeFalseConflicts: true,
  });
  let out = '';
  for (const region of regions) {
    if (region.ok) {
      out += region.ok.join('');
    } else if (region.conflict) {
      const { a, o, b } = region.conflict;
      out += resolveConflict(a.join(''), o.join(''), b.join(''));
    }
  }
  return out;
}

function resolveConflict(local: string, base: string, remote: string): string {
  // Try again at word granularity; edits to different words of the same
  // paragraph (the common case for prose) merge cleanly this way.
  const regions = diff3Merge(splitWords(local), splitWords(base), splitWords(remote), {
    excludeFalseConflicts: true,
  });
  if (regions.every((r) => r.ok)) {
    return regions.map((r) => r.ok!.join('')).join('');
  }
  return keepBoth(local, remote);
}

function mergeUnrelated(local: string, remote: string): string {
  if (local.trim() === '') return remote;
  if (remote.trim() === '') return local;
  if (remote.includes(local)) return remote;
  if (local.includes(remote)) return local;
  // No shared ancestor: treat the lines both sides have in common as the base,
  // so each side's additions are kept once and shared text isn't duplicated.
  // Blank lines are left out so paragraph breaks can't hijack the alignment.
  const content = (t: string) => splitLines(t).filter((l) => l.trim() !== '');
  const common = diffComm(content(local), content(remote))
    .map((c) => c.common?.join('') ?? '')
    .join('');
  return common.trim() === '' ? keepBoth(local, remote) : mergeText(common, local, remote);
}

function keepBoth(local: string, remote: string): string {
  if (remote.includes(local)) return remote;
  if (local.includes(remote)) return local;
  const trailing = remote.match(/\n*$/)![0];
  const joined = remote.replace(/\n*$/, '') + '\n\n' + local.replace(/^\n*/, '');
  // Preserve the chunk's original line ending so following text isn't glued on.
  return trailing && !joined.endsWith('\n') ? joined + trailing : joined;
}

/** Lines including their terminating newline, so joining restores the text exactly. */
function splitLines(text: string): string[] {
  return text === '' ? [] : text.split(/(?<=\n)/);
}

function splitWords(text: string): string[] {
  return text === '' ? [] : text.split(/(\s+)/).filter((t) => t !== '');
}
