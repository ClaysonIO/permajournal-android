import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { JournalDb } from '../src/lib/db';
import { SyncEngine } from '../src/lib/sync';
import { FakeRemote } from './fakeRemote';

let n = 0;
async function device(remote: FakeRemote) {
  const db = await JournalDb.open(`test-${n++}`);
  const sync = new SyncEngine(db, remote, 'entries');
  await sync.init();
  return { db, sync };
}

describe('SyncEngine', () => {
  let remote: FakeRemote;
  beforeEach(async () => {
    remote = new FakeRemote();
    await remote.write([
      { path: 'entries/2026-09-01.md', content: 'First.\n' },
      { path: 'entries/2026-09-02.md', content: 'Second.\n' },
      { path: 'entries/notes.md', content: 'ignored' },
      { path: 'README.md', content: 'readme' },
    ]);
  });

  it('downloads the journal on first sync', async () => {
    const { db, sync } = await device(remote);
    await sync.syncNow();
    expect(sync.state.phase).toBe('idle');
    expect((await db.writtenDates()).sort()).toEqual(['2026-09-01', '2026-09-02']);
    expect(await db.getText('2026-09-02')).toBe('Second.\n');
    expect(remote.requests.commits).toBe(0);
  });

  it('pushes local edits in one commit and only downloads what changed', async () => {
    const { db, sync } = await device(remote);
    await sync.syncNow();
    await db.saveLocal('2026-09-02', 'Second, edited.\n');
    await db.saveLocal('2026-09-03', 'Third.\n');
    await sync.syncNow();
    expect(remote.requests.commits).toBe(1);
    expect(remote.headFiles.get('entries/2026-09-03.md')).toBe('Third.\n');
    expect(await db.pendingCount()).toBe(0);

    const blobsBefore = remote.requests.blobCount;
    await sync.syncNow();
    expect(remote.requests.blobCount).toBe(blobsBefore); // our own push isn't re-downloaded
  });

  it('works offline and catches up later', async () => {
    const { db, sync } = await device(remote);
    await sync.syncNow();
    sync.setOnline(false);
    await db.saveLocal('2026-09-04', 'Written on a plane.\n');
    await sync.syncNow();
    expect(sync.state.phase).toBe('offline');
    expect(remote.headFiles.has('entries/2026-09-04.md')).toBe(false);
    sync.setOnline(true);
    await sync.syncNow();
    expect(remote.headFiles.get('entries/2026-09-04.md')).toBe('Written on a plane.\n');
  });

  it('merges concurrent edits from two devices', async () => {
    const phone = await device(remote);
    const laptop = await device(remote);
    await phone.sync.syncNow();
    await laptop.sync.syncNow();

    await phone.db.saveLocal('2026-09-01', 'First.\nPhone line.\n');
    await laptop.db.saveLocal('2026-09-01', 'Edited first.\n');
    await laptop.db.saveLocal('2026-09-05', 'Laptop only.\n');
    await laptop.sync.syncNow();
    await phone.sync.syncNow();
    await laptop.sync.syncNow();

    const expected = 'Edited first.\nPhone line.\n';
    expect(remote.headFiles.get('entries/2026-09-01.md')).toBe(expected);
    expect(await phone.db.getText('2026-09-01')).toBe(expected);
    expect(await laptop.db.getText('2026-09-01')).toBe(expected);
    expect(await phone.db.getText('2026-09-05')).toBe('Laptop only.\n');
    expect(await phone.db.pendingCount()).toBe(0);
  });

  it('retries when another device pushes mid-sync', async () => {
    const { db, sync } = await device(remote);
    await sync.syncNow();
    await db.saveLocal('2026-09-02', 'Second.\nMine.\n');
    remote.beforeCommit = () => remote.write([{ path: 'entries/2026-09-02.md', content: 'Theirs.\nSecond.\n' }]);
    await sync.syncNow();
    expect(sync.state.phase).toBe('idle');
    expect(remote.headFiles.get('entries/2026-09-02.md')).toBe('Theirs.\nSecond.\nMine.\n');
  });

  it('keeps both entries when a day was started on two devices offline', async () => {
    const { db, sync } = await device(remote);
    await db.saveLocal('2026-09-02', 'Offline thoughts.');
    await sync.syncNow();
    expect(remote.headFiles.get('entries/2026-09-02.md')).toBe('Second.\n\nOffline thoughts.\n');
  });

  it('handles deletions both ways', async () => {
    const { db, sync } = await device(remote);
    await sync.syncNow();
    await db.saveLocal('2026-09-01', '');
    await sync.syncNow();
    expect(remote.headFiles.has('entries/2026-09-01.md')).toBe(false);

    await remote.write([{ path: 'entries/2026-09-02.md', content: null }]);
    await sync.syncNow();
    expect(await db.writtenDates()).toEqual([]);
  });

  it('keeps edits typed while a push is in flight', async () => {
    const { db, sync } = await device(remote);
    await sync.syncNow();
    await db.saveLocal('2026-09-02', 'Second.\nA\n');
    remote.beforeCommit = () => db.saveLocal('2026-09-02', 'Second.\nA\nB\n');
    await sync.syncNow();
    expect(await db.pendingCount()).toBe(1);
    await sync.syncNow();
    expect(remote.headFiles.get('entries/2026-09-02.md')).toBe('Second.\nA\nB\n');
    expect(await db.pendingCount()).toBe(0);
  });
});
