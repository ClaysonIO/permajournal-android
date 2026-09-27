import { useEffect, useRef, useState } from 'react';
import { Browser } from '@capacitor/browser';
import { Clipboard } from '@capacitor/clipboard';
import { CLIENT_ID, startDeviceFlow, waitForToken, type DeviceCode, type Session } from '../lib/auth';
import { GitHubClient } from '../lib/github';

export function SignIn({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(!CLIENT_ID);
  const [token, setToken] = useState('');
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const finish = async (t: string) => {
    const user = await new GitHubClient(t).viewer();
    onSignedIn({ token: t, login: user.login, name: user.name });
  };

  const start = async () => {
    setError(null);
    setBusy(true);
    try {
      const c = await startDeviceFlow();
      setCode(c);
      await Clipboard.write({ string: c.userCode }).catch(() => undefined);
      await Browser.open({ url: c.verificationUri });
      abort.current = new AbortController();
      const t = await waitForToken(c, abort.current.signal);
      await Browser.close().catch(() => undefined);
      await finish(t);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      setCode(null);
    } finally {
      setBusy(false);
    }
  };

  const submitToken = async () => {
    setError(null);
    setBusy(true);
    try {
      await finish(token.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app center">
      <div className="card signin">
        <img className="logo" src={`${import.meta.env.BASE_URL}logo.svg`} alt="" />
        <h1 className="brand">Permajournal</h1>
        <p className="muted">A daily journal that lives on your phone and is backed up to your own GitHub repository.</p>

        {code ? (
          <div className="device-code">
            <p>Enter this code on GitHub (it's copied to your clipboard):</p>
            <div className="code">{code.userCode}</div>
            <button className="btn" onClick={() => void Browser.open({ url: code.verificationUri })}>
              Open GitHub again
            </button>
            <p className="muted small">Waiting for you to approve…</p>
          </div>
        ) : (
          CLIENT_ID && (
            <button className="btn primary" disabled={busy} onClick={() => void start()}>
              Sign in with GitHub
            </button>
          )
        )}

        {!code && (
          <>
            {CLIENT_ID && (
              <button className="link small" onClick={() => setShowToken(!showToken)}>
                {showToken ? 'Hide' : 'Use a personal access token instead'}
              </button>
            )}
            {showToken && (
              <div className="token-form">
                <input
                  type="password"
                  placeholder="ghp_… or github_pat_…"
                  value={token}
                  autoComplete="off"
                  onChange={(e) => setToken(e.target.value)}
                />
                <button className="btn" disabled={busy || !token.trim()} onClick={() => void submitToken()}>
                  Continue
                </button>
                <p className="muted small">Needs read and write access to the repository's contents.</p>
              </div>
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
