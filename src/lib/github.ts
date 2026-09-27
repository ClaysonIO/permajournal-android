import type { RemotePhoto } from './db';
import { fromBase64 } from './http';
import { parsePointer } from './lfs';

/**
 * The slice of GitHub the sync engine needs. Reads go through GraphQL (one
 * request lists a whole folder or fetches ~100 files); writes use the Git Data
 * API so a sync of many days is one atomic commit.
 */
export interface RemoteHead {
  commit: string;
  tree: string;
}

export interface RemoteFile {
  name: string;
  sha: string;
}

export interface FileChange {
  path: string;
  /** null deletes the file. */
  content: string | null;
}

export interface JournalRemote {
  getHead(): Promise<RemoteHead | null>;
  listFolder(commit: string, folder: string): Promise<RemoteFile[]>;
  getBlobs(shas: string[]): Promise<Map<string, string>>;
  /** Photos under `<folder>/assets/<YYYY-MM-DD>/`. */
  listPhotos(commit: string, folder: string): Promise<RemotePhoto[]>;
  /** Text of a file at a commit, or null if it doesn't exist. */
  readText(commit: string, path: string): Promise<string | null>;
  /** Raw bytes of a git blob (for images committed without LFS). */
  getBinary(sha: string): Promise<Uint8Array>;
  /** Returns 'conflict' when the branch moved since `parent` (someone else pushed). */
  commit(parent: RemoteHead, files: FileChange[], message: string): Promise<RemoteHead | 'conflict'>;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
  get isAuth() {
    return this.status === 401;
  }
}

const API = 'https://api.github.com';
const IMAGE_FILE = /\.(jpe?g|png|gif|webp|avif|heic|heif)$/i;
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

export class GitHubClient {
  constructor(private token: string) {}

