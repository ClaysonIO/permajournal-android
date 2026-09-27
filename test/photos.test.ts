import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { JournalDb, type PhotoRecord } from '../src/lib/db';
import { ensureLfsRule, formatPointer, parsePointer, sha256Hex } from '../src/lib/lfs';
import { SyncEngine } from '../src/lib/sync';
import { FakeLfs, FakeRemote } from './fakeRemote';

let n = 0;
async function device(remote: FakeRemote, lfs: FakeLfs) {
  const db = await JournalDb.open(`photos-${n++}`);
  const sync = new SyncEngine(db, remote, 'entries', lfs);
  await sync.init();
  return { db, sync };
}

async function photo(date: string, content: string): Promise<PhotoRecord> {
  const bytes = new TextEncoder().encode(content);
  const oid = await sha256Hex(bytes);
  return {
    path: `entries/assets/${date}/${oid.slice(0, 8)}.jpg`,
    date,
    oid,
    size: bytes.length,
    state: 'local',
    blob: new Blob([bytes]),
    thumb: null,
    width: 10,
    height: 10,
    addedAt: Date.now(),
  };
}

describe('LFS helpers', () => {
  it('round-trips pointer files', () => {
    const p = { oid: 'a'.repeat(64), size: 42 };
    expect(parsePointer(formatPointer(p))).toEqual(p);
    expect(parsePointer('hello')).toBeNull();
  });

  it('adds a .gitattributes rule only when missing', () => {
    expect(ensureLfsRule('*.jpg filter=lfs diff=lfs merge=lfs -text\n', 'jpg')).toBeNull();
    expect(ensureLfsRule(null, 'jpg')).toBe('*.jpg filter=lfs diff=lfs merge=lfs -text\n');
    expect(ensureLfsRule('*.psd binary', 'jpg')).toBe('*.psd binary\n*.jpg filter=lfs diff=lfs merge=lfs -text\n');
  });
});

describe('photo sync', () => {
  let remote: FakeRemote;
  let lfs: FakeLfs;
  beforeEach(() => {
    remote = new FakeRemote();
    lfs = new FakeLfs();
  });

  it('uploads bytes to LFS and commits only a pointer', async () => {
    const { db, sync } = await device(remote, lfs);
    const p = await photo('2026-09-27', 'jpeg bytes');
    await db.addPhoto(p);
    expect(await db.pendingCount()).toBe(1);
    await sync.syncNow();

    expect(sync.state.phase).toBe('idle');
    expect(lfs.objects.get(p.oid)).toEqual(new TextEncoder().encode('jpeg bytes'));
    expect(parsePointer(remote.headFiles.get(p.path)!)).toEqual({ oid: p.oid, size: p.size });
    expect(remote.headFiles.get('.gitattributes')).toContain('*.jpg filter=lfs');
    expect(await db.pendingCount()).toBe(0);
    expect((await db.getPhoto(p.path))!.state).toBe('synced');
  });

  it('shows photos from another device and downloads them on demand', async () => {
    const a = await device(remote, lfs);
    const b = await device(remote, lfs);
    const p = await photo('2026-09-27', 'from phone A');
    await a.db.addPhoto(p);
    await a.db.saveLocal('2026-09-27', 'Text too.');
    await a.sync.syncNow();
    expect(remote.requests.commits).toBe(1); // entry and photo in one commit

    await b.sync.syncNow();
    const [seen] = await b.db.photosFor('2026-09-27');
    expect(seen).toMatchObject({ path: p.path, oid: p.oid, state: 'synced', blob: null });
    expect(await lfs.download(seen)).toEqual(new TextEncoder().encode('from phone A'));
  });

  it('propagates deletions', async () => {
    const a = await device(remote, lfs);
    const b = await device(remote, lfs);
    const p = await photo('2026-09-27', 'short-lived');
    await a.db.addPhoto(p);
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(await b.db.photosFor('2026-09-27')).toHaveLength(1);

    await b.db.deletePhoto(p.path);
    expect(await b.db.photosFor('2026-09-27')).toHaveLength(0);
    await b.sync.syncNow();
    expect(remote.headFiles.has(p.path)).toBe(false);

    await a.sync.syncNow();
    expect(await a.db.photosFor('2026-09-27')).toHaveLength(0);
  });

  it('keeps a photo added offline while another device pushes', async () => {
    const a = await device(remote, lfs);
    const b = await device(remote, lfs);
    await a.db.addPhoto(await photo('2026-09-26', 'one'));
    await b.db.addPhoto(await photo('2026-09-26', 'two'));
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(await a.db.photosFor('2026-09-26')).toHaveLength(2);
    expect(await b.db.photosFor('2026-09-26')).toHaveLength(2);
    expect(lfs.uploads).toBe(2);
  });
});
