import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { ConvexError } from "convex/values";

import {
  OBJECT_FILE_OP_TIMEOUT_MS,
  objectMove,
  objectRestore,
  objectCopy,
  objectDuplicate,
  objectTrash,
  type ObjectMoveTarget,
} from "../features/console/files/objectFileOps";
import { setObjectServes } from "../features/console/files/fileBrowser/objectServes";

/**
 * Trash and restore sent straight to the gateway when the workspace's object
 * serves its tree (`features/console/files/objectFileOps.ts`).
 *
 * What the module answers, and what the caller does with it:
 *  - 200: the moved result, the same shape the Convex action returns;
 *  - `null` (fall back to the Convex action): the object does not serve the
 *    workspace, the origin is unknown, a mint failed, the network failed or
 *    timed out, a 5xx, a 401 that a re-mint did not cure, or an answer nobody
 *    listed;
 *  - a thrown `ConvexError` with the file action's own code (the same one the
 *    Convex action would have thrown): a refusal, which must not fall back.
 *
 * Sabotage: make the network-failure catch rethrow instead of returning `null`,
 * or make `409 not_object` throw, and the matching cases below fail.
 */

const WS = "w1";
const ORIGIN = "https://gateway.example";
const TRASH_URL = `${ORIGIN}/files/trash`;
const RESTORE_URL = `${ORIGIN}/files/restore`;

type Reply = { status: number; body?: unknown } | "network" | "hang";

const realFetch = globalThis.fetch;
let replies: Reply[] = [];
type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
let sent: { url: string; init: FetchInit }[] = [];

function fakeResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  replies = [];
  sent = [];
  setObjectServes(WS, true);
  globalThis.fetch = jest.fn(async (url: string | URL, init?: FetchInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    const next = replies.shift();
    if (next === undefined) throw new Error("no reply scripted");
    if (next === "network") throw new TypeError("Failed to fetch");
    if (next === "hang") {
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    return fakeResponse(next.status, next.body);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  setObjectServes(WS, false);
});

function target(over: Partial<ObjectMoveTarget> = {}): ObjectMoveTarget & { mint: jest.Mock<(rejected?: string) => Promise<string>> } {
  return {
    workspaceId: WS,
    origin: ORIGIN,
    mint: jest.fn(async (_rejected?: string) => "tok-1"),
    ...over,
  } as ObjectMoveTarget & { mint: jest.Mock<(rejected?: string) => Promise<string>> };
}

async function refusalOf(promise: Promise<unknown>): Promise<ConvexError<{ code: string; message: string; currentEtag?: string }>> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    return error as ConvexError<{ code: string; message: string; currentEtag?: string }>;
  }
  throw new Error("expected a refusal");
}

const MOVED = { kind: "moved", from: "1-projects/a.md", to: ".context/trash/s/1-projects/a.md", paths: ["1-projects/a.md"], etag: "e9" };