  async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        msg = ((await res.json()) as { message?: string }).message ?? msg;
      } catch {
        /* keep status */
      }
      throw new GitHubError(`GitHub: ${msg}`, res.status);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const data = await this.rest<{ data?: T; errors?: { message: string }[] }>('POST', '/graphql', {
      query,
      variables,
    });
    if (data.errors?.length && !data.data) {
      throw new GitHubError(`GitHub: ${data.errors[0].message}`, 400);
    }
    return data.data as T;
  }

  async viewer(): Promise<{ login: string; name: string | null }> {
    return this.rest('GET', '/user');
  }

  /** Repositories the user can push to, journal-shaped ones first. */
  async listRepos(): Promise<RepoInfo[]> {
    const out: RepoInfo[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page++) {
      const data: ReposQuery = await this.graphql<ReposQuery>(REPOS_QUERY, { after });
      const conn = data.viewer.repositories;
      for (const n of conn.nodes) {
        if (!n || !['ADMIN', 'MAINTAIN', 'WRITE'].includes(n.viewerPermission ?? '')) continue;
        out.push(toRepoInfo(n));
      }
      if (!conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    return out.sort((a, b) => Number(b.isJournal) - Number(a.isJournal));
  }

  async getRepo(fullName: string): Promise<RepoInfo> {
    const [owner, name] = fullName.split('/');
    const data = await this.graphql<{ repository: RepoNode | null }>(
      `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${REPO_FIELDS}}}`,
      { owner, name },
    );
    if (!data.repository) throw new GitHubError(`Repository ${fullName} not found`, 404);
    return toRepoInfo(data.repository);
  }

  /** Turn any repository (even an empty one) into a journal. */
  async initJournal(fullName: string, branch: string | null, folder = 'entries'): Promise<void> {
    const content = JSON.stringify({ rootFolderName: folder }, null, 2) + '\n';
    await this.rest('PUT', `/repos/${fullName}/contents/permajournal.config.json`, {
      message: 'Set up Permajournal',
      content: btoa(content),
      ...(branch ? { branch } : {}),
    });
  }
}

export interface RepoInfo {
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  pushedAt: string | null;
  branch: string | null;
  folder: string;
  isJournal: boolean;
  entryCount: number | null;
}

interface RepoNode {
  nameWithOwner: string;
  description: string | null;
  isPrivate: boolean;
  pushedAt: string | null;
  viewerPermission?: string | null;
  defaultBranchRef: { name: string } | null;
  config: { text: string | null } | null;
  entries: { entries: { name: string }[] } | null;
}

interface ReposQuery {
  viewer: {
    repositories: {
      nodes: (RepoNode | null)[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

const REPO_FIELDS = `nameWithOwner description isPrivate pushedAt viewerPermission
  defaultBranchRef { name }
  config: object(expression: "HEAD:permajournal.config.json") { ... on Blob { text } }
  entries: object(expression: "HEAD:entries") { ... on Tree { entries { name } } }`;

const REPOS_QUERY = `query($after: String) {
  viewer {
    repositories(first: 50, after: $after, orderBy: {field: PUSHED_AT, direction: DESC},
                 affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
      nodes { ${REPO_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

function toRepoInfo(n: RepoNode): RepoInfo {
  let folder = 'entries';
  if (n.config?.text) {
    try {
      const cfg = JSON.parse(n.config.text) as { rootFolderName?: string };
      if (cfg.rootFolderName) folder = cfg.rootFolderName.replace(/^\/+|\/+$/g, '');
    } catch {
      /* malformed config: fall back to default folder */
    }
  }
  const entryCount = n.entries ? n.entries.entries.filter((e) => /^\d{4}-\d{2}-\d{2}\.md$/.test(e.name)).length : null;
  return {
    fullName: n.nameWithOwner,
    description: n.description,
    isPrivate: n.isPrivate,
    pushedAt: n.pushedAt,
    branch: n.defaultBranchRef?.name ?? null,
    folder,
    isJournal: !!n.config || (entryCount ?? 0) > 0,
    entryCount: folder === 'entries' ? entryCount : null,
  };
}

const BLOB_BATCH = 100;

/** JournalRemote backed by the real GitHub API. */
export class GitHubRemote implements JournalRemote {
  private owner: string;
  private name: string;

  constructor(
    private client: GitHubClient,
    fullName: string,
    private branch: string,
  ) {
    [this.owner, this.name] = fullName.split('/');
  }

  async getHead(): Promise<RemoteHead | null> {
    const data = await this.client.graphql<{
      repository: { ref: { target: { oid: string; tree?: { oid: string } } } | null };
    }>(
      `query($owner:String!,$name:String!,$ref:String!){repository(owner:$owner,name:$name){
        ref(qualifiedName:$ref){ target { oid ... on Commit { tree { oid } } } } } }`,
      { owner: this.owner, name: this.name, ref: `refs/heads/${this.branch}` },
    );
    const target = data.repository.ref?.target;
    if (!target?.tree) return null;
    return { commit: target.oid, tree: target.tree.oid };
  }

  async listFolder(commit: string, folder: string): Promise<RemoteFile[]> {
    const data = await this.client.graphql<{
      repository: { object: { entries?: { name: string; oid: string; type: string }[] } | null };
    }>(
      `query($owner:String!,$name:String!,$expr:String!){repository(owner:$owner,name:$name){
        object(expression:$expr){ ... on Tree { entries { name oid type } } } } }`,
      { owner: this.owner, name: this.name, expr: `${commit}:${folder}` },
    );
    return (data.repository.object?.entries ?? [])
      .filter((e) => e.type === 'blob')
      .map((e) => ({ name: e.name, sha: e.oid }));
  }

  async getBlobs(shas: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < shas.length; i += BLOB_BATCH) {
      const batch = shas.slice(i, i + BLOB_BATCH);
      const fields = batch
        .map((sha, j) => `b${j}: object(oid: "${sha}") { ... on Blob { text isTruncated isBinary } }`)
        .join('\n');
      const data = await this.client.graphql<{
        repository: Record<string, { text: string | null; isTruncated: boolean; isBinary: boolean } | null>;
      }>(`query($owner:String!,$name:String!){repository(owner:$owner,name:$name){ ${fields} }}`, {
        owner: this.owner,
        name: this.name,
      });
      for (let j = 0; j < batch.length; j++) {
        const blob = data.repository[`b${j}`];
        if (!blob || blob.isBinary) continue;
        out.set(batch[j], blob.isTruncated || blob.text === null ? await this.restBlob(batch[j]) : blob.text);
      }
    }
    return out;
  }

  private async restBlob(sha: string): Promise<string> {
    return new TextDecoder().decode(await this.getBinary(sha));
  }

  async getBinary(sha: string): Promise<Uint8Array> {
    const blob = await this.client.rest<{ content: string }>('GET', `/repos/${this.owner}/${this.name}/git/blobs/${sha}`);
    return fromBase64(blob.content);
  }

  async readText(commit: string, path: string): Promise<string | null> {
    const data = await this.client.graphql<{ repository: { object: { text: string | null } | null } }>(
      `query($owner:String!,$name:String!,$expr:String!){repository(owner:$owner,name:$name){
        object(expression:$expr){ ... on Blob { text } } } }`,
      { owner: this.owner, name: this.name, expr: `${commit}:${path}` },
    );
    return data.repository.object?.text ?? null;
  }

  async listPhotos(commit: string, folder: string): Promise<RemotePhoto[]> {
    type Blob = { text: string | null; isBinary: boolean; byteSize: number };
    type Entry = { name: string; oid: string; type: string; object: { entries?: Entry[] } & Partial<Blob> };
    const data = await this.client.graphql<{ repository: { object: { entries?: Entry[] } | null } }>(
      `query($owner:String!,$name:String!,$expr:String!){repository(owner:$owner,name:$name){
        object(expression:$expr){ ... on Tree { entries { name type oid object { ... on Tree {
          entries { name type oid object { ... on Blob { text isBinary byteSize } } } } } } } } } }`,
      { owner: this.owner, name: this.name, expr: `${commit}:${folder}/assets` },
    );
    const out: RemotePhoto[] = [];
    for (const day of data.repository.object?.entries ?? []) {
      if (day.type !== 'tree' || !DATE_DIR.test(day.name)) continue;
      for (const f of day.object.entries ?? []) {
        if (f.type !== 'blob' || !IMAGE_FILE.test(f.name)) continue;
        const path = `${folder}/assets/${day.name}/${f.name}`;
        const pointer = parsePointer(f.object.text);
        if (pointer) out.push({ path, date: day.name, ...pointer });
        else if (f.object.isBinary) out.push({ path, date: day.name, oid: `git:${f.oid}`, size: f.object.byteSize ?? 0 });
      }
    }
    return out;
  }

  async commit(parent: RemoteHead, files: FileChange[], message: string): Promise<RemoteHead | 'conflict'> {
    const repo = `/repos/${this.owner}/${this.name}`;
    const tree = await this.client.rest<{ sha: string }>('POST', `${repo}/git/trees`, {
      base_tree: parent.tree,
      tree: files.map((f) =>
        f.content === null
          ? { path: f.path, mode: '100644', type: 'blob', sha: null }
          : { path: f.path, mode: '100644', type: 'blob', content: f.content },
      ),
    });
    const commit = await this.client.rest<{ sha: string }>('POST', `${repo}/git/commits`, {
      message,
      tree: tree.sha,
      parents: [parent.commit],
    });
    try {
      await this.client.rest('PATCH', `${repo}/git/refs/heads/${this.branch}`, { sha: commit.sha, force: false });
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 422 || e.status === 409)) return 'conflict';
      throw e;
    }
    return { commit: commit.sha, tree: tree.sha };
  }
}
