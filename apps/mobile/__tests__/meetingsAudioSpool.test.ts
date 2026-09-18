import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { currentEpoch, endSession } from "../features/offline/epoch";
import { chunkIdFor } from "../features/meetings/capture/segments";

/**
 * The phone's spool, against a file system in a `Map`.
 *
 * `spoolDevice.ts` is reached by its explicit path, because `jest.config.js`
 * resolves `.web.ts` first and the web half is `null` by design. What is
 * checked is the part a device test cannot show quickly and a mistake in which
 * costs somebody their meeting: where the files go, that nothing is ever half
 * written, that a sign-out mid-write takes the write back, and that the wipe is
 * counted rather than trusted.
 *
 * ## Sabotage record
 *
 *  - `keep` without the after-write epoch check: **"a write that a sign-out
 *    overtook is taken back"** fails.
 *  - `forgetAll` returning `{ left: 0 }` without re-listing: **"a wipe that did
 *    not land says so"** fails.
 *  - `list` not filtering names: **"only whole chunks are listed"** fails, and
 *    so did **"a disk that refuses the write keeps nothing"** — which is how a
 *    refused write was found leaving its `.part` behind. It no longer does.
 */

const mockFiles = new Map<string, Uint8Array | "moved-in">();
const mockDirs = new Set<string>();
let mockWriteHook: (() => void) | null = null;
let mockRefuseWrite = false;
let mockRefuseDelete = false;

function mockJoin(parts: unknown[]): string {
  return parts
    .map((part) => (typeof part === "string" ? part : String((part as { uri: string }).uri)))
    .join("/")
    .replace(/([^:/])\/\/+/g, "$1/");
}

const mockFileClass = class MockFile {
  readonly uri: string;
  constructor(...parts: unknown[]) {
    this.uri = mockJoin(parts);
  }
  get name(): string {
    return this.uri.slice(this.uri.lastIndexOf("/") + 1);
  }
  get exists(): boolean {
    return mockFiles.has(this.uri);
  }
  create(): void {
    mockFiles.set(this.uri, new Uint8Array());
  }
  write(bytes: Uint8Array): void {
    if (mockRefuseWrite) throw new Error("No space left on device.");
    mockFiles.set(this.uri, bytes);
    mockWriteHook?.();
  }
  move(destination: { uri: string }): void {
    const body = mockFiles.get(this.uri);
    if (body === undefined) throw new Error("No such file.");
    mockFiles.delete(this.uri);
    mockFiles.set(destination.uri, body);
    (this as { uri: string }).uri = destination.uri;
  }
  delete(): void {
    if (mockRefuseDelete) throw new Error("Refused.");
    if (!mockFiles.delete(this.uri)) throw new Error("No such file.");
  }
  async base64(): Promise<string> {
    const body = mockFiles.get(this.uri);
    if (body === undefined) throw new Error("No such file.");
    return body === "moved-in" ? "bW92ZWQ=" : Buffer.from(body).toString("base64");
  }
};

const mockDirectoryClass = class MockDirectory {
  readonly uri: string;
  constructor(...parts: unknown[]) {
    this.uri = mockJoin(parts);
  }
  get name(): string {
    return this.uri.slice(this.uri.lastIndexOf("/") + 1);
  }
  get exists(): boolean {
    return mockDirs.has(this.uri);
  }
  create(): void {
    // `intermediates: true` — every ancestor under the documents root.
    let at = this.uri;
    while (at.startsWith("file:///documents/")) {
      mockDirs.add(at);
      at = at.slice(0, at.lastIndexOf("/"));
    }
  }
  list(): unknown[] {
    const prefix = `${this.uri}/`;
    const children: unknown[] = [];
    for (const dir of mockDirs) {
      if (dir.startsWith(prefix) && !dir.slice(prefix.length).includes("/")) {
        children.push(new mockDirectoryClass(dir));
      }
    }
    for (const file of mockFiles.keys()) {
      if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) {
        children.push(new mockFileClass(file));
      }
    }
    return children;
  }
  delete(): void {
    if (mockRefuseDelete) throw new Error("Refused.");
    for (const dir of [...mockDirs]) if (dir === this.uri || dir.startsWith(`${this.uri}/`)) mockDirs.delete(dir);
    for (const file of [...mockFiles.keys()]) if (file.startsWith(`${this.uri}/`)) mockFiles.delete(file);
  }
};

