import { useEffect, useState } from 'react';
import { Browser } from '@capacitor/browser';
import type { Session } from '../lib/auth';
import { ChevronLeft } from './icons';
import { useSyncState, type Workspace } from './workspace';

export function SettingsScreen(props: {
  ws: Workspace;
  session: Session;
  onBack: () => void;
  onSwitchRepo: () => void;
  onSignOut: (keepLocal: boolean) => void;
}) {
  const { ws } = props;
  const s = useSyncState(ws.sync);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    void ws.db.writtenDates().then((d) => setCount(d.length));
  }, [ws.db, s.lastSyncAt]);

  const signOut = () => {
    if (s.pending) {
      const msg =
        `${s.pending} entr${s.pending === 1 ? 'y has' : 'ies have'} not been backed up yet. ` +
        'They will stay on this device and upload when you sign back in to this repository. Sign out?';
      if (window.confirm(msg)) props.onSignOut(true);
    } else if (window.confirm('Sign out and remove the local copy of this journal?')) {
      props.onSignOut(false);
    }
  };

  const redownload = async () => {
    await ws.db.resetRemoteState();
    ws.sync.request(0);
  };

  return (
    <div className="app">
      <header className="topbar safe-top">
        <button className="icon-btn" aria-label="Back" onClick={props.onBack}>
          <ChevronLeft />
        </button>
        <h2>Settings</h2>
        <div className="spacer" />
      </header>
      <div className="scroll pad">
        <h3 className="section">Backup</h3>
        <dl className="kv">
          <dt>Status</dt>
          <dd>{s.phase === 'idle' && s.pending ? 'Waiting to sync' : describe(s.phase)}</dd>
          <dt>Waiting to back up</dt>
          <dd>{s.pending}</dd>
          <dt>Last synced</dt>
          <dd>{s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never'}</dd>
          <dt>Entries on this device</dt>
          <dd>{count ?? '…'}</dd>
        </dl>
        {s.error && <p className="error small">{s.error}</p>}
        <div className="buttons">
          <button className="btn primary" disabled={s.phase === 'syncing'} onClick={() => void ws.sync.syncNow()}>
            Sync now
          </button>
          <button className="btn" disabled={s.phase === 'syncing'} onClick={() => void redownload()}>
            Re-check all entries
          </button>
        </div>

        <h3 className="section">Journal repository</h3>
        <dl className="kv">
          <dt>Repository</dt>
          <dd>{ws.repo.fullName}</dd>
          <dt>Branch</dt>
          <dd>{ws.repo.branch}</dd>
          <dt>Folder</dt>
          <dd>/{ws.repo.folder}</dd>
        </dl>
        <div className="buttons">
          <button className="btn" onClick={() => void Browser.open({ url: `https://github.com/${ws.repo.fullName}` })}>
            Open on GitHub
          </button>
          <button className="btn" onClick={props.onSwitchRepo}>
            Switch repository
          </button>
        </div>

        <h3 className="section">Account</h3>
        <p>
          Signed in as <strong>{props.session.name ?? props.session.login}</strong>{' '}
          <span className="muted">@{props.session.login}</span>
        </p>
        <div className="buttons">
          <button className="btn danger" onClick={signOut}>
            Sign out
          </button>
        </div>
        <div className="safe-bottom" />
      </div>
    </div>
  );
}

function describe(phase: string) {
  switch (phase) {
    case 'syncing':
      return 'Syncing…';
    case 'offline':
      return 'Offline — changes are saved on this device';
    case 'auth':
      return 'GitHub rejected the sign-in. Sign out and back in.';
    case 'error':
      return 'Error — retrying automatically';
    default:
      return 'Up to date';
  }
}
