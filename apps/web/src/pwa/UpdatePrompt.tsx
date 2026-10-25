import { RefreshCw } from "lucide-react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { Button } from "@/components/ui/button";

/** An installed app can stay open for days without a navigation that would check for updates. */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Registers the service worker (9.4, §12.5) and offers a new version once it's ready (FR-PWA-3).
 * `registerType: 'prompt'`: a new worker waits until the user reloads, so an open page never
 * switches to new code mid-session (its old chunks stay in the old precache until then).
 * "Reload" activates the new worker and reloads; an interrupted upload resumes from the
 * IndexedDB queue (FR-UP-5). "Later" hides the prompt; the new version starts on the next launch.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      setInterval(() => {
        if (navigator.onLine) {
          registration.update().catch(() => {
            // Network trouble; the next check tries again.
          });
        }
      }, UPDATE_CHECK_INTERVAL_MS);
    },
    onRegisterError(error) {
      // The app works without it, just not offline.
      console.warn("Service worker registration failed", error);
    },
  });

  if (!needRefresh) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-4 top-[calc(1rem+env(safe-area-inset-top))] z-50 mx-auto flex max-w-md items-center gap-3 rounded-xl border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
    >
      <RefreshCw aria-hidden className="size-4 shrink-0 text-safelight" />
      <p className="flex-1">Update available.</p>
      <Button size="sm" variant="ghost" onClick={() => setNeedRefresh(false)}>
        Later
      </Button>
      <Button size="sm" onClick={() => void updateServiceWorker(true)}>
        Reload
      </Button>
    </div>
  );
}
