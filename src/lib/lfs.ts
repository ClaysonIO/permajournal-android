import { GitHubError } from './github';
import type { HttpFn } from './http';

/**
 * Git LFS over the batch API (https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md).
 * The repository only stores small pointer files; the bytes live in LFS storage.
 */
export interface LfsPointer {
  oid: string;
  size: number;
}

export interface LfsPort {
  upload(objects: (LfsPointer & { bytes: () => Promise<Uint8Array> })[]): Promise<void>;
  download(pointer: LfsPointer): Promise<Uint8Array>;
}

export function formatPointer(p: LfsPointer): string {
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${p.oid}\nsize ${p.size}\n`;
}

export function parsePointer(text: string | null | undefined): LfsPointer | null {
  if (!text || !text.startsWith('version https://git-lfs.github.com/spec/')) return null;
  const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1];
  const size = /^size (\d+)$/m.exec(text)?.[1];
  return oid && size ? { oid, size: Number(size) } : null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Make sure `.gitattributes` routes `*.ext` through LFS, so desktop git clones get real files. */
export function ensureLfsRule(gitattributes: string | null, ext: string): string | null {
  const text = gitattributes ?? '';
  const rule = new RegExp(`^\\*\\.${ext}\\s.*filter=lfs`, 'im');
  if (rule.test(text)) return null;
  return (text && !text.endsWith('\n') ? text + '\n' : text) + `*.${ext} filter=lfs diff=lfs merge=lfs -text\n`;
}

interface BatchAction {
  href: string;
  header?: Record<string, string>;
}
interface BatchObject extends LfsPointer {
  actions?: { upload?: BatchAction; download?: BatchAction; verify?: BatchAction };
  error?: { code: number; message: string };
}

export class LfsClient implements LfsPort {
  private auth: string;

  constructor(
    private http: HttpFn,
    private fullName: string,
    login: string,
    token: string,
  ) {
    this.auth = `Basic ${btoa(`${login}:${token}`)}`;
  }

  private async batch(operation: 'upload' | 'download', objects: LfsPointer[]): Promise<BatchObject[]> {
    const res = await this.http({
      method: 'POST',
      url: `https://github.com/${this.fullName}.git/info/lfs/objects/batch`,
      headers: {
        Accept: 'application/vnd.git-lfs+json',
        'Content-Type': 'application/vnd.git-lfs+json',
        Authorization: this.auth,
      },
      text: JSON.stringify({
        operation,
        transfers: ['basic'],
        objects: objects.map(({ oid, size }) => ({ oid, size })),
      }),
    });
    if (res.status >= 300) throw new GitHubError(`Git LFS: ${lfsMessage(res.text) ?? res.status}`, res.status);
    return (JSON.parse(res.text) as { objects: BatchObject[] }).objects;
  }

  async upload(objects: (LfsPointer & { bytes: () => Promise<Uint8Array> })[]): Promise<void> {
    if (objects.length === 0) return;
    const results = await this.batch('upload', objects);
    for (const r of results) {
      if (r.error) throw new GitHubError(`Git LFS: ${r.error.message}`, r.error.code);
      const upload = r.actions?.upload;
      if (!upload) continue; // already stored
      const obj = objects.find((o) => o.oid === r.oid)!;
      const put = await this.http({
        method: 'PUT',
        url: upload.href,
        headers: { 'Content-Type': 'application/octet-stream', ...upload.header },
        bytes: await obj.bytes(),
      });
      if (put.status >= 300) throw new GitHubError(`Git LFS upload failed (${put.status})`, put.status);
      const verify = r.actions?.verify;
      if (verify) {
        const v = await this.http({
          method: 'POST',
          url: verify.href,
          headers: { 'Content-Type': 'application/vnd.git-lfs+json', ...verify.header },
          text: JSON.stringify({ oid: r.oid, size: r.size }),
        });
        if (v.status >= 300) throw new GitHubError(`Git LFS verify failed (${v.status})`, v.status);
      }
    }
  }

  async download(pointer: LfsPointer): Promise<Uint8Array> {
    const [r] = await this.batch('download', [pointer]);
    if (r.error) throw new GitHubError(`Git LFS: ${r.error.message}`, r.error.code);
    const action = r.actions?.download;
    if (!action) throw new GitHubError('Git LFS: no download link', 404);
    const res = await this.http({ method: 'GET', url: action.href, headers: action.header, binary: true });
    if (!res.bytes) throw new GitHubError(`Git LFS download failed (${res.status})`, res.status);
    return res.bytes;
  }
}

function lfsMessage(text: string): string | undefined {
  try {
    return (JSON.parse(text) as { message?: string }).message;
  } catch {
    return undefined;
  }
}
