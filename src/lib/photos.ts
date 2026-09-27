import type { JournalDb, PhotoRecord } from './db';
import type { JournalRemote } from './github';
import { prepareImage, thumbnailFor } from './image';
import { sha256Hex, type LfsPort } from './lfs';

/**
 * Adds photos to a day and turns stored photos into displayable URLs,
 * downloading from LFS the first time a photo is viewed on this device.
 */
export class PhotoService {
  private urls = new Map<string, string>();
  private inflight = new Map<string, Promise<PhotoRecord>>();

  constructor(
    private db: JournalDb,
    private folder: string,
    private lfs: LfsPort,
    private remote: JournalRemote,
  ) {}

  async add(date: string, files: Iterable<Blob>): Promise<void> {
    for (const file of files) {
      const img = await prepareImage(file);
      const bytes = new Uint8Array(await img.blob.arrayBuffer());
      const oid = await sha256Hex(bytes);
      await this.db.addPhoto({
        path: `${this.folder}/assets/${date}/${oid.slice(0, 8)}.jpg`,
        date,
        oid,
        size: bytes.length,
        state: 'local',
        blob: img.blob,
        thumb: img.thumb,
        width: img.width,
        height: img.height,
        addedAt: Date.now(),
      });
    }
  }

  remove(path: string): Promise<void> {
    this.forget(path);
    return this.db.deletePhoto(path);
  }

  async url(photo: PhotoRecord, kind: 'thumb' | 'full'): Promise<string> {
    const key = `${kind}:${photo.path}:${photo.oid}`;
    const cached = this.urls.get(key);
    if (cached) return cached;
    const p = photo.blob && photo.thumb ? photo : await this.ensureBytes(photo);
    const url = URL.createObjectURL(kind === 'thumb' ? p.thumb! : p.blob!);
    this.urls.set(key, url);
    return url;
  }

  private ensureBytes(photo: PhotoRecord): Promise<PhotoRecord> {
    let job = this.inflight.get(photo.path);
    if (!job) {
      job = (async () => {
        const fresh = (await this.db.getPhoto(photo.path)) ?? photo;
        if (fresh.blob && fresh.thumb) return fresh;
        const bytes = fresh.oid.startsWith('git:')
          ? await this.remote.getBinary(fresh.oid.slice(4))
          : await this.lfs.download({ oid: fresh.oid, size: fresh.size });
        const blob = new Blob([bytes as BlobPart], { type: 'image/jpeg' });
        const { thumb, width, height } = await thumbnailFor(blob);
        const data = { blob, thumb, width, height };
        await this.db.storePhotoBytes(fresh.path, data);
        return { ...fresh, ...data };
      })().finally(() => this.inflight.delete(photo.path));
      this.inflight.set(photo.path, job);
    }
    return job;
  }

  private forget(path: string) {
    for (const [key, url] of this.urls) {
      if (key.includes(`:${path}:`)) {
        URL.revokeObjectURL(url);
        this.urls.delete(key);
      }
    }
  }

  dispose() {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
  }
}
