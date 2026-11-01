import { useSyncExternalStore } from "react";

/** The parts of the Network Information API used here (Chromium only; absent elsewhere). */
interface NetworkInformationLike extends EventTarget {
  type?: string;
  saveData?: boolean;
}

/**
 * Why data use matters on this connection (13.1l): `cellular` on mobile data, `saveData` when the
 * user turned on Data Saver; `null` on Wi-Fi, wired, or when the browser doesn't say (Firefox,
 * Safari, desktop Chrome report no connection type).
 */
export type MeteredReason = "cellular" | "saveData";

const connection = () =>
  (navigator as { connection?: NetworkInformationLike }).connection ?? undefined;

export function meteredConnection(): MeteredReason | null {
  const info = connection();
  if (info?.type === "cellular") return "cellular";
  if (info?.saveData === true) return "saveData";
  return null;
}

const subscribe = (listener: () => void) => {
  const info = connection();
  info?.addEventListener("change", listener);
  return () => info?.removeEventListener("change", listener);
};

/** The connection's `MeteredReason`, kept current when it changes (e.g. leaving Wi-Fi). */
export function useMeteredConnection(): MeteredReason | null {
  return useSyncExternalStore(subscribe, meteredConnection, () => null);
}
