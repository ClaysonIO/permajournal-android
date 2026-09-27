import { dayKey, daysInMonth, monthKey } from '../lib/dates';

/** One segment per day of the selected month; filled segments are days with an entry. */
export function MonthBar(props: { written: Set<string>; selected: string; today: string; onSelect: (d: string) => void }) {
  const month = monthKey(props.selected);
  const days = Array.from({ length: daysInMonth(month) }, (_, i) => dayKey(month, i + 1));

  return (
    <div className="monthbar">
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
