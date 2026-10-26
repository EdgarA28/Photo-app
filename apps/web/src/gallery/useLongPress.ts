import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";

/** How long a press has to be held. */
export const LONG_PRESS_MS = 500;
/** Moving further than this (px) is a scroll or a drag, not a press. */
const MOVE_TOLERANCE = 10;

/**
 * Long press on a grid tile (select mode, 8.11): fires `onLongPress` after the pointer is held
 * still for `LONG_PRESS_MS`, and swallows the click that follows (so the tile's link doesn't open)
 * and the context menu Android shows on a long-pressed link. A scroll cancels it (the browser
 * sends `pointercancel` when it takes the touch over). Undefined `onLongPress`: plain handlers.
 */
export function useLongPress(onLongPress: (() => void) | undefined) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);

  const cancel = () => {
    clearTimeout(timer.current);
    start.current = null;
  };
  useEffect(() => {
    const pending = timer;
    return () => clearTimeout(pending.current);
  }, []);

  if (!onLongPress) return {};
  return {
    onPointerDown(event: PointerEvent) {
      if (!event.isPrimary || event.button !== 0) return;
      fired.current = false;
      start.current = { x: event.clientX, y: event.clientY };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        start.current = null;
        fired.current = true;
        navigator.vibrate?.(10);
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove(event: PointerEvent) {
      const from = start.current;
      if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > MOVE_TOLERANCE) {
        cancel();
      }
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClick(event: MouseEvent) {
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
    },
    onContextMenu(event: MouseEvent) {
      // Touch: the long press itself. A mouse's right click keeps the browser's menu.
      if (start.current || fired.current) event.preventDefault();
    },
  };
}
