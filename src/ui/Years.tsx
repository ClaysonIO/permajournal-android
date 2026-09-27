import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parseDateKey, toDateKey, todayKey } from '../lib/dates';
import type { EntrySummary } from '../lib/db';
import { ChevronLeft } from './icons';
import type { Workspace } from './workspace';

const CELL = 10;
const PITCH = 12;
const TOP = 10;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Every year since the first entry, each as a GitHub-style contribution grid. */
export function YearsScreen({ ws, onOpen, onBack }: { ws: Workspace; onOpen: (d: string) => void; onBack: () => void }) {
  const [summaries, setSummaries] = useState<Map<string, EntrySummary> | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const today = todayKey();

  useEffect(() => {
    void ws.db.summaries().then((s) => setSummaries(new Map(s.map((x) => [x.date, x]))));
  }, [ws.db]);

  const { years, levels } = useMemo(() => {
    if (!summaries) return { years: [], levels: new Map<string, number>() };
    const dates = [...summaries.keys()].sort();
    const first = Number((dates[0] ?? today).slice(0, 4));
    const last = Number(today.slice(0, 4));
    const years = Array.from({ length: last - first + 1 }, (_, i) => first + i);
    // Shade by word count, split into quartiles of the whole journal.
    const words = [...summaries.values()].map((s) => s.words).sort((a, b) => a - b);
    const q = (p: number) => words[Math.floor((words.length - 1) * p)] ?? 0;
    const [q1, q2, q3] = [q(0.25), q(0.5), q(0.75)];
    const levels = new Map<string, number>();
    for (const s of summaries.values()) levels.set(s.date, s.words <= q1 ? 1 : s.words <= q2 ? 2 : s.words <= q3 ? 3 : 4);
    return { years, levels };
  }, [summaries, today]);

  // Chronological from the first entry; start scrolled to the current year.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && years.length) el.scrollTop = el.scrollHeight;
  }, [years.length]);

  const pick = (d: string) => {
    if (d > today) return;
    if (d === picked) onOpen(d);
    else setPicked(d);
  };

  const pickedSummary = picked ? summaries?.get(picked) : undefined;

  return (
    <div className="app">
      <header className="topbar safe-top">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          <ChevronLeft />
        </button>
        <h2>Years</h2>
        <div className="spacer" />
      </header>
      <div className="scroll" ref={scroller}>
        {!summaries && <p className="muted pad">Loading…</p>}
        {years.map((y) => (
          <Year key={y} year={y} levels={levels} summaries={summaries!} today={today} picked={picked} onPick={pick} />
        ))}
        <Legend />
      </div>
      <footer className="toolbar pick-bar safe-bottom">
        {picked ? (
          <>
            <div className="row-main">
              <div className="row-title">
                {parseDateKey(picked).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
              </div>
              <div className="muted small">{pickedSummary ? `${pickedSummary.words} words` : 'Nothing written'}</div>
            </div>
            <button className="btn primary" onClick={() => onOpen(picked)}>
              Open
            </button>
          </>
        ) : (
          <div className="muted small pad-x">Tap a day to see it; tap again to open it.</div>
        )}
      </footer>
    </div>
  );
}

const Year = memo(function Year(props: {
  year: number;
  levels: Map<string, number>;
  summaries: Map<string, EntrySummary>;
  today: string;
  picked: string | null;
  onPick: (d: string) => void;
}) {
  const { year, levels, today } = props;
  const { cells, labels, weeks, count, words } = useMemo(() => {
    const cells: { d: string; x: number; y: number; cls: string }[] = [];
    const labels: { x: number; m: string }[] = [];
    const offset = new Date(year, 0, 1).getDay();
    let count = 0;
    let words = 0;
    let weeks = 0;
    for (let d = new Date(year, 0, 1), i = 0; d.getFullYear() === year; d.setDate(d.getDate() + 1), i++) {
      const key = toDateKey(d);
      const col = Math.floor((i + offset) / 7);
      weeks = col + 1;
      if (d.getDate() === 1) labels.push({ x: col * PITCH, m: MONTHS[d.getMonth()] });
      const level = levels.get(key);
      if (level) {
        count++;
        words += props.summaries.get(key)!.words;
      }
      let cls = level ? `l${level}` : key > today ? 'future' : '';
      if (key === today) cls += ' today';
      cells.push({ d: key, x: col * PITCH, y: TOP + d.getDay() * PITCH, cls });
    }
    return { cells, labels, weeks, count, words };
  }, [year, levels, today, props.summaries]);

  const width = weeks * PITCH - (PITCH - CELL);
  const height = TOP + 7 * PITCH - (PITCH - CELL);
  const picked = props.picked?.startsWith(`${year}-`) ? cells.find((c) => c.d === props.picked) : undefined;

  return (
    <section className="year">
      <div className="year-head">
        <span className="year-title">{year}</span>
        <span className="muted small">
          {count} {count === 1 ? 'day' : 'days'} · {words.toLocaleString()} words
        </span>
      </div>
      <svg
        className="year-grid"
        viewBox={`0 0 ${width} ${height}`}
        onClick={(e) => {
          const d = (e.target as Element).getAttribute('data-d');
          if (d) props.onPick(d);
        }}
      >
        {labels.map((l) => (
          <text key={l.m} className="month-label" x={l.x} y={7}>
            {l.m}
          </text>
        ))}
        {cells.map((c) => (
          <rect key={c.d} data-d={c.d} x={c.x} y={c.y} width={CELL} height={CELL} rx={2} className={c.cls} />
        ))}
        {picked && (
          <rect x={picked.x - 1} y={picked.y - 1} width={CELL + 2} height={CELL + 2} rx={3} fill="none" stroke="currentColor" strokeWidth={2} pointerEvents="none" style={{ fill: 'none' }} />
        )}
      </svg>
    </section>
  );
});

function Legend() {
  return (
    <div className="legend muted small">
      Less
      <svg width={66} height={10} className="year-grid" style={{ width: 66 }}>
        {['', 'l1', 'l2', 'l3', 'l4'].map((c, i) => (
          <rect key={c} x={i * 14} y={0} width={10} height={10} rx={2} className={c} />
        ))}
      </svg>
      More
    </div>
  );
}
