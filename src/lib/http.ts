import { Capacitor, CapacitorHttp } from '@capacitor/core';

/**
 * HTTP for hosts that don't allow browser CORS (github.com's LFS endpoint and
 * the LFS storage host). On Android it goes through native HTTP; in the
 * browser dev server github.com is reached through the Vite proxy.
 */
export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** Sent verbatim (e.g. pre-serialised JSON). */
  text?: string;
  /** Raw bytes to upload. */
  bytes?: Uint8Array;
  /** Return the body as bytes instead of text. */
  binary?: boolean;
}

export interface HttpResponse {
  status: number;
  text: string;
  bytes: Uint8Array | null;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const http: HttpFn = async (req) => {
  if (Capacitor.isNativePlatform()) {
    const headers = { ...req.headers };
    if (req.bytes && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/octet-stream';
    }
    const res = await CapacitorHttp.request({
      method: req.method,
      url: req.url,
      headers,
      data: req.bytes ? toBase64(req.bytes) : req.text,
      dataType: req.bytes ? 'file' : undefined,
      responseType: req.binary ? 'blob' : 'text',
    });
    if (req.binary && res.status < 300) return { status: res.status, text: '', bytes: fromBase64(String(res.data)) };
    return { status: res.status, text: typeof res.data === 'string' ? res.data : JSON.stringify(res.data), bytes: null };
  }
  const url = req.url.replace(/^https:\/\/github\.com\//, '/github-com/');
  const res = await fetch(url, {
    method: req.method,
    headers: req.headers,
    body: req.bytes ? (req.bytes as BlobPart as BodyInit) : req.text,
  });
  if (req.binary && res.ok) return { status: res.status, text: '', bytes: new Uint8Array(await res.arrayBuffer()) };
  return { status: res.status, text: await res.text(), bytes: null };
};
