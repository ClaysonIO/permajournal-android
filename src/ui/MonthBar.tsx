import { useEffect, useState } from 'react';
import { addMonths, dayKey, daysInMonth, formatMonth, monthKey } from '../lib/dates';
import { ChevronLeft, ChevronRight } from './icons';

/** One segment per day of the month; filled segments are days with an entry. */
export function MonthBar(props: { written: Set<string>; selected: string; today: string; onSelect: (d: string) => void }) {
  const [month, setMonth] = useState(monthKey(props.selected));
  useEffect(() => setMonth(monthKey(props.selected)), [props.selected]);

  const n = daysInMonth(month);
  const days = Array.from({ length: n }, (_, i) => dayKey(month, i + 1));
  const count = days.filter((d) => props.written.has(d)).length;
  const isCurrent = month === monthKey(props.today);
  const elapsed = isCurrent ? Number(props.today.slice(8)) : month < monthKey(props.today) ? n : 0;

  return (
    <div className="monthbar">
      <div className="monthbar-head">
        <button className="icon-btn small" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
          <ChevronLeft />
        </button>
        <span className="monthbar-title">{formatMonth(month)}</span>
        <span className="monthbar-count">
          {count}
          <span className="muted"> / {elapsed || n} days</span>
        </span>
        <button className="icon-btn small" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
          <ChevronRight />
        </button>
      </div>
      <div className="segments" role="list">
        {days.map((d) => {
          const cls = [
            'seg',
            props.written.has(d) ? 'written' : '',
            d > props.today ? 'future' : '',
            d === props.today ? 'today' : '',
            d === props.selected ? 'selected' : '',
          ].join(' ');
          return (
            <button
              key={d}
              role="listitem"
              className={cls}
              aria-label={d}
              disabled={d > props.today}
              onClick={() => props.onSelect(d)}
            />
          );
        })}
      </div>
    </div>
  );
}
