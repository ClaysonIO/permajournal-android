import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { formatShort } from '../lib/dates';
import type { SearchResponse, SearchStatus } from '../search/index';
import { ChevronLeft, SearchIcon } from './icons';
import { useSearchStatus, type Workspace } from './workspace';

const TYPING_PAUSE_MS = 180;

/** Search the whole journal by meaning as well as by words. Everything runs on the device. */
export default function SearchScreen(props: {
  ws: Workspace;
  query: string;
  onQuery: (q: string) => void;
  onOpen: (d: string) => void;
  onBack: () => void;
}) {
  const { search } = props.ws;
  const status = useSearchStatus(search);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = props.query.trim();

  // Opening the page is a good hint that the model is about to be needed.
  useEffect(() => search.warm(), [search]);

  // Ask again when the model finishes loading, and when indexing completes.
  const modelReady = status.model === 'ready';
  const complete = status.phase === 'ready';
  useEffect(() => {
    if (query.length < 2) {
      setResponse(null);
      return;
    }
    let current = true;
    const t = setTimeout(() => {
      search.search(query).then(
        (r) => {
          if (!current) return;
          setResponse(r);
          setError(null);
        },
        (e: Error) => current && setError(e.message),
      );
    }, TYPING_PAUSE_MS);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [search, query, modelReady, complete]);

  const highlight = useMemo(() => highlighter(response?.terms ?? []), [response]);

  return (
    <div className="app">
      <header className="topbar safe-top">
        <button className="icon-btn" aria-label="Back" onClick={props.onBack}>
          <ChevronLeft />
        </button>
        <h2>Search</h2>
        <div className="spacer" />
      </header>
      <label className="search-wrap search-page-input">
        <SearchIcon />
        <input
          className="search bare"
          type="search"
          enterKeyHint="search"
          autoFocus={props.query === ''}
          placeholder="Words, or what it was about"
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
        />
      </label>
      <p className="search-status muted small">{describe(status)}</p>
      <div className="scroll">
        {error && <p className="error small pad">{error}</p>}
        {query.length < 2 && (
          <p className="muted pad">
            Search finds entries by meaning, not only exact words: try “a walk by the sea” or “feeling stuck at work”. The
            index is built and kept on this device.
          </p>
        )}
        {response && query.length >= 2 && response.hits.length === 0 && <p className="muted pad">Nothing found.</p>}
        {query.length >= 2 &&
          response?.hits.map((h) => (
            <button key={h.date} className="row search-hit" onClick={() => props.onOpen(h.date)}>
              <div className="row-main">
                <div className="search-hit-head">
                  <span className="row-title">{formatShort(h.date)}</span>
                  {h.match === 'meaning' && <span className="badge">related</span>}
                </div>
                <div className="search-snippet">{highlight(h.snippet)}</div>
              </div>
            </button>
          ))}
        <div className="safe-bottom" />
      </div>
    </div>
  );
}

function describe(s: SearchStatus): string {
  if (s.phase === 'scanning') return 'Preparing search…';
  if (s.model === 'unavailable') return 'Searching by words only: the search model could not be loaded.';
  if (s.phase === 'indexing' && s.embedded < s.entries) {
    return `Indexing in the background: ${s.embedded.toLocaleString()} of ${s.entries.toLocaleString()} entries. Word matches already work.`;
  }
  if (s.entries === 0) return 'No entries to search yet.';
  return `${s.entries.toLocaleString()} entries indexed on this device.`;
}

/** Wraps the query's words in <mark>. */
function highlighter(terms: string[]): (text: string) => ReactNode {
  if (terms.length === 0) return (text) => text;
  const escaped = [...terms].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`(${escaped.join('|')})`, 'giu');
  return (text) => text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}
