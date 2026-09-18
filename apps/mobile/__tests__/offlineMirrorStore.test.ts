import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { bodyFileName, segmentName } from "../features/offline/mirrorPath";
import { currentEpoch, endSession } from "../features/offline/epoch";

/**
 * The mirror's storage: where note bodies go on a device, and the two
 * properties of that which are security rather than tidiness.
 *
 *  - **A note path never becomes a filesystem path.** A bucket key is written
 *    by whoever can write to the bucket — Obsidian, an AI client, a teammate,
 *    somebody with the bucket's own console — and `../../Library/x` is a legal
 *    key in S3. Joined onto the app's document directory it would be a write
 *    outside the mirror, into whatever the app keeps beside it. So every
 *    segment is encoded to an alphabet with no separator and no dot, and the
 *    fake filesystem below *resolves* `..` the way a real one does: a raw join
 *    escapes the root and the test sees it.
 *  - **A write from a session that has ended does not land.** The same barrier
 *    `epoch.ts` keeps for the key-value store, kept here inside the store's own
 *    queue, so a sync still running when somebody signs out cannot put a note
 *    body back behind the clear.
 *
 * Sabotage-checked: joining `path` onto the directory unencoded fails "a
 * traversal key stays inside the mirror"; dropping the epoch comparison in
 * `guardMirror` fails "a write queued behind a sign-out is dropped".
 */

/* ------------------------------- the encoding ------------------------------ */

describe("a note path becomes one filename, never a path", () => {
  const hostile = [
    "../../../Library/Preferences/evil.md",
    "/etc/passwd",
    "..",
    ".",
    "",
    "a/../../b.md",
    "C:\\Windows\\system32.md",
    "notes/..%2F..%2Fx.md",
    "~/x.md",
    "1-projects/ünïcode 😀.md",
  ];

  test.each(hostile)("%j encodes to a single safe segment", (path) => {
    const name = bodyFileName(path);
    expect(name).toMatch(/^[A-Za-z0-9_%~-]+$/);
    expect(name).not.toContain("/");
    expect(name).not.toContain(".");
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThanOrEqual(200);
  });

  test("distinct paths never share a filename, including the long ones", () => {
    const paths = [
      "a.md",
      "a%2Emd",
      "A.md",
      "a/b.md",
      "a_b.md",
      "a%2Fb.md",
      "x".repeat(300) + ".md",
      "x".repeat(300) + ".mdx",
      "y".repeat(300),
    ];
    const names = new Set(paths.map(bodyFileName));
    expect(names.size).toBe(paths.length);
  });

  test("a long path is hashed into a bounded name a short one can never take", () => {
    const long = bodyFileName("folder/".repeat(60) + "note.md");
    expect(long.length).toBeLessThanOrEqual(200);
    // `~` is outside the short form's alphabet, so the two forms cannot collide.
    expect(long.startsWith("~")).toBe(true);
    expect(bodyFileName("note.md").includes("~")).toBe(false);
  });

  test("a workspace id is encoded by the same rule", () => {
    expect(segmentName("../w1")).not.toContain("/");
    expect(segmentName("../w1")).not.toContain(".");
  });
});

/* ------------------------------ the fake disk ------------------------------ */

/**
 * Just enough of `expo-file-system`'s `File`/`Directory` surface, over a map of
 * absolute paths — and it **normalises** the joined path the way a real
 * filesystem does, so `..` in a name really does climb out of the directory.
 */
const mockDisk = new Map<string, string>();
const mockDirs = new Set<string>();

function mockResolve(parts: unknown[]): string {
  const joined = parts
    .map((part) => (typeof part === "string" ? part : String((part as { uri: string }).uri)))
    .join("/")
    .replace(/^file:\/\//, "");
  const out: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `file:///${out.join("/")}`;
}

jest.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      this.uri = mockResolve(parts);
    }
    get name(): string {
      return this.uri.slice(this.uri.lastIndexOf("/") + 1);
    }
    get exists(): boolean {
      return mockDirs.has(this.uri);
    }
    create(): void {
      let at = "file://";
      for (const segment of this.uri.replace(/^file:\/\//, "").split("/").filter(Boolean)) {
        at = `${at}/${segment}`;
        mockDirs.add(at);
      }
    }
    delete(): void {
      for (const dir of [...mockDirs]) if (dir === this.uri || dir.startsWith(`${this.uri}/`)) mockDirs.delete(dir);
      for (const file of [...mockDisk.keys()]) if (file.startsWith(`${this.uri}/`)) mockDisk.delete(file);
    }
    list(): unknown[] {
      const children = new Map<string, unknown>();
      for (const dir of mockDirs) {
        if (dir.startsWith(`${this.uri}/`) && !dir.slice(this.uri.length + 1).includes("/")) {
          children.set(dir, new Directory(dir));
        }
      }
      for (const file of mockDisk.keys()) {
        if (file.startsWith(`${this.uri}/`) && !file.slice(this.uri.length + 1).includes("/")) {
          children.set(file, new File(file));
        }
      }
      return [...children.values()];
    }
  }
  class File {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      this.uri = mockResolve(parts);
    }
    get name(): string {
      return this.uri.slice(this.uri.lastIndexOf("/") + 1);
    }
    get exists(): boolean {
      return mockDisk.has(this.uri);
    }
    write(text: string): void {
      const parent = this.uri.slice(0, this.uri.lastIndexOf("/"));
      if (!mockDirs.has(parent)) throw new Error(`no directory ${parent}`);
      mockDisk.set(this.uri, text);
    }
    async text(): Promise<string> {
      const held = mockDisk.get(this.uri);
      if (held === undefined) throw new Error("missing");
      return held;
    }
    delete(): void {
      if (!mockDisk.delete(this.uri)) throw new Error("missing");
    }
  }
  return { File, Directory, Paths: { document: new Directory("file:///doc") } };
});