describe("trash through the gateway", () => {
  test("a 200 returns the moved result, sent as the collaboration route is", async () => {
    replies = [{ status: 200, body: MOVED }];
    const t = target();
    await expect(objectTrash(t, { path: "1-projects/a.md", expectedEtag: "e1" })).resolves.toEqual(MOVED);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(TRASH_URL);
    expect(sent[0]!.init.method).toBe("POST");
    expect(sent[0]!.init.headers).toEqual({ authorization: "Bearer tok-1", "content-type": "application/json" });
    expect(JSON.parse(sent[0]!.init.body!)).toEqual({ path: "1-projects/a.md", expectedEtag: "e1" });
    expect(t.mint).toHaveBeenCalledTimes(1);
  });

  test("a workspace named by the caller is in the address, so the gateway never reads files as a workspace", async () => {
    // 2026-11-09: the bare `/files/trash` was read by the gateway as a workspace called `files`, and every delete,
    // rename and duplicate answered "not there any more". The app now names its workspace in the address.
    replies = [{ status: 200, body: MOVED }, { status: 200, body: MOVED }, { status: 200, body: MOVED }];
    await objectTrash(target({ slug: "seyi" }), { path: "1-projects/a.md" });
    await objectMove(target({ slug: "seyi" }), { from: "1-projects/a.md", to: "1-projects/b.md" });
    // A name that is not a workspace name's shape is never put in the address: the bare one is sent.
    await objectTrash(target({ slug: "../x" }), { path: "1-projects/a.md" });
    expect(sent.map((call) => call.url)).toEqual([`${ORIGIN}/@seyi/files/trash`, `${ORIGIN}/@seyi/files/move`, TRASH_URL]);
  });

  test("409 not_object falls back: null, not a refusal", async () => {
    replies = [{ status: 409, body: { error: "not_object" } }];
    await expect(objectTrash(target(), { path: "1-projects/a.md" })).resolves.toBeNull();
  });

  test("a network failure falls back", async () => {
    replies = ["network"];
    await expect(objectTrash(target(), { path: "1-projects/a.md" })).resolves.toBeNull();
  });

  test("a 5xx falls back", async () => {
    replies = [{ status: 503, body: { error: "unavailable" } }];
    await expect(objectTrash(target(), { path: "1-projects/a.md" })).resolves.toBeNull();
  });

  test("503 mirror_pending is a refusal to retry, not a fallback: the trash already happened in the object", async () => {
    replies = [{ status: 503, body: { error: "mirror_pending" } }];
    const error = await refusalOf(objectTrash(target(), { path: "1-projects/a.md" }));
    expect(error.data.code).toBe("SYNCING");
    expect(error.data.message).toMatch(/syncing/i);
    expect(sent).toHaveLength(1);
  });

  test("503 unavailable still falls back, unlike mirror_pending", async () => {
    replies = [{ status: 503, body: { error: "unavailable" } }];
    await expect(objectTrash(target(), { path: "1-projects/a.md" })).resolves.toBeNull();
  });

  test("a request that hangs is cut off after the deadline and falls back", async () => {
    replies = ["hang"];
    expect(OBJECT_FILE_OP_TIMEOUT_MS).toBe(10_000);
    await expect(objectTrash(target({ timeoutMs: 10 }), { path: "1-projects/a.md" })).resolves.toBeNull();
    expect(sent[0]!.init.signal?.aborted).toBe(true);
  });

  test("404 not_found is surfaced as the file action's FILE_NOT_FOUND, not a fallback", async () => {
    replies = [{ status: 404, body: { error: "not_found" } }];
    const error = await refusalOf(objectTrash(target(), { path: "1-projects/gone.md" }));
    expect(error.data.code).toBe("FILE_NOT_FOUND");
    expect(error.data.message.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
  });

  test("409 changed is surfaced as CONFLICT with the current etag, not a fallback", async () => {
    replies = [{ status: 409, body: { error: "changed", currentEtag: "e7" } }];
    const error = await refusalOf(objectTrash(target(), { path: "1-projects/a.md", expectedEtag: "e1" }));
    expect(error.data.code).toBe("CONFLICT");
    expect(error.data.currentEtag).toBe("e7");
    expect(sent).toHaveLength(1);
  });

  test("400 invalid_path and 403 forbidden are refusals too", async () => {
    replies = [{ status: 400, body: { error: "invalid_path" } }];
    expect((await refusalOf(objectTrash(target(), { path: "../x" }))).data.code).toBe("PATH_INVALID");
    replies = [{ status: 403, body: { error: "forbidden" } }];
    expect((await refusalOf(objectTrash(target(), { path: "1-projects/a.md" }))).data.code).toBe("FORBIDDEN");
    expect(sent).toHaveLength(2);
  });

  test("a 401 re-mints with the rejected token and retries once", async () => {
    replies = [{ status: 401, body: { error: "invalid_token" } }, { status: 200, body: MOVED }];
    const t = target({ mint: jest.fn(async (rejected?: string) => (rejected === undefined ? "tok-1" : "tok-2")) });
    await expect(objectTrash(t, { path: "1-projects/a.md" })).resolves.toEqual(MOVED);
    expect(t.mint).toHaveBeenNthCalledWith(2, "tok-1");
    expect(sent[1]!.init.headers).toMatchObject({ authorization: "Bearer tok-2" });
  });

  test("a 401 that survives the re-mint falls back", async () => {
    replies = [{ status: 401, body: {} }, { status: 401, body: {} }];
    await expect(objectTrash(target(), { path: "1-projects/a.md" })).resolves.toBeNull();
    expect(sent).toHaveLength(2);
  });

  test("a workspace the object does not serve never calls fetch or mints", async () => {
    setObjectServes(WS, false);
    const t = target();
    await expect(objectTrash(t, { path: "1-projects/a.md" })).resolves.toBeNull();
    await expect(objectRestore(t, { from: ".context/trash/s/a.md", to: "a.md" })).resolves.toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(t.mint).not.toHaveBeenCalled();
  });

  test("a workspace with no gateway origin never calls fetch", async () => {
    await expect(objectTrash(target({ origin: null }), { path: "1-projects/a.md" })).resolves.toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("a mint that fails falls back without a request", async () => {
    const t = target({ mint: jest.fn(async () => { throw new Error("Not authenticated"); }) });
    await expect(objectTrash(t, { path: "1-projects/a.md" })).resolves.toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("restore through the gateway", () => {
  test("a 200 returns the moved result, posted to /files/restore", async () => {
    replies = [{ status: 200, body: { kind: "moved", from: ".context/trash/s/a.md", to: "a.md", paths: ["a.md"] } }];
    await expect(objectRestore(target(), { from: ".context/trash/s/a.md", to: "a.md" })).resolves.toEqual({
      kind: "moved",
      from: ".context/trash/s/a.md",
      to: "a.md",
      paths: ["a.md"],
    });
    expect(sent[0]!.url).toBe(RESTORE_URL);
    expect(JSON.parse(sent[0]!.init.body!)).toEqual({ from: ".context/trash/s/a.md", to: "a.md" });
  });

  test("409 not_object and a network failure fall back", async () => {
    replies = [{ status: 409, body: { error: "not_object" } }];
    await expect(objectRestore(target(), { from: "x", to: "y" })).resolves.toBeNull();
    replies = ["network"];
    await expect(objectRestore(target(), { from: "x", to: "y" })).resolves.toBeNull();
  });

  test("409 taken is surfaced as DESTINATION_EXISTS, not a fallback", async () => {
    replies = [{ status: 409, body: { error: "taken" } }];
    const error = await refusalOf(objectRestore(target(), { from: ".context/trash/s/a.md", to: "a.md" }));
    expect(error.data.code).toBe("DESTINATION_EXISTS");
    expect(sent).toHaveLength(1);
  });
});

describe("moves through the gateway", () => {
  test("a 200 returns the moved result, posted to /files/move with the expected etag", async () => {
    const moved = { kind: "moved", from: "1-projects/a.md", to: "1-projects/b.md", paths: ["1-projects/b.md"], etag: "e2" };
    replies = [{ status: 200, body: moved }];
    await expect(objectMove(target(), { from: "1-projects/a.md", to: "1-projects/b.md", expectedEtag: "e2" })).resolves.toEqual(moved);
    expect(sent[0]!.url).toBe(`${ORIGIN}/files/move`);
    expect(JSON.parse(sent[0]!.init.body!)).toEqual({ from: "1-projects/a.md", to: "1-projects/b.md", expectedEtag: "e2" });
  });

  test("a move the object leaves to Convex (409 not_object) falls back", async () => {
    replies = [{ status: 409, body: { error: "not_object" } }];
    await expect(objectMove(target(), { from: "a.md", to: "b.md" })).resolves.toBeNull();
  });

  test("409 changed is CONFLICT with the current etag", async () => {
    replies = [{ status: 409, body: { error: "changed", currentEtag: "e3" } }];
    const error = await refusalOf(objectMove(target(), { from: "a.md", to: "b.md", expectedEtag: "e1" }));
    expect(error.data).toMatchObject({ code: "CONFLICT", currentEtag: "e3" });
  });
});

describe("copies and duplicates through the gateway", () => {
  const COPIED = { kind: "moved", from: "1-projects/a.md", to: "1-projects/b.md", paths: ["1-projects/b.md"], etag: "e4" };

  test("a 200 copy returns the moved object, posted to /files/copy with exactly the body given", async () => {
    replies = [{ status: 200, body: COPIED }];
    const t = target();
    await expect(objectCopy(t, { from: "1-projects/a.md", to: "1-projects/b.md" })).resolves.toEqual(COPIED);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${ORIGIN}/files/copy`);
    expect(sent[0]!.init.method).toBe("POST");
    expect(sent[0]!.init.headers).toEqual({ authorization: "Bearer tok-1", "content-type": "application/json" });
    expect(JSON.parse(sent[0]!.init.body!)).toEqual({ from: "1-projects/a.md", to: "1-projects/b.md" });
    expect(t.mint).toHaveBeenCalledTimes(1);
  });

  test("a 200 duplicate returns the moved object, posted to /files/duplicate with exactly the body given", async () => {
    const duplicated = { kind: "moved", from: "1-projects/a.md", to: "1-projects/a copy.md", paths: ["1-projects/a copy.md"] };
    replies = [{ status: 200, body: duplicated }];
    const t = target();
    await expect(objectDuplicate(t, { path: "1-projects/a.md" })).resolves.toEqual(duplicated);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${ORIGIN}/files/duplicate`);
    expect(sent[0]!.init.method).toBe("POST");
    expect(sent[0]!.init.headers).toEqual({ authorization: "Bearer tok-1", "content-type": "application/json" });
    expect(JSON.parse(sent[0]!.init.body!)).toEqual({ path: "1-projects/a.md" });
    expect(t.mint).toHaveBeenCalledTimes(1);
  });

  test("409 not_object returns null for copy and duplicate, not a refusal", async () => {
    replies = [{ status: 409, body: { error: "not_object" } }];
    await expect(objectCopy(target(), { from: "1-projects/a.md", to: "b.md" })).resolves.toBeNull();
    replies = [{ status: 409, body: { error: "not_object" } }];
    await expect(objectDuplicate(target(), { path: "1-projects/a.md" })).resolves.toBeNull();
  });

  test("409 taken throws DESTINATION_EXISTS for copy", async () => {
    replies = [{ status: 409, body: { error: "taken" } }];
    const error = await refusalOf(objectCopy(target(), { from: "1-projects/a.md", to: "1-projects/b.md" }));
    expect(error.data.code).toBe("DESTINATION_EXISTS");
    expect(error.data.message.length).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
  });

  test("404 not_found throws FILE_NOT_FOUND for copy", async () => {
    replies = [{ status: 404, body: { error: "not_found" } }];
    const error = await refusalOf(objectCopy(target(), { from: "1-projects/gone.md", to: "b.md" }));
    expect(error.data.code).toBe("FILE_NOT_FOUND");
    expect(sent).toHaveLength(1);
  });

  test("403 forbidden throws FORBIDDEN for copy and duplicate", async () => {
    replies = [{ status: 403, body: { error: "forbidden" } }];
    expect((await refusalOf(objectCopy(target(), { from: "a.md", to: "b.md" }))).data.code).toBe("FORBIDDEN");
    replies = [{ status: 403, body: { error: "forbidden" } }];
    expect((await refusalOf(objectDuplicate(target(), { path: "a.md" }))).data.code).toBe("FORBIDDEN");
    expect(sent).toHaveLength(2);
  });

  test("503 unavailable returns null for copy and duplicate", async () => {
    replies = [{ status: 503, body: { error: "unavailable" } }];
    await expect(objectCopy(target(), { from: "a.md", to: "b.md" })).resolves.toBeNull();
    replies = [{ status: 503, body: { error: "unavailable" } }];
    await expect(objectDuplicate(target(), { path: "a.md" })).resolves.toBeNull();
  });

  test("a workspace the object does not serve returns null without calling fetch", async () => {
    setObjectServes(WS, false);
    const t = target();
    await expect(objectCopy(t, { from: "a.md", to: "b.md" })).resolves.toBeNull();
    await expect(objectDuplicate(t, { path: "a.md" })).resolves.toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(t.mint).not.toHaveBeenCalled();
  });
});
