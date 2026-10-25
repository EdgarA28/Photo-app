// Stand-in for vite-plugin-pwa's `virtual:pwa-register/react` (aliased in vitest.config.ts): only
// the Vite plugin can generate it. Tests drive `needRefresh` and see the calls.
import { useState } from "react";
import { vi } from "vitest";
import type { RegisterSWOptions } from "vite-plugin-pwa/types";

export const pwa = {
  /** Value of `needRefresh` when the hook mounts. */
  needRefresh: false,
  updateServiceWorker: vi.fn(async (_reloadPage?: boolean) => {}),
  /** Called with the options of every `useRegisterSW` call. */
  register: vi.fn((_options?: RegisterSWOptions) => {}),
  /** Options of the last `useRegisterSW` call. */
  get options() {
    return this.register.mock.lastCall?.[0];
  },
  reset() {
    this.needRefresh = false;
    this.updateServiceWorker.mockClear();
    this.register.mockClear();
  },
};

export function useRegisterSW(options?: RegisterSWOptions) {
  pwa.register(options);
  const needRefresh = useState(pwa.needRefresh);
  const offlineReady = useState(false);
  return { needRefresh, offlineReady, updateServiceWorker: pwa.updateServiceWorker };
}
