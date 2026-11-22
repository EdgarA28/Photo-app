/**
 * The Picker link of an import started in this tab (13.5g). `GET /imports/{id}` doesn't return it,
 * so the progress page can only offer "Choose photos" where the import began; elsewhere it shows
 * the progress only. sessionStorage: this tab, gone when it closes.
 */
const PREFIX = "photo-app:google-import-picker:";

type Store = Pick<Storage, "getItem" | "setItem">;

export function savePickerUri(
  importId: string,
  pickerUri: string,
  storage: Store = sessionStorage,
) {
  storage.setItem(PREFIX + importId, pickerUri);
}

export function pickerUriOf(importId: string, storage: Store = sessionStorage): string | null {
  const value = storage.getItem(PREFIX + importId);
  // Only Google's https link is ever opened.
  return value?.startsWith("https://") ? value : null;
}

/**
 * Opens Google's picker in a new window from the user's tap (popup blockers, §11.5); `/autoclose`
 * makes Google close it when the user is done. On Android it may open the Google Photos app.
 */
export function openPicker(pickerUri: string, open: typeof window.open = window.open.bind(window)) {
  open(`${pickerUri}/autoclose`, "_blank", "noopener");
}
