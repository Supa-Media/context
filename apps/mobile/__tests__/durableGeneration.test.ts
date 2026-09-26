/**
 * The device keeps a note's collaboration record by path, and a path outlives
 * its document: a note renamed or moved away leaves its record behind for the
 * next note made at that name. These are the cases that record must not pin.
 */
import { describe, expect, test } from "@jest/globals";
import { memoryStore, type KeyValueStore } from "../features/offline/memory";
import { createSharedDoc } from "../features/console/presence/sharedDoc";
import { DurableCollaborationController, type CollaborationResponse } from "../features/console/collaboration/durable";

function snapshot(text: string): string {
  const doc = createSharedDoc({});
  doc.doc.transact(() => doc.text.insert(0, text), "server");
  const result = doc.snapshot();
  doc.destroy();
  return result;
}

function response(documentId: string, text: string): CollaborationResponse {
  return { documentId, update: snapshot(text), text, etag: `${documentId}-etag` };
}

function options(transport: { mint: (rejected?: string) => Promise<string>; request: (token: string, body: { path: string; documentId?: string; update?: string; replacement?: { expectedEtag: string; text: string } }) => Promise<CollaborationResponse> }, store: KeyValueStore = memoryStore()) {
  return {
    workspaceId: "workspace",
    path: "notes/a.md",
    scope: "private" as const,
    initialText: "legacy text",
    transport,
    store,
    onText: () => {},
    onState: () => {},
    online: () => true,
  };
}

async function recordsIn(store: KeyValueStore) {
  const keys = await store.keys();
  const read = async (key: string | undefined) => (key === undefined ? undefined : JSON.parse((await store.get(key)) ?? "null"));
  return {
    current: await read(keys.find((key) => !key.includes("::superseded::"))),
    superseded: await read(keys.find((key) => key.includes("::superseded::"))),
  };
}

describe("a record left by an earlier note at the same path", () => {
  test("a generation mismatch keeps pending local updates and restarts on the new note", async () => {
    let reads = 0;
    let releaseRepair: (() => void) | null = null;
    let releaseWrite: (() => void) | null = null;
    let restarts = 0;
    const store = memoryStore();
    const controller = new DurableCollaborationController({
      ...options({
        mint: async () => "grant",
        request: async (_token, body) => {
          if (body.update !== undefined) {
            return new Promise<CollaborationResponse>((resolve) => {
              releaseWrite = () => resolve(response("doc-1", "mine"));
            });
          }
          reads += 1;
          if (reads === 1) return response("doc-1", "base");
          return new Promise<CollaborationResponse>((resolve) => {
            releaseRepair = () => resolve(response("doc-2", "other"));
          });
        },
      }, store),
      onRestart: () => {
        restarts += 1;
      },
      onState: (state) => {
        if (restarts > 0) afterRestart.push(state.status);
      },
    });
    const afterRestart: string[] = [];
    await controller.start();
    controller.state.onChange("mine");
    expect(controller.state.pending).toBe(1);
    controller.repairForHook();
    await new Promise((resolve) => setTimeout(resolve, 0));
    (releaseRepair as (() => void) | null)?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restarts).toBe(1);
    const records = await recordsIn(store);
    // "mine" would erase the new note's words, so it is not carried, and is
    // not lost either: the earlier note's record is kept on the device.
    expect(records.current).toMatchObject({ documentId: "doc-2", etag: "doc-2-etag", pending: [] });
    expect(records.current.recovery).toBeUndefined();
    expect(records.superseded).toMatchObject({ documentId: "doc-1" });
    expect(records.superseded.pending).toHaveLength(1);
    // Until the replacement controller takes over, typing reaches this one,
    // whose Yjs items belong to the old note: none may join the new record.
    controller.state.onChange("mine, typed on");
    (releaseWrite as (() => void) | null)?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await recordsIn(store)).current).toMatchObject({ documentId: "doc-2", pending: [] });
    // Nor report on it: the replacement controller owns the status now.
    expect(afterRestart).toEqual([]);
    controller.stop();
  });

  test("a note made at a name used before opens as itself, and unsent typing on its title is carried", async () => {
    const store = memoryStore();
    // An earlier session typed into the stuck note, and the bucket refused every write.
    const earlier = new DurableCollaborationController(options({
      mint: async () => "grant",
      request: async (_token, body) => {
        if (body.update !== undefined) return new Promise<CollaborationResponse>(() => {});
        return response("doc-old", "");
      },
    }, store));
    await earlier.start();
    earlier.state.onChange("# use cases\n\nwhat people do with it");
    await new Promise((resolve) => setTimeout(resolve, 0));
    earlier.stop();

    const bodies: unknown[] = [];
    let bucket = "# use cases\n\n";
    let restarts = 0;
    const shown: string[] = [];
    const transport = {
      mint: async () => "grant",
      request: async (_token: string, body: { path: string; replacement?: { expectedEtag: string; text: string } }) => {
        bodies.push(body);
        if (body.replacement !== undefined) {
          if (body.replacement.expectedEtag !== "doc-new-etag") throw new Error("409");
          bucket = body.replacement.text;
        }
        return response("doc-new", bucket);
      },
    };
    const reopened = new DurableCollaborationController({
      ...options(transport, store),
      onRestart: () => {
        restarts += 1;
      },
      onText: (text) => shown.push(text),
    });
    await reopened.start();
    expect(restarts).toBe(1);
    expect(shown.at(-1)).toBe("# use cases\n\nwhat people do with it");
    expect((await recordsIn(store)).current.recovery).toEqual({
      baseline: "# use cases\n\n",
      desired: "# use cases\n\nwhat people do with it",
      baseEtag: "doc-new-etag",
    });

    // What useCollaboration does on onRestart: a fresh controller on the same record.
    const fresh = new DurableCollaborationController(options(transport, store));
    await fresh.start();
    expect(bodies.at(-1)).toEqual({
      path: "notes/a.md",
      replacement: { expectedEtag: "doc-new-etag", text: "# use cases\n\nwhat people do with it" },
    });
    expect(bucket).toBe("# use cases\n\nwhat people do with it");
    expect(fresh.state.status).toBe("saved");
    expect(fresh.state.recovery).toBeUndefined();
    reopened.stop();
    fresh.stop();
  });

  test("a draft kept for an earlier note is refused, and the note at that name is adopted", async () => {
    const store = memoryStore();
    // The replacement fails, so the draft is persisted and never sent.
    const failing = new DurableCollaborationController({
      ...options({
        mint: async () => "grant",
        request: async (_token, body) => {
          if (body.replacement !== undefined) throw new Error("503");
          return response("doc-old", "old");
        },
      }, store),
      legacyDraft: { baseline: "old", desired: "old draft", baseEtag: "c2.doc-old.r1" },
    });
    await failing.start();
    failing.stop();
    expect((await recordsIn(store)).current.recovery).toBeDefined();

    let restarts = 0;
    const reopened = new DurableCollaborationController({
      ...options({
        mint: async () => "grant",
        request: async (_token, body) => {
          if (body.replacement !== undefined) throw new Error("409");
          return response("doc-new", "a different note");
        },
      }, store),
      onRestart: () => {
        restarts += 1;
      },
    });
    await reopened.start();
    expect(restarts).toBe(1);
    const records = await recordsIn(store);
    expect(records.current).toMatchObject({ documentId: "doc-new", etag: "doc-new-etag" });
    // "old draft" would erase "a different note", so it stays with the old record.
    expect(records.current.recovery).toBeUndefined();
    expect(records.superseded.recovery).toMatchObject({ desired: "old draft" });
    reopened.stop();
  });
});
