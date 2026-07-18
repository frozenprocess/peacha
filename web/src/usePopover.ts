// Shared plumbing for click-anchored popovers (matrix cells, tier footers).
// Native popover="auto" gives top-layer rendering + light dismiss (click
// outside / Esc) for free; this hook shows the element whenever `anchor`
// changes and clamps it to the viewport using its REAL rendered size (a
// static guess undershoots when the content list is tall).

import { RefObject, useEffect } from 'react';

// @types/react 18 doesn't know the popover attribute - spread this instead.
export const popoverProps = { popover: 'auto' } as object;

export function useAnchoredPopover(
  ref: RefObject<HTMLElement>,
  anchor: unknown,
  onClose: () => void,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.matches(':popover-open')) el.showPopover();
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) {
      el.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`;
    }
    if (r.right > window.innerWidth - 8) {
      el.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`;
    }
  }, [ref, anchor]);

  // Light dismiss fires a native 'toggle' to closed; wired by hand because
  // @types/react 18 lacks onToggle on divs.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onT = (e: Event) => {
      if ((e as { newState?: string }).newState === 'closed') onClose();
    };
    el.addEventListener('toggle', onT);
    return () => el.removeEventListener('toggle', onT);
  }, [ref, onClose]);
}
