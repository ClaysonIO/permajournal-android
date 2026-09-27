import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type { RepoInfo } from './github';

/**
 * GitHub sign-in with the OAuth device flow: no backend and no client secret,
 * just a client ID. github.com's OAuth endpoints don't allow CORS, so on
 * Android we call them through native HTTP (and via the Vite proxy in dev).
 */
export const CLIENT_ID = (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined) ?? '';
const SCOPE = 'repo';
const OAUTH_BASE = Capacitor.isNativePlatform() ? 'https://github.com' : '/github-com';

export interface Session {
  token: string;
  login: string;
  name: string | null;
}

export interface SelectedRepo {
  fullName: string;
  branch: string;
  folder: string;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresAt: number;
}

async function postJson(path: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  const url = `${OAUTH_BASE}${path}`;
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (Capacitor.isNativePlatform()) {
    const res = await CapacitorHttp.post({ url, headers, data: body });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  return res.json();
}

export async function startDeviceFlow(): Promise<DeviceCode> {
  if (!CLIENT_ID) throw new Error('This build has no GitHub client ID. Use a personal access token instead.');
  const r = await postJson('/login/device/code', { client_id: CLIENT_ID, scope: SCOPE });
  if (typeof r.device_code !== 'string') {
    throw new Error(String(r.error_description ?? r.error ?? 'GitHub did not return a device code'));
  }
  return {
    deviceCode: r.device_code,
    userCode: String(r.user_code),
    verificationUri: String(r.verification_uri),
    interval: Number(r.interval ?? 5),
    expiresAt: Date.now() + Number(r.expires_in ?? 900) * 1000,
  };
}

/** Poll until the user approves the code in their browser. */
export async function waitForToken(code: DeviceCode, signal: AbortSignal): Promise<string> {
  let interval = code.interval;
  while (!signal.aborted) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    if (signal.aborted) break;
    if (Date.now() > code.expiresAt) throw new Error('The code expired. Please try again.');
    const r = await postJson('/login/oauth/access_token', {
      client_id: CLIENT_ID,
      device_code: code.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (typeof r.access_token === 'string') return r.access_token;
    if (r.error === 'authorization_pending') continue;
    if (r.error === 'slow_down') {
      interval = Number(r.interval ?? interval + 5);
      continue;
    }
    throw new Error(String(r.error_description ?? r.error ?? 'Sign-in failed'));
  }
  throw new DOMException('Cancelled', 'AbortError');
}

const SESSION_KEY = 'session';
const REPO_KEY = 'repo';

async function load<T>(key: string): Promise<T | null> {
  const { value } = await Preferences.get({ key });
  return value ? (JSON.parse(value) as T) : null;
}

async function save(key: string, value: unknown) {
  if (value === null) await Preferences.remove({ key });
  else await Preferences.set({ key, value: JSON.stringify(value) });
}

export const loadSession = () => load<Session>(SESSION_KEY);
export const saveSession = (s: Session | null) => save(SESSION_KEY, s);
export const loadRepo = () => load<SelectedRepo>(REPO_KEY);
export const saveRepo = (r: SelectedRepo | null) => save(REPO_KEY, r);

export function repoSelection(info: RepoInfo): SelectedRepo {
  return { fullName: info.fullName, branch: info.branch ?? 'main', folder: info.folder };
}
