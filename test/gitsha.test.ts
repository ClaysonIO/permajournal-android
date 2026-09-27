import { execSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { gitBlobSha } from '../src/lib/gitsha';

it('matches git hash-object', async () => {
  for (const text of ['', 'hello\n', 'Unicode — café ☕\n']) {
    const expected = execSync('git hash-object --stdin', { input: text }).toString().trim();
    expect(await gitBlobSha(text)).toBe(expected);
  }
});
