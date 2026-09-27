import { gitBlobSha } from '../src/lib/gitsha';
import type { FileChange, JournalRemote, RemoteFile, RemoteHead } from '../src/lib/github';

/** In-memory stand-in for a GitHub branch: a linear list of snapshots. */
export class FakeRemote implements JournalRemote {
  commits: { id: string; files: Map<string, string> }[] = [{ id: 'c0', files: new Map() }];
  blobs = new Map<string, string>();
  /** Runs right before a commit is attempted, to simulate a concurrent push. */
  beforeCommit: (() => Promise<void>) | null = null;
  requests = { getBlobs: 0, blobCount: 0, commits: 0 };

  get headFiles() {
    return this.commits.at(-1)!.files;
  }

  async getHead(): Promise<RemoteHead> {
    const id = this.commits.at(-1)!.id;
    return { commit: id, tree: `t-${id}` };
  }

  async listFolder(commit: string, folder: string): Promise<RemoteFile[]> {
    const c = this.commits.find((x) => x.id === commit)!;
    const out: RemoteFile[] = [];
    for (const [path, text] of c.files) {
      if (path.startsWith(folder + '/')) out.push({ name: path.slice(folder.length + 1), sha: await gitBlobSha(text) });
    }
    return out;
  }

  async getBlobs(shas: string[]): Promise<Map<string, string>> {
    this.requests.getBlobs++;
    this.requests.blobCount += shas.length;
    return new Map(shas.map((s) => [s, this.blobs.get(s)!]));
  }

  async commit(parent: RemoteHead, changes: FileChange[]): Promise<RemoteHead | 'conflict'> {
    if (this.beforeCommit) {
      const fn = this.beforeCommit;
      this.beforeCommit = null;
      await fn();
    }
    this.requests.commits++;
    if (parent.commit !== this.commits.at(-1)!.id) return 'conflict';
    await this.write(changes);
    return this.getHead();
  }

  /** Push directly, as another device would. */
  async write(changes: FileChange[]) {
    const files = new Map(this.headFiles);
    for (const c of changes) {
      if (c.content === null) files.delete(c.path);
      else {
        files.set(c.path, c.content);
        this.blobs.set(await gitBlobSha(c.content), c.content);
      }
    }
    this.commits.push({ id: `c${this.commits.length}`, files });
  }
}
