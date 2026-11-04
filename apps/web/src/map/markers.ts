import type { PhotoLocation } from "@photo-app/shared";
import { formatDuration } from "@/lib/format";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * A map pin (13.2h): the photo's thumbnail, with the number of photos when it stands for a
 * cluster; a single video's pin shows a play mark and its length (FR-VID-4). Plain DOM, because MapLibre places the element itself (`Marker`).
 */
export function markerElement(
  photo: PhotoLocation,
  count: number,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "relative block size-12 cursor-pointer rounded-md border-2 border-white bg-muted shadow-md outline-none focus-visible:ring-3 focus-visible:ring-ring";
  button.setAttribute(
    "aria-label",
    count > 1
      ? `${count} photos`
      : `Open ${pinKind(photo)} from ${dateFormat.format(new Date(photo.takenAt))}`,
  );
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });

  const img = document.createElement("img");
  img.src = photo.thumbUrl;
  img.alt = "";
  img.draggable = false;
  img.className = "size-full rounded-[0.25rem] object-cover";
  button.append(img);

  if (count === 1 && photo.mediaType === "video") {
    const video = document.createElement("span");
    video.setAttribute("aria-hidden", "true");
    video.className =
      "pointer-events-none absolute right-0.5 bottom-0.5 rounded bg-black/60 px-0.5 text-[0.625rem] leading-tight font-medium text-white tabular-nums";
    video.textContent = photo.durationMs === null ? "▶" : `▶ ${formatDuration(photo.durationMs)}`;
    button.append(video);
  }

  if (count > 1) {
    const badge = document.createElement("span");
    badge.className =
      "absolute -top-2 -right-2 min-w-5 rounded-full bg-primary px-1 text-center text-xs leading-5 font-medium text-primary-foreground tabular-nums";
    badge.textContent = count > 999 ? `${Math.floor(count / 1000)}k` : `${count}`;
    button.append(badge);
  }
  return button;
}

/** "photo" or "video", for labels. */
export const pinKind = (photo: Pick<PhotoLocation, "mediaType">) =>
  photo.mediaType === "video" ? "video" : "photo";
