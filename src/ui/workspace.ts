import { useEffect, useState, useSyncExternalStore } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { JournalDb } from '../lib/db';
import { GitHubClient, GitHubRemote } from '../lib/github';
import { http } from '../lib/http';
import { LfsClient } from '../lib/lfs';
import { PhotoService } from '../lib/photos';
import { SyncEngine, type SyncState } from '../lib/sync';
import type { SelectedRepo, Session } from '../lib/auth';

export interface Workspace {
  db: JournalDb;
  sync: SyncEngine;
  client: GitHubClient;
  photos: PhotoService;
  repo: SelectedRepo;
}

const POLL_MS = 60_000;
const PUSH_DEBOUNCE_MS = 2_500;

/** Open the local database for a repo and keep it synced for as long as it's mounted. */
export function useWorkspace(session: Session, repo: SelectedRepo): Workspace | null {
  const [ws, setWs] = useState<Workspace | null>(null);

  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];
    let workspace: Workspace | null = null;

    (async () => {
      const db = await JournalDb.open(repo.fullName);
      const client = new GitHubClient(session.token);
      const remote = new GitHubRemote(client, repo.fullName, repo.branch);
      const lfs = new LfsClient(http, repo.fullName, session.login, session.token);
      const sync = new SyncEngine(db, remote, repo.folder, lfs);
      const photos = new PhotoService(db, repo.folder, lfs, remote);
      await sync.init();
      if (disposed) {
        db.close();
        return;
      }
      workspace = { db, sync, client, photos, repo };
      setWs(workspace);

      const onLocal = (e: { source: string }) => {
        if (e.source !== 'local') return;
        void sync.notePendingChange();
        sync.request(PUSH_DEBOUNCE_MS);
      };
      cleanups.push(db.onChange(onLocal), db.onPhotoChange(onLocal));

      const status = await Network.getStatus().catch(() => ({ connected: navigator.onLine }));
      sync.setOnline(status.connected);
      const net = await Network.addListener('networkStatusChange', (s) => sync.setOnline(s.connected));
      cleanups.push(() => void net.remove());

      // Sync on resume and when going to the background (flush before Android may kill us).
      const state = await CapApp.addListener('appStateChange', () => sync.request(0));
      cleanups.push(() => void state.remove());

      const poll = setInterval(() => {
        if (document.visibilityState === 'visible') sync.request(0);
      }, POLL_MS);
      cleanups.push(() => clearInterval(poll));
      if (disposed) cleanups.forEach((c) => c());
    })();

    return () => {
      disposed = true;
      cleanups.forEach((c) => c());
      workspace?.sync.stop();
      workspace?.photos.dispose();
      workspace?.db.close();
      setWs(null);
    };
  }, [session.token, session.login, repo.fullName, repo.branch, repo.folder]);

  return ws;
}

export function useSyncState(sync: SyncEngine): SyncState {
  return useSyncExternalStore(
    (cb) => sync.subscribe(cb),
    () => sync.state,
  );
}

/** Set of dates with non-empty entries, kept live. */
export function useWrittenDates(db: JournalDb): Set<string> {
  const [dates, setDates] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const load = () =>
      db.writtenDates().then((d) => {
        if (alive) setDates(new Set(d));
      });
    void load();
    const off = db.onChange(() => void load());
    return () => {
      alive = false;
      off();
    };
  }, [db]);
  return dates;
}
