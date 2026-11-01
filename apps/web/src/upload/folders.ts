/**
 * Files from a dropped or picked folder (13.1a, FR-UP-1): subfolders included, hidden files
 * (".DS_Store", "._IMG_1.jpg" from macOS) left out, since they are never photos and would only
 * fill the "not added" list.
 */

export interface PickedFiles {
  files: File[];
  /** At least one folder was in it: always a large batch (13.1c). */
  folder: boolean;
  /** The (first) dropped folder's name, to name the batch (13.1f). */
  label?: string | null;
}

/** Hidden files and system leftovers, skipped without a word. */
export const isHidden = (name: string) => name.startsWith(".");

/** The files of a folder picked with `<input webkitdirectory>`: the browser already walked it. */
export function filesFromFolderInput(files: FileList | File[]): File[] {
  return [...files].filter((file) => {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    return !path.split("/").some(isHidden);
  });
}

/**
 * The files of a drop: dropped files as they are, dropped folders walked recursively
 * (`webkitGetAsEntry`, every Chromium/Firefox/Safari). The entries must be taken while the drop
 * event runs (the item list is emptied afterwards), so call this synchronously in the handler;
 * the walk itself is asynchronous.
 */
export function filesFromDrop(dataTransfer: DataTransfer): Promise<PickedFiles> {
  const items = [...(dataTransfer.items ?? [])].filter((item) => item.kind === "file");
  const entries = items.map((item) => item.webkitGetAsEntry?.() ?? null);
  // No entry API (or nothing to walk): the plain file list.
  if (!entries.length || entries.some((entry) => entry === null)) {
    return Promise.resolve({ files: [...dataTransfer.files], folder: false });
  }
  return walk(entries as FileSystemEntry[]);
}

async function walk(entries: FileSystemEntry[]): Promise<PickedFiles> {
  const files: File[] = [];
  let folder = false;
  const label = entries.find((entry) => entry.isDirectory && !isHidden(entry.name))?.name ?? null;
  const visit = async (entry: FileSystemEntry): Promise<void> => {
    if (isHidden(entry.name)) return;
    if (entry.isFile) {
      files.push(await fileOf(entry as FileSystemFileEntry));
    } else if (entry.isDirectory) {
      folder = true;
      for (const child of await readAll(entry as FileSystemDirectoryEntry)) await visit(child);
    }
  };
  for (const entry of entries) await visit(entry);
  return { files, folder, label };
}

const fileOf = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));

/** Every entry of a folder: `readEntries` gives ~100 per call, so it is called until empty. */
export async function readAll(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = directory.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) return all;
    all.push(...batch);
  }
}
