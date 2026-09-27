import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { addDays, formatMonth, formatWeekday, monthKey, todayKey } from '../lib/dates';
import type { EntrySummary } from '../lib/db';
import { ChevronLeft, SearchIcon } from './icons';
import type { Workspace } from './workspace';

/** Everything stored in the local database, newest first, searchable. */
export function HistoryScreen({ ws, onOpen, onBack }: { ws: Workspace; onOpen: (d: string) => void; onBack: () => void }) {
  const [summaries, setSummaries] = useState<EntrySummary[] | null>(null);
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const [fullText, setFullText] = useState<Map<string, string> | null>(null);

  useEffect(() => {
    void ws.db.summaries().then((s) => setSummaries(s.sort((a, b) => (a.date < b.date ? 1 : -1))));
  }, [ws.db]);

  // Full-text search needs whole entries; load them only once someone searches.
  useEffect(() => {
    if (deferred.length < 2 || fullText) return;
    void ws.db.allEntries().then((all) => setFullText(new Map(all.map((e) => [e.date, e.text.toLowerCase()]))));
  }, [deferred, fullText, ws.db]);

  const stats = useMemo(() => (summaries ? computeStats(summaries) : null), [summaries]);

  const groups = useMemo(() => {
    if (!summaries) return [];
    const matches =
      deferred.length < 2
        ? summaries
        : summaries.filter((s) =>
            fullText ? fullText.get(s.date)?.includes(deferred) : s.preview.toLowerCase().includes(deferred),
          );
    const out: { month: string; items: EntrySummary[]; words: number }[] = [];
    for (const s of matches) {
      const m = monthKey(s.date);
      if (out.at(-1)?.month !== m) out.push({ month: m, items: [], words: 0 });
      out.at(-1)!.items.push(s);
      out.at(-1)!.words += s.words;
    }
    return out;
  }, [summaries, deferred, fullText]);

  return (
    <div className="app">
      <header className="topbar safe-top">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          <ChevronLeft />
        </button>
        <h2>History</h2>
        <div className="spacer" />
      </header>
      <div className="scroll">
        {stats && (
          <div className="stats">
            <Stat value={stats.entries.toLocaleString()} label="entries" />
            <Stat value={stats.words.toLocaleString()} label="words" />
            <Stat value={String(stats.streak)} label="day streak" />
            <Stat value={stats.since} label="since" />
          </div>
        )}
        <label className="search-wrap">
          <SearchIcon />
          <input
            className="search bare"
            type="search"
            placeholder="Search every entry"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {!summaries && <p className="muted pad">Loading…</p>}
        {summaries?.length === 0 && <p className="muted pad">No entries yet. They'll appear here once synced or written.</p>}
        {groups.map((g) => (
          <section key={g.month} className="month-group" style={{ containIntrinsicSize: `auto ${g.items.length * 76 + 40}px` }}>
            <h3 className="section sticky">
              {formatMonth(g.month)}
              <span className="muted small">
                {' '}
                · {g.items.length} {g.items.length === 1 ? 'entry' : 'entries'} · {g.words.toLocaleString()} words
              </span>
            </h3>
            {g.items.map((s) => (
              <button key={s.date} className="row entry" onClick={() => onOpen(s.date)}>
                <div className="entry-date">
                  <span className="entry-day">{Number(s.date.slice(8))}</span>
                  <span className="muted small">{formatWeekday(s.date)}</span>
                </div>
                <div className="row-main">
                  <div className="entry-preview">{s.preview}</div>
                  <div className="muted small">
                    {s.words} words{s.dirty && <span className="pending"> · not backed up yet</span>}
                  </div>
                </div>
              </button>
            ))}
          </section>
        ))}
        <div className="safe-bottom" />
      </div>
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="muted small">{label}</div>
    </div>
  );
}

function computeStats(s: EntrySummary[]) {
  const dates = new Set(s.map((x) => x.date));
  let day = todayKey();
  if (!dates.has(day)) day = addDays(day, -1); // today not written yet doesn't break the streak
  let streak = 0;
  while (dates.has(day)) {
    streak++;
    day = addDays(day, -1);
  }
  const first = s.at(-1)?.date;
  return {
    entries: s.length,
    words: s.reduce((n, x) => n + x.words, 0),
    streak,
    since: first ? first.slice(0, 4) : '—',
  };
}
