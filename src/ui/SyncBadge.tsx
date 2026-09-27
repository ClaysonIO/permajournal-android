import type { SyncEngine } from '../lib/sync';
import { useSyncState } from './workspace';

export function SyncBadge({ sync, onClick }: { sync: SyncEngine; onClick?: () => void }) {
  const s = useSyncState(sync);
  let label: string;
  let tone: string;
  if (s.phase === 'syncing') {
    label = s.progress ? `Downloading ${s.progress.done}/${s.progress.total}` : 'Syncing…';
    tone = 'busy';
  } else if (s.phase === 'offline') {
    label = s.pending ? `Offline · ${s.pending} to back up` : 'Offline';
    tone = 'warn';
  } else if (s.phase === 'auth') {
    label = 'Sign in again';
    tone = 'bad';
  } else if (s.phase === 'error') {
    label = s.pending ? `${s.pending} waiting · retrying` : 'Sync error · retrying';
    tone = 'bad';
  } else if (s.pending) {
    label = `${s.pending} to back up`;
    tone = 'warn';
  } else {
    label = s.lastSyncAt ? 'Backed up' : 'Not synced yet';
    tone = s.lastSyncAt ? 'ok' : 'warn';
  }
  return (
    <button className={`sync-badge ${tone}`} onClick={onClick}>
      <span className="dot" />
      {label}
    </button>
  );
}
