declare const __APP_VERSION__: string;

/**
 * Which build is running (`<commit>[+] <UTC time>`, "+" = uncommitted changes), shown in Settings:
 * an installed app keeps its version until the user reloads (9.4), so tests need to know.
 * Set by `define` in vite.config.ts.
 */
export const APP_VERSION = __APP_VERSION__;
