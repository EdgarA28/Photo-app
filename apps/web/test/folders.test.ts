import { describe, expect, it } from "vitest";
import { filesFromDrop, filesFromFolderInput, readAll } from "../src/upload/folders";
import { testFile } from "./fakes";

// 13.1a: folders dropped or picked, subfolders included.

type Node = File | { name: string; children: Node[] };

/** A FileSystemEntry tree like the browser's; `readEntries` hands out `perCall` at a time. */
function entry(node: Node, perCall = 100): FileSystemEntry {
  if (node instanceof File) {
    return {
      name: node.name,
      isFile: true,
      isDirectory: false,
      file: (resolve: (file: File) => void) => setTimeout(() => resolve(node)),
    } as unknown as FileSystemEntry;
  }
  return {
    name: node.name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let next = 0;
      return {
        readEntries: (resolve: (entries: FileSystemEntry[]) => void) =>
          setTimeout(() => {
            const batch = node.children.slice(next, next + perCall);
            next += batch.length;
            resolve(batch.map((child) => entry(child, perCall)));
          }),
      };
    },
  } as unknown as FileSystemEntry;
}

/** A drop of these entries (or plain files when `entries` is false). */
function drop(nodes: Node[], { entries = true } = {}): DataTransfer {
  const files = nodes.filter((node): node is File => node instanceof File);
  return {
    files,
    items: nodes.map((node) => ({
      kind: "file",
      ...(entries && { webkitGetAsEntry: () => entry(node) }),
    })),
  } as unknown as DataTransfer;
}

const names = (files: File[]) => files.map((file) => file.name);

describe("folders (13.1a)", () => {
  it("reads a folder until readEntries comes back empty (about 100 per call)", async () => {
    const children = Array.from({ length: 250 }, (_, i) => testFile(`IMG_${i}.jpg`, 1));
    const all = await readAll(
      entry({ name: "trip", children }, 100) as unknown as FileSystemDirectoryEntry,
    );
    expect(all).toHaveLength(250);
  });

  it("walks dropped folders with their subfolders, skipping hidden files", async () => {
    const result = await filesFromDrop(
      drop([
        testFile("loose.jpg"),
        {
          name: "Photos",
          children: [
            testFile("a.jpg"),
            testFile(".DS_Store"),
            { name: "2024", children: [testFile("b.heic"), testFile("._b.heic")] },
            { name: ".thumbnails", children: [testFile("c.jpg")] },
          ],
        },
      ]),
    );
    expect(result.folder).toBe(true);
    expect(names(result.files)).toEqual(["loose.jpg", "a.jpg", "b.heic"]);
  });

  it("dropped files alone aren't a folder", async () => {
    const result = await filesFromDrop(drop([testFile("a.jpg"), testFile("b.jpg")]));
    expect(result).toEqual({ files: expect.any(Array), folder: false });
    expect(names(result.files)).toEqual(["a.jpg", "b.jpg"]);
  });

  it("falls back to the plain file list without the entry API", async () => {
    const result = await filesFromDrop(drop([testFile("a.jpg")], { entries: false }));
    expect(names(result.files)).toEqual(["a.jpg"]);
    expect(result.folder).toBe(false);
  });

  it("leaves hidden files and folders out of a picked folder", () => {
    const inFolder = (path: string) => {
      const file = testFile(path.split("/").at(-1)!);
      Object.defineProperty(file, "webkitRelativePath", { value: path });
      return file;
    };
    const files = [
      inFolder("Photos/a.jpg"),
      inFolder("Photos/.DS_Store"),
      inFolder("Photos/.trash/b.jpg"),
      inFolder("Photos/2024/c.jpg"),
    ];
    expect(names(filesFromFolderInput(files))).toEqual(["a.jpg", "c.jpg"]);
  });
});
