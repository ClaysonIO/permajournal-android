import { useEffect, useMemo, useState } from 'react';
import { repoSelection, type SelectedRepo, type Session } from '../lib/auth';
import { GitHubClient, type RepoInfo } from '../lib/github';

export function RepoPicker(props: { session: Session; onPick: (r: SelectedRepo) => void; onSignOut: () => void }) {
  const client = useMemo(() => new GitHubClient(props.session.token), [props.session.token]);
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    client.listRepos().then(setRepos, (e: Error) => setError(e.message));
  }, [client]);

  const pick = async (r: RepoInfo) => {
    setError(null);
    if (!r.isJournal) {
      const ok = window.confirm(
        `${r.fullName} doesn't look like a journal yet.\n\nSet it up? This adds permajournal.config.json and stores entries in /entries.`,
      );
      if (!ok) return;
      setBusy(r.fullName);
      try {
        await client.initJournal(r.fullName, r.branch);
        r = await client.getRepo(r.fullName);
      } catch (e) {
        setError((e as Error).message);
        setBusy(null);
        return;
      }
    }
    props.onPick(repoSelection(r));
  };

  const q = filter.trim().toLowerCase();
  const shown = repos?.filter((r) => r.fullName.toLowerCase().includes(q)) ?? [];
  const journals = shown.filter((r) => r.isJournal);
  const others = shown.filter((r) => !r.isJournal);

  return (
    <div className="app">
      <header className="topbar safe-top">
        <img className="logo-small" src={`${import.meta.env.BASE_URL}logo.svg`} alt="" />
        <h2>Choose your journal</h2>
        <button className="link" onClick={props.onSignOut}>
          Sign out
        </button>
      </header>
      <div className="scroll pad">
        <p className="muted small">
          Signed in as <strong>{props.session.login}</strong>. Pick the repository that holds your journal. Entries are
          stored as <code>entries/YYYY-MM-DD.md</code>.
        </p>
        <input className="search" placeholder="Filter repositories" value={filter} onChange={(e) => setFilter(e.target.value)} />
        {error && <p className="error">{error}</p>}
        {!repos && !error && <p className="muted">Loading repositories…</p>}
        {journals.length > 0 && <h3 className="section">Journals</h3>}
        {journals.map((r) => (
          <RepoRow key={r.fullName} repo={r} busy={busy === r.fullName} onPick={pick} />
        ))}
        {others.length > 0 && <h3 className="section">Other repositories</h3>}
        {others.map((r) => (
          <RepoRow key={r.fullName} repo={r} busy={busy === r.fullName} onPick={pick} />
        ))}
      </div>
    </div>
  );
}

function RepoRow({ repo, busy, onPick }: { repo: RepoInfo; busy: boolean; onPick: (r: RepoInfo) => void }) {
  return (
    <button className="row repo" disabled={busy} onClick={() => onPick(repo)}>
      <div className="row-main">
        <div className="row-title">
          {repo.fullName} {repo.isPrivate && <span className="badge">private</span>}
        </div>
        <div className="muted small">
          {busy
            ? 'Setting up…'
            : repo.isJournal
              ? `${repo.entryCount != null ? `${repo.entryCount} entries · ` : ''}/${repo.folder}`
              : (repo.description ?? 'Not a journal yet')}
        </div>
      </div>
    </button>
  );
}
