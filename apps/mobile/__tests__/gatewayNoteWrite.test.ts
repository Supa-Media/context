import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import { noteWriteUrl, readWritten, writeNoteThroughGateway } from "../features/console/files/gatewayNoteWrite";
import { gatewayFirstWriter, SAVE_ROUTE_TTL_MS, saveRouteReader } from "../features/console/files/useWriteNote";
import { queuedWriteSender } from "../features/console/files/queuedWrite";
import type { PendingWrite } from "../features/offline/outbox";

/**
 * The app saving a whole note through the gateway (`gatewayNoteWrite.ts`, decided by the owner, 2026-11-24): the
 * control plane is asked only when the gateway hands the save back, a conflict is the control plane's `CONFLICT` so
 * the offline outbox parks it as before, and a save that went out and did not come back is never sent a second way.
 *
 * Sabotage, confirmed (applied, run, named case failing, reverted):
 *  1. Treating a failed fetch as `null` → "a save that went out and did not come back…" fails (the control plane saves
 *     it a second time).
 *  2. Dropping the slug requirement from `noteWriteUrl` → "a workspace with no slug known…" fails.
 *  3. Answering a conflict as `null` → "a conflict is the control plane's…" fails (the outbox would write past it).
 */

const URL_ = "https://gateway.test/@alice/files/write";
const WRITTEN = { kind: "written", path: "areas/plan.md", etag: "c2.doc.rev2", bytes: 7, conflictCheck: "conditional", forms: { created: [], occupied: [] } };

function fakeFetch(answers: { status: number; body: unknown }[], sent: { url: string; init: RequestInit }[] = []) {
  return (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    const next = answers.shift();
    if (next === undefined) throw new TypeError("offline");
    return { status: next.status, json: async () => next.body } as Response;
  }) as unknown as typeof fetch;
}

const token = async (refresh: false | { rejected: string }) => (refresh === false ? "t1" : "t2");
const save = (fetchImpl: typeof fetch, fields: { expectedEtag?: string } = { expectedEtag: "c2.doc.rev1" }) =>
  writeNoteThroughGateway({ url: URL_, token, workspaceId: "ws1", path: "areas/plan.md", text: "# Plan\n", fetchImpl, ...fields });

describe("the address", () => {
  test("is the gateway's, always named by the workspace's slug", () => {
    expect(noteWriteUrl("https://mcp.example.test/mcp", "alice")).toBe("https://mcp.example.test/@alice/files/write");
  });

  test("a workspace with no slug known is not sent to the gateway at all", () => {
    expect(noteWriteUrl("https://mcp.example.test/mcp", null)).toBeNull();
    expect(noteWriteUrl("https://mcp.example.test/mcp", "../other")).toBeNull();
    expect(noteWriteUrl("not a url", "alice")).toBeNull();
  });
});

describe("one save", () => {
  test("sends the workspace, the path, the text and the version it was typed against, and nothing else", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    expect(await save(fakeFetch([{ status: 200, body: WRITTEN }], sent))).toEqual(WRITTEN);
    expect(JSON.parse(String(sent[0].init.body))).toEqual({ workspaceId: "ws1", path: "areas/plan.md", text: "# Plan\n", expectedEtag: "c2.doc.rev1" });
    expect((sent[0].init.headers as Record<string, string>).authorization).toBe("Bearer t1");
  });

  test("a create sends no version, never an invented one", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    await save(fakeFetch([{ status: 200, body: WRITTEN }], sent), {});
    expect("expectedEtag" in JSON.parse(String(sent[0].init.body))).toBe(false);
  });

  test("a conflict is the control plane's, with its words and the note's current version", async () => {
    const answer = save(fakeFetch([{ status: 409, body: { error: "conflict", code: "CONFLICT", message: "That file changed somewhere else while you were editing it.", currentEtag: "raw-9" } }]));
    await expect(answer).rejects.toBeInstanceOf(ConvexError);
    await expect(save(fakeFetch([{ status: 409, body: { error: "conflict", code: "CONFLICT", message: "m", currentEtag: "raw-9" } }]))).rejects.toMatchObject({
      data: { code: "CONFLICT", message: "m", currentEtag: "raw-9" },
    });
  });

  test("a save the gateway hands back is the control plane's to make", async () => {
    for (const answer of [
      { status: 409, body: { error: "not_object" } },
      { status: 409, body: { error: "wrong_workspace" } },
      { status: 403, body: { error: "forbidden" } },
      { status: 400, body: { error: "invalid_request" } },
    ]) {
      expect(await save(fakeFetch([answer]))).toBeNull();
    }
  });

  test("a rotated grant is minted again once, and the save sent again once", async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    expect(await save(fakeFetch([{ status: 401, body: {} }, { status: 200, body: WRITTEN }], sent))).toEqual(WRITTEN);
    expect(sent.map((one) => (one.init.headers as Record<string, string>).authorization)).toEqual(["Bearer t1", "Bearer t2"]);
  });

  test("a save that went out and did not come back answered is a failure, never handed to the control plane", async () => {
    await expect(save(fakeFetch([]))).rejects.toBeInstanceOf(TypeError);
    await expect(save(fakeFetch([{ status: 503, body: { error: "unavailable" } }]))).rejects.toBeInstanceOf(TypeError);
    await expect(save(fakeFetch([{ status: 200, body: { kind: "written" } }]))).rejects.toBeInstanceOf(TypeError);
  });

  test("an unsafe save keeps the control plane's code", async () => {
    await expect(save(fakeFetch([{ status: 503, body: { error: "unsafe", code: "STORAGE_UNSAFE", message: "This note cannot be saved safely for collaborative editing." } }]))).rejects.toMatchObject({
      data: { code: "STORAGE_UNSAFE" },
    });
  });

  test("an answer this build cannot read is never taken as one", () => {
    expect(readWritten({ ...WRITTEN, etag: "" })).toBeNull();
    expect(readWritten({ ...WRITTEN, conflictCheck: "none" })).toBeNull();
  });
});

