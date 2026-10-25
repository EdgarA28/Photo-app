const key = (userId: string) => `photo-app.username-prompt.${userId}`;

/**
 * "Later" on the first-login username prompt (8.15), remembered per account on this device. Not
 * private data, so logout keeps it; otherwise the prompt would return on every login. Storage can
 * be unavailable (private mode, blocked site data): then the prompt may simply show again.
 */
export function isPromptSkipped(userId: string, storage: Storage = localStorage): boolean {
  try {
    return storage.getItem(key(userId)) === "skipped";
  } catch {
    return false;
  }
}

export function skipPrompt(userId: string, storage: Storage = localStorage): void {
  try {
    storage.setItem(key(userId), "skipped");
  } catch {
    // Not remembered; at worst the prompt shows once more.
  }
}
