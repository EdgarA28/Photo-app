/**
 * Zoom geometry for the viewer. The photo is drawn "contain"-fitted in a box, then transformed
 * with `translate(x, y) scale(s)` around the box's centre. Points are relative to that centre.
 */
export interface Zoom {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };
/** Below this the photo snaps back to fitting the screen. */
const SNAP_SCALE = 1.02;

/** The photo's size when it fits the box (CSS `object-fit: contain`). */
export function fitted(box: Size, photo: Size): Size {
  if (!box.width || !box.height || !photo.width || !photo.height) return { width: 0, height: 0 };
  const ratio = Math.min(box.width / photo.width, box.height / photo.height);
  return { width: photo.width * ratio, height: photo.height * ratio };
}

/**
 * How far in the photo may go: to twice its real pixels, at least 3× (small photos), at most
 * 12×. Real pixels = the original's, which loads once the preview runs out of detail.
 */
export function maxScale(fit: Size, photo: Size): number {
  if (!fit.width) return 1;
  return Math.min(12, Math.max(3, (photo.width / fit.width) * 2));
}

/** Keeps the zoomed photo covering the box where it is bigger than the box; centred otherwise. */
export function clamp(zoom: Zoom, box: Size, fit: Size, max: number): Zoom {
  const scale = Math.min(max, Math.max(1, zoom.scale));
  if (scale < SNAP_SCALE) return NO_ZOOM;
  const limitX = Math.max(0, (fit.width * scale - box.width) / 2);
  const limitY = Math.max(0, (fit.height * scale - box.height) / 2);
  return {
    scale,
    x: Math.min(limitX, Math.max(-limitX, zoom.x)),
    y: Math.min(limitY, Math.max(-limitY, zoom.y)),
  };
}

/** Zooms to `scale` keeping the photo point under `at` (relative to the box centre) in place. */
export function zoomAt(zoom: Zoom, scale: number, at: { x: number; y: number }): Zoom {
  const ratio = scale / zoom.scale;
  return { scale, x: at.x - (at.x - zoom.x) * ratio, y: at.y - (at.y - zoom.y) * ratio };
}
