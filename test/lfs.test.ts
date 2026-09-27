import { expect, it } from 'vitest';
import type { HttpRequest } from '../src/lib/http';
import { LfsClient } from '../src/lib/lfs';

it('speaks the LFS batch protocol: batch → PUT → verify, then batch → GET', async () => {
  const calls: HttpRequest[] = [];
  const stored = new Map<string, Uint8Array>();
  const http = async (req: HttpRequest) => {
    calls.push(req);
    if (req.url.endsWith('/info/lfs/objects/batch')) {
      const body = JSON.parse(req.text!);
      const objects = body.objects.map((o: { oid: string; size: number }) => ({
        ...o,
        actions:
          body.operation === 'upload'
            ? stored.has(o.oid)
              ? undefined
              : { upload: { href: `https://storage/${o.oid}`, header: { 'X-Sig': '1' } }, verify: { href: 'https://github.com/verify' } }
            : { download: { href: `https://storage/${o.oid}` } },
      }));
      return { status: 200, text: JSON.stringify({ objects }), bytes: null };
    }
    if (req.method === 'PUT') {
      stored.set(req.url.split('/').pop()!, req.bytes!);
      return { status: 200, text: '', bytes: null };
    }
    if (req.url.endsWith('/verify')) return { status: 200, text: '', bytes: null };
    return { status: 200, text: '', bytes: stored.get(req.url.split('/').pop()!)! };
  };

  const lfs = new LfsClient(http, 'me/journal', 'me', 'tok');
  const obj = { oid: 'f'.repeat(64), size: 3, bytes: async () => new Uint8Array([1, 2, 3]) };
  await lfs.upload([obj]);
  expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    'POST https://github.com/me/journal.git/info/lfs/objects/batch',
    `PUT https://storage/${obj.oid}`,
    'POST https://github.com/verify',
  ]);
  expect(calls[0].headers!.Authorization).toBe(`Basic ${btoa('me:tok')}`);
  expect(calls[1].headers!['X-Sig']).toBe('1');

  calls.length = 0;
  await lfs.upload([obj]); // already stored → batch only
  expect(calls).toHaveLength(1);

  expect(await lfs.download(obj)).toEqual(new Uint8Array([1, 2, 3]));
});
