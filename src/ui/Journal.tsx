import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { addDays, formatLong, todayKey } from '../lib/dates';
import { countWords } from '../lib/db';
import { mergeText } from '../lib/merge';
import { MonthBar } from './MonthBar';
import { SyncBadge } from './SyncBadge';
import { ChevronLeft, ChevronRight, GearIcon, GridIcon, HistoryIcon } from './icons';
import { useWrittenDates, type Workspace } from './workspace';

const SAVE_DEBOUNCE_MS = 300;

export function JournalScreen(props: {
  ws: Workspace;
  date: string;
  onDate: (d: string) => void;
  onHistory: () => void;
  onYears: () => void;
  onSettings: () => void;
}) {
  const { db } = props.ws;
  const written = useWrittenDates(db);
  const [today, setToday] = useState(todayKey);

  // Keep "today" correct across midnight.
  useEffect(() => {
    const t = setInterval(() => setToday(todayKey()), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="app journal">
      <div className="safe-top" />
      <MonthBar written={written} selected={props.date} today={today} onSelect={props.onDate} />
      <header className="dayhead">
        <button className="icon-btn" aria-label="Previous day" onClick={() => props.onDate(addDays(props.date, -1))}>
          <ChevronLeft />
        </button>
        <div className="dayhead-title">
          <div className="date">{formatLong(props.date)}</div>
          {props.date !== today && (
            <button className="link small" onClick={() => props.onDate(today)}>
              Back to today
            </button>
          )}
        </div>
        <button
          className="icon-btn"
          aria-label="Next day"
          disabled={props.date >= today}
          onClick={() => props.onDate(addDays(props.date, 1))}
        >
          <ChevronRight />
        </button>
      </header>
      <Editor key={props.date} ws={props.ws} date={props.date} isToday={props.date === today} />
      <footer className="toolbar safe-bottom">
        <SyncBadge sync={props.ws.sync} onClick={props.onSettings} />
        <div className="spacer" />
        <button className="icon-btn" aria-label="Years" onClick={props.onYears}>
          <GridIcon />
        </button>
        <button className="icon-btn" aria-label="History" onClick={props.onHistory}>
          <HistoryIcon />
        </button>
        <button className="icon-btn" aria-label="Settings" onClick={props.onSettings}>
          <GearIcon />
        </button>
      </footer>
    </div>
  );
}

/**
 * Plain textarea editor. Every change is written to IndexedDB after a short
 * debounce; if a sync brings in remote edits for this day while we're typing,
 * they're merged into what's on screen instead of overwriting it.
 */
function Editor({ ws, date, isToday }: { ws: Workspace; date: string; isToday: boolean }) {
  const { db } = ws;
  const [text, setText] = useState<string | null>(null);
  const saved = useRef('');
  const current = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const selection = useRef<[number, number] | null>(null);

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (current.current !== saved.current) {
      saved.current = current.current;
      void db.saveLocal(date, current.current);
    }
  }, [db, date]);

  useEffect(() => {
    let alive = true;
    void db.getText(date).then((t) => {
      if (!alive) return;
      saved.current = current.current = t;
      setText(t);
    });
    const off = db.onChange(async (e) => {
      if (e.source !== 'remote' || !e.dates.includes(date)) return;
      const fresh = await db.getText(date);
      if (!alive || fresh === saved.current) return;
      const next = current.current === saved.current ? fresh : mergeText(saved.current, current.current, fresh);
      const el = area.current;
      if (el) selection.current = [el.selectionStart, el.selectionEnd];
      current.current = next;
      saved.current = next;
      setText(next);
      if (next !== fresh) void db.saveLocal(date, next);
    });
    const onHide = () => document.visibilityState === 'hidden' && flush();
    document.addEventListener('visibilitychange', onHide);
    return () => {
      alive = false;
      off();
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, [db, date, flush]);

  // Keep the caret in place when remote text is merged in.
  useLayoutEffect(() => {
    const el = area.current;
    const sel = selection.current;
    if (el && sel) {
      el.setSelectionRange(Math.min(sel[0], el.value.length), Math.min(sel[1], el.value.length));
      selection.current = null;
    }
  }, [text]);

  if (text === null) return <div className="editor" />;

  return (
    <div className="editor">
      <textarea
        ref={area}
        value={text}
        autoFocus={isToday && text === ''}
        spellCheck
        autoCapitalize="sentences"
        placeholder={isToday ? 'What happened today?' : 'Nothing written this day.'}
        onChange={(e) => {
          current.current = e.target.value;
          setText(e.target.value);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
        }}
        onBlur={flush}
      />
      <div className="wordcount muted small">{countWords(text)} words</div>
    </div>
  );
}