describe("the app's save, gateway first", () => {
  function writer(options: { enabled: boolean; slug: string | null; answers: { status: number; body: unknown }[] }) {
    const convex: unknown[] = [];
    const sent: { url: string; init: RequestInit }[] = [];
    const write = gatewayFirstWriter({
      action: (async (args: unknown) => {
        convex.push(args);
        return { ...WRITTEN, etag: "from-convex" };
      }) as never,
      route: async () => ({ on: options.enabled, slug: options.slug }),
      token: async (_workspace, refresh) => token(refresh),
      endpoint: "https://gateway.test/mcp",
      fetchImpl: fakeFetch(options.answers, sent),
    });
    return { write, convex, sent };
  }
  const args = { workspaceId: "ws1", path: "areas/plan.md", text: "# Plan\n", expectedEtag: "c2.doc.rev1" } as never;

  test("without the flag, the control plane saves it and the gateway is never asked", async () => {
    const { write, convex, sent } = writer({ enabled: false, slug: "alice", answers: [{ status: 200, body: WRITTEN }] });
    expect((await write(args)).etag).toBe("from-convex");
    expect([convex.length, sent.length]).toEqual([1, 0]);
  });

  test("with the flag, the gateway saves it and the control plane is never asked", async () => {
    const { write, convex, sent } = writer({ enabled: true, slug: "alice", answers: [{ status: 200, body: WRITTEN }] });
    expect((await write(args)).etag).toBe(WRITTEN.etag);
    expect([convex.length, sent[0].url]).toEqual([0, URL_]);
  });

  test("a sheet goes straight to the control plane, which is the only one that saves it", async () => {
    const { write, convex, sent } = writer({ enabled: true, slug: "alice", answers: [{ status: 409, body: { error: "not_object" } }] });
    await write({ workspaceId: "ws1", path: "areas/plan.csv", text: "name\n", expectedEtag: "e1" } as never);
    expect([convex.length, sent.length]).toEqual([1, 0]);
  });

  test("a workspace whose slug is not known yet is saved by the control plane", async () => {
    const { write, convex, sent } = writer({ enabled: true, slug: null, answers: [] });
    await write(args);
    expect([convex.length, sent.length]).toEqual([1, 0]);
  });

  test("handed back, the same save goes to the control plane, unchanged", async () => {
    const { write, convex } = writer({ enabled: true, slug: "alice", answers: [{ status: 409, body: { error: "not_object" } }] });
    await write(args);
    expect(convex).toEqual([args]);
  });

  test("the offline outbox parks a gateway conflict exactly as a control plane one, with the version Keep mine sends against", async () => {
    const { write, convex } = writer({
      enabled: true,
      slug: "alice",
      answers: [{ status: 409, body: { error: "conflict", code: "CONFLICT", message: "That file changed somewhere else while you were editing it.", currentEtag: "raw-9" } }],
    });
    const send = queuedWriteSender(write as never);
    const pending = { path: "areas/plan.md", text: "# Plan\n", baseEtag: "c2.doc.rev1" } as PendingWrite;
    expect(await send("ws1", pending)).toEqual({ kind: "conflict", currentEtag: "raw-9", message: "That file changed somewhere else while you were editing it." });
    expect(convex).toEqual([]);
  });

  test("the outbox's offline failure is retried later, never saved through the control plane meanwhile", async () => {
    const { write, convex } = writer({ enabled: true, slug: "alice", answers: [] });
    const send = queuedWriteSender(write as never);
    const outcome = await send("ws1", { path: "areas/plan.md", text: "# Plan\n", baseEtag: "c2.doc.rev1" } as PendingWrite);
    expect(outcome.kind).toBe("failed");
    expect(convex).toEqual([]);
  });
});

describe("whether a save goes to the gateway", () => {
  test("is asked when a save is made, at most once a minute, and each workspace answers with its own slug", async () => {
    let reads = 0;
    let clock = 0;
    const route = saveRouteReader(async () => {
      reads += 1;
      return { flags: ["files.app-saves-in-objects"], slugs: new Map([["ws1", "alice"], ["ws2", "band"]]) };
    }, () => clock);
    const [one, two] = await Promise.all([route("ws1"), route("ws2")]);
    expect([one, two]).toEqual([{ on: true, slug: "alice" }, { on: true, slug: "band" }]);
    expect(await route("ws3")).toEqual({ on: true, slug: null });
    expect(reads).toBe(1);
    clock = SAVE_ROUTE_TTL_MS + 1;
    await route("ws1");
    expect(reads).toBe(2);
  });

  test("is off when the answer cannot be had, or the flag is not the person's", async () => {
    expect(await saveRouteReader(async () => { throw new Error("offline"); })("ws1")).toEqual({ on: false, slug: null });
    expect(await saveRouteReader(async () => ({ flags: ["mail.in-notes"], slugs: new Map([["ws1", "alice"]]) }))("ws1")).toEqual({ on: false, slug: "alice" });
  });
});
