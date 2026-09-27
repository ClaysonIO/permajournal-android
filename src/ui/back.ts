import { useEffect, useRef } from 'react';

/** Android back-button handlers; the most recently registered one wins. */
const stack: { current: () => void }[] = [];

export function useBackHandler(active: boolean, handler: () => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    stack.push(ref);
    return () => {
      const i = stack.lastIndexOf(ref);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}

/** Run the top handler; false if nothing claimed the back press. */
export function handleBack(): boolean {
  const top = stack.at(-1);
  if (!top) return false;
  top.current();
  return true;
}