jest.mock("expo-file-system", () => ({
  File: mockFileClass,
  Directory: mockDirectoryClass,
  Paths: {
    get document() {
      return new mockDirectoryClass("file:///documents");
    },
  },
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { createDeviceSpool } =
  require("../features/meetings/capture/spoolDevice.ts") as typeof import("../features/meetings/capture/spoolDevice");
/* eslint-enable @typescript-eslint/no-require-imports */

const ONE = `mtg_${"a".repeat(20)}`;
const TWO = `mtg_${"b".repeat(20)}`;
const WAV = "audio/wav";

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

beforeEach(() => {
  mockFiles.clear();
  mockDirs.clear();
  mockWriteHook = null;
  mockRefuseWrite = false;
  mockRefuseDelete = false;
});

afterEach(() => {
  mockWriteHook = null;
});

describe("where a chunk goes", () => {
  test("into the documents directory, one folder per meeting, the name its whole index", () => {
    const spool = createDeviceSpool();
    const chunk = spool.keep(
      { meetingId: ONE, index: 2, offsetMs: 40_000, durationMs: 20_000 },
      { kind: "bytes", bytes: bytes(1, 2, 3), mimeType: WAV },
      currentEpoch(),
    );

    expect(chunk).not.toBeNull();
    expect(chunk!.key).toBe(`file:///documents/meeting-audio/${ONE}/2_40000_20000.wav`);
    expect(chunk!.chunkId).toBe(chunkIdFor(ONE, 2));
    expect(chunk!.mimeType).toBe(WAV);
    // Never the cache, which the OS may empty and `audio.ts` sweeps.
    expect([...mockFiles.keys()].every((uri) => uri.startsWith("file:///documents/"))).toBe(true);
  });

  test("a finished recording is moved in, not copied", () => {
    mockFiles.set("file:///cache/ExpoAudio/recording-1.m4a", "moved-in");
    const spool = createDeviceSpool();
    const chunk = spool.keep(
      { meetingId: ONE, index: 0, offsetMs: 0, durationMs: 20_000 },
      { kind: "file", uri: "file:///cache/ExpoAudio/recording-1.m4a", mimeType: "audio/mp4" },
      currentEpoch(),
    );

    expect(chunk!.key).toMatch(/\/0_0_20000\.m4a$/);
    expect(chunk!.mimeType).toBe("audio/mp4");
    expect(mockFiles.has("file:///cache/ExpoAudio/recording-1.m4a")).toBe(false);
  });

  test("the listing is by meeting and then by index, whatever order they were kept in", () => {
    const spool = createDeviceSpool();
    const epoch = currentEpoch();
    for (const [meetingId, index] of [
      [TWO, 0],
      [ONE, 10],
      [ONE, 2],
      [ONE, 0],
    ] as const) {
      spool.keep(
        { meetingId, index, offsetMs: index * 20_000, durationMs: 20_000 },
        { kind: "bytes", bytes: bytes(index), mimeType: WAV },
        epoch,
      );
    }
    expect(spool.list().map((chunk) => chunk.chunkId)).toEqual([
      chunkIdFor(ONE, 0),
      chunkIdFor(ONE, 2),
      chunkIdFor(ONE, 10),
      chunkIdFor(TWO, 0),
    ]);
  });

  test("only whole chunks are listed", () => {
    const spool = createDeviceSpool();
    spool.keep(
      { meetingId: ONE, index: 0, offsetMs: 0, durationMs: 20_000 },
      { kind: "bytes", bytes: bytes(1), mimeType: WAV },
      currentEpoch(),
    );
    // A write a crash interrupted, a file somebody else put there, and a
    // folder that is not a meeting.
    mockFiles.set(`file:///documents/meeting-audio/${ONE}/1_20000_20000.wav.part`, bytes(9));
    mockFiles.set(`file:///documents/meeting-audio/${ONE}/notes.txt`, bytes(9));
    mockDirs.add("file:///documents/meeting-audio/not-a-meeting");
    mockFiles.set("file:///documents/meeting-audio/not-a-meeting/0_0_1.wav", bytes(9));

    expect(spool.list().map((chunk) => chunk.index)).toEqual([0]);
  });

  test("the bytes read back are the bytes kept", async () => {
    const spool = createDeviceSpool();
    const chunk = spool.keep(
      { meetingId: ONE, index: 0, offsetMs: 0, durationMs: 20_000 },
      { kind: "bytes", bytes: bytes(97, 98, 99), mimeType: WAV },
      currentEpoch(),
    );
    await expect(spool.read(chunk!)).resolves.toBe("YWJj");
  });
});

describe("nothing is half kept", () => {
  test("a disk that refuses the write keeps nothing, and says so with null", () => {
    mockRefuseWrite = true;
    const spool = createDeviceSpool();
    const chunk = spool.keep(
      { meetingId: ONE, index: 0, offsetMs: 0, durationMs: 20_000 },
      { kind: "bytes", bytes: bytes(1), mimeType: WAV },
      currentEpoch(),
    );
    expect(chunk).toBeNull();
    expect(spool.list()).toEqual([]);
    // Not the chunk, and not the half-written file beside it either.
    expect([...mockFiles.keys()].filter((uri) => uri.includes("meeting-audio"))).toEqual([]);
  });

  test("an id that is not a meeting's is refused rather than made into a path", () => {
    const spool = createDeviceSpool();
    const chunk = spool.keep(
      { meetingId: "../../escape", index: 0, offsetMs: 0, durationMs: 1 },
      { kind: "bytes", bytes: bytes(1), mimeType: WAV },
      currentEpoch(),
    );
    expect(chunk).toBeNull();
    expect(mockFiles.size).toBe(0);
  });
});

describe("a chunk belongs to the session it was recorded in", () => {
  test("a recorder still running after a sign-out writes nothing", () => {
    const spool = createDeviceSpool();
    const epoch = currentEpoch();
    endSession();
    const chunk = spool.keep(
      { meetingId: ONE, index: 0, offsetMs: 0, durationMs: 20_000 },
      { kind: "bytes", bytes: bytes(1), mimeType: WAV },
      epoch,
    );
    expect(chunk).toBeNull();
    expect(mockFiles.size).toBe(0);
  });

  test("a write that a sign-out overtook is taken back", () => {
    const spool = createDeviceSpool();
    const epoch = currentEpoch();
    // The sign-out lands while the bytes are going down.
    mockWriteHook = () => {
      endSession();
    };
    const chunk = spool.keep(
      { meetingId: ONE, index: 0, offsetMs: 0, durationMs: 20_000 },
      { kind: "bytes", bytes: bytes(1), mimeType: WAV },
      epoch,
    );
    expect(chunk).toBeNull();
    expect([...mockFiles.keys()].filter((uri) => uri.includes("meeting-audio"))).toEqual([]);
  });
});

describe("how a chunk leaves", () => {
  test("confirmed, it is deleted, and an emptied meeting folder with it", () => {
    const spool = createDeviceSpool();
    const chunk = spool.keep(
      { meetingId: ONE, index: 0, offsetMs: 0, durationMs: 20_000 },
      { kind: "bytes", bytes: bytes(1), mimeType: WAV },
      currentEpoch(),
    );
    spool.confirm(chunk!);
    expect(spool.list()).toEqual([]);
    expect(mockDirs.has(`file:///documents/meeting-audio/${ONE}`)).toBe(false);
  });

  test("a discarded meeting takes its audio and nobody else's", () => {
    const spool = createDeviceSpool();
    const epoch = currentEpoch();
    for (const meetingId of [ONE, TWO]) {
      spool.keep(
        { meetingId, index: 0, offsetMs: 0, durationMs: 20_000 },
        { kind: "bytes", bytes: bytes(1), mimeType: WAV },
        epoch,
      );
    }
    spool.forgetMeeting(ONE);
    expect(spool.list().map((chunk) => chunk.meetingId)).toEqual([TWO]);
  });

  test("sign-out takes everything, and counts what is left rather than trusting it", () => {
    const spool = createDeviceSpool();
    const epoch = currentEpoch();
    for (let index = 0; index < 5; index += 1) {
      spool.keep(
        { meetingId: ONE, index, offsetMs: index * 20_000, durationMs: 20_000 },
        { kind: "bytes", bytes: bytes(index), mimeType: WAV },
        epoch,
      );
    }
    expect(spool.forgetAll()).toEqual({ left: 0 });
    expect(spool.list()).toEqual([]);
    expect([...mockFiles.keys()].filter((uri) => uri.includes("meeting-audio"))).toEqual([]);
  });

  test("a wipe that did not land says so", () => {
    const spool = createDeviceSpool();
    spool.keep(
      { meetingId: ONE, index: 0, offsetMs: 0, durationMs: 20_000 },
      { kind: "bytes", bytes: bytes(1), mimeType: WAV },
      currentEpoch(),
    );
    mockRefuseDelete = true;
    expect(spool.forgetAll().left).toBeGreaterThan(0);
  });
});
