import { useEffect, useState } from "react";
import { PINCHING_ATTRIBUTE } from "./usePinchLayer";

/** Scrolled this far (px) in one direction before the header goes or comes back. */
const THRESHOLD = 8;
/** Near the page's top the header always shows. */
const TOP_ZONE = 120;

/**
 * Whether a sticky header should be out of the way: while scrolling down, back on the way up, as
 * in Google Photos. The caller applies it (phones only, the photos get the whole screen there).
 * A pinch scrolls the page itself to hold the photo under the fingers: that doesn't count.
 */
export function useHideOnScroll(enabled: boolean) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    function onScroll() {
      const y = window.scrollY;
      if (document.querySelector(`[${PINCHING_ATTRIBUTE}]`)) {
        last = y;
        return;
      }
      if (y < TOP_ZONE) setHidden(false);
      else if (y - last > THRESHOLD) setHidden(true);
      else if (last - y > THRESHOLD) setHidden(false);
      if (Math.abs(y - last) > THRESHOLD) last = y;
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return enabled && hidden;
}