/* eslint-disable @typescript-eslint/no-require-imports */
const native =
  require("../features/offline/mirrorStore.ts") as typeof import("../features/offline/mirrorStore");
const core =
  require("../features/offline/mirrorStoreCore") as typeof import("../features/offline/mirrorStoreCore");
/* eslint-enable @typescript-eslint/no-require-imports */

const ROOT = "file:///doc/context-offline/v1";

beforeEach(() => {
  mockDisk.clear();
  mockDirs.clear();
  mockDirs.add("file:///doc");
});

describe("the native store keeps everything under its own directory", () => {
  test("a traversal key stays inside the mirror", async () => {
    const store = native.fileMirrorStore();
    const epoch = currentEpoch();
    for (const path of ["../../../escape.md", "/abs/olute.md", "a/../../../../b.md", ".."]) {
      await store.writeBody(epoch, "private", "w1", "current", path, `body of ${path}`);
    }
    await store.writeIndex(epoch, "private", "../../w2", "{}");
    expect(mockDisk.size).toBeGreaterThan(0);
    for (const file of mockDisk.keys()) expect(file.startsWith(`${ROOT}/`)).toBe(true);
    // And each reads back as the note it was written for.
    expect(await store.readBody("private", "w1", "current", "../../../escape.md")).toBe(
      "body of ../../../escape.md",
    );
  });

  test("the layout is scope / workspace / slot / encoded name", async () => {
    const store = native.fileMirrorStore();
    await store.writeBody(currentEpoch(), "team", "w1", "current", "1-projects/a.md", "A");
    await store.writeBody(currentEpoch(), "team", "w1", "base", "1-projects/a.md", "A0");
    await store.writeIndex(currentEpoch(), "team", "w1", "{\"v\":1}");
    const name = bodyFileName("1-projects/a.md");
    expect(mockDisk.get(`${ROOT}/team/w1/current/${name}`)).toBe("A");
    expect(mockDisk.get(`${ROOT}/team/w1/base/${name}`)).toBe("A0");
    expect(mockDisk.get(`${ROOT}/team/w1/index.json`)).toBe("{\"v\":1}");
  });

  conformance(() => native.fileMirrorStore());
});

describe("the in-memory store", () => {
  conformance(() => core.memoryMirrorStore());
});

/**
 * Every implementation answers the same way. The web one is `kvMirrorStore`
 * over IndexedDB, and `memoryMirrorStore` is `kvMirrorStore` over a `Map`, so
 * this suite reaches the web layout too — only the IndexedDB calls themselves
 * are covered separately, in `offlineMirrorIdb.test.ts`.
 */
function conformance(open: () => import("../features/offline/mirrorStoreCore").MirrorStore): void {
  test("bodies and indexes round-trip, per scope and per workspace", async () => {
    const store = open();
    const epoch = currentEpoch();
    await store.writeBody(epoch, "private", "w1", "current", "a.md", "private A");
    await store.writeBody(epoch, "team", "w1", "current", "a.md", "team A");
    await store.writeBody(epoch, "private", "w2", "current", "a.md", "other context");
    expect(await store.readBody("private", "w1", "current", "a.md")).toBe("private A");
    expect(await store.readBody("team", "w1", "current", "a.md")).toBe("team A");
    expect(await store.readBody("private", "w2", "current", "a.md")).toBe("other context");
    expect(await store.readBody("private", "w1", "base", "a.md")).toBeNull();
    expect(await store.readIndex("private", "w1")).toBeNull();
    await store.writeIndex(epoch, "private", "w1", "{}");
    expect(await store.readIndex("private", "w1")).toBe("{}");
  });

  test("a write queued behind a sign-out is dropped", async () => {
    const store = open();
    const epoch = currentEpoch();
    await store.writeBody(epoch, "private", "w1", "current", "kept.md", "before");
    // A write made from the old session, still in flight when the clear runs.
    endSession();
    const clearing = store.clearAll();
    const late = store.writeBody(epoch, "private", "w1", "current", "late.md", "after");
    const lateIndex = store.writeIndex(epoch, "private", "w1", "{\"late\":true}");
    await Promise.all([clearing, late, lateIndex]);
    expect(await late).toBe(false);
    expect(await store.readBody("private", "w1", "current", "kept.md")).toBeNull();
    expect(await store.readBody("private", "w1", "current", "late.md")).toBeNull();
    expect(await store.readIndex("private", "w1")).toBeNull();
    expect(await store.roots()).toEqual([]);
    // A new session writes normally: the barrier re-arms by itself.
    expect(await store.writeBody(currentEpoch(), "private", "w1", "current", "new.md", "x")).toBe(
      true,
    );
  });

  test("forgetting a workspace takes every scope of it and nothing else", async () => {
    const store = open();
    const epoch = currentEpoch();
    await store.writeBody(epoch, "private", "w1", "current", "a.md", "1");
    await store.writeIndex(epoch, "team", "w1", "{}");
    await store.writeBody(epoch, "private", "w2", "current", "a.md", "2");
    await store.writeIndex(epoch, "private", "w2", "{}");
    await store.forgetWorkspace("w1");
    expect(await store.readBody("private", "w1", "current", "a.md")).toBeNull();
    expect(await store.readIndex("team", "w1")).toBeNull();
    expect(await store.readBody("private", "w2", "current", "a.md")).toBe("2");
    expect((await store.roots()).map((root) => root.workspaceId)).toEqual(["w2"]);
  });
}
