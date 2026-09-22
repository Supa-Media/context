import { describe, expect, test } from "@jest/globals";
import * as Y from "yjs";
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

function options(transport: { mint: () => Promise<string>; request: (token: string, body: { path: string; documentId?: string; update?: string; replacement?: { expectedEtag: string; text: string } }) => Promise<CollaborationResponse> }, store: KeyValueStore = memoryStore()) {
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

describe("durable collaboration", () => {
  test("cold open uses the server Yjs snapshot once without duplicating text", async () => {
    const bodies: unknown[] = [];
    const controller = new DurableCollaborationController(
      options({
        mint: async () => "grant",
        request: async (_token, body) => {
          bodies.push(body);
          return response("doc-1", "hello");
        },
      }),
    );
    await controller.start();
    expect(bodies).toEqual([{ path: "notes/a.md" }]);
    expect(controller.state.text).toBe("hello");
    expect(controller.state.ready).toBe(true);
    controller.stop();
  });

  test("a native edit against an older rendered version keeps a peer append", async () => {
    let writes = 0;
    const controller = new DurableCollaborationController(
      options({
        mint: async () => "grant",
        request: async (_token, body) => {
          if (body.update !== undefined) {
            writes += 1;
            return response("doc-1", "hello!");
          }
          return response("doc-1", "hello");
        },
      }),
    );
    await controller.start();
    const renderedSnapshot = controller.state.shared?.snapshot() ?? "";
    const peer = createSharedDoc({});
    peer.applyRemote(controller.state.shared?.snapshot() ?? "");
    peer.text.insert(0, "peer ");
    controller.state.shared?.applyRemote(peer.snapshot());
    controller.changeVersionedForHook("hello!", renderedSnapshot);
    expect(controller.state.text).toBe("peer hello!");
    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(writes).toBe(1);
    peer.destroy();
    controller.stop();
  });

  test("exact snapshot edits preserve a middle peer insertion in repeated text", async () => {
    const controller = new DurableCollaborationController(
      options({
        mint: async () => "grant",
        request: async (_token, body) =>
          body.update === undefined ? response("doc-1", "foo foo") : response("doc-1", "foo baz"),
      }),
    );
    await controller.start();
    const renderedSnapshot = controller.state.shared?.snapshot() ?? "";
    const peer = createSharedDoc({});
    peer.applyRemote(renderedSnapshot);
    peer.text.insert(4, "X");
    controller.state.shared?.applyRemote(peer.snapshot());
    controller.changeVersionedForHook("foo baz", renderedSnapshot);
    expect(controller.state.text).toContain("X");
    expect(controller.state.text).toContain("baz");
    peer.destroy();
    controller.stop();
  });

  test("versioned edits replace whole Unicode code points", async () => {
    const controller = new DurableCollaborationController(
      options({
        mint: async () => "grant",
        request: async (_token, body) =>
          body.update === undefined ? response("doc-1", "😀 human") : response("doc-1", "😎 peer human"),
      }),
    );
    await controller.start();
    const renderedSnapshot = controller.state.shared?.snapshot() ?? "";
    const peer = createSharedDoc({});
    peer.applyRemote(renderedSnapshot);
    peer.text.insert(peer.markdown().length, " peer");
    controller.state.shared?.applyRemote(peer.snapshot());
    controller.changeVersionedForHook("😎 human", renderedSnapshot);
    expect(controller.state.text).toContain("😎");
    expect(controller.state.text).toContain("peer");
    expect(controller.state.text).not.toContain("�");
    peer.destroy();
    controller.stop();
  });

  test("a generation mismatch preserves pending local updates", async () => {
    let reads = 0;
    let releaseRepair: (() => void) | null = null;
    let releaseWrite: (() => void) | null = null;
    const controller = new DurableCollaborationController(
      options({
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
      }),
    );
    await controller.start();
    controller.state.onChange("mine");
    expect(controller.state.pending).toBe(1);
    controller.repairForHook();
    await new Promise((resolve) => setTimeout(resolve, 0));
    (releaseRepair as (() => void) | null)?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.state.status).toBe("error");
    expect(controller.state.pending).toBe(1);
    (releaseWrite as (() => void) | null)?.();
    controller.stop();
  });

  test("persistence failure never reports saved", async () => {
    const failing: KeyValueStore = {
      ...memoryStore(),
      set: async () => {
        throw new Error("storage full");
      },
    };
    let last = "loading";
    const controller = new DurableCollaborationController({
      ...options({
        mint: async () => "grant",
        request: async () => response("doc-1", "base"),
      }, failing),
      onState: (state) => {
        last = state.status;
      },
    });
    await controller.start();
    expect(last).toBe("error");
    expect(controller.state.status).toBe("error");
    controller.stop();
  });

  test("local status waits for the device snapshot to finish writing", async () => {
    const base = memoryStore();
    let writes = 0;
    let release: (() => void) | undefined;
    const deferred = new Promise<void>((resolve) => { release = resolve; });
    const store: KeyValueStore = {
      ...base,
      set: async (key, value) => {
        writes += 1;
        if (writes === 2) await deferred;
        await base.set(key, value);
      },
    };
    const statuses: string[] = [];
    const controller = new DurableCollaborationController({
      ...options({
        mint: async () => "grant",
        request: async () => response("doc-1", "base"),
      }, store),
      onState: (state) => statuses.push(state.status),
    });
    await controller.start();
    controller.state.onChange("mine");
    expect(controller.state.status).toBe("storing");
    expect(statuses.at(-1)).toBe("storing");
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.state.status).toBe("local");
    expect(statuses.slice(1)).not.toContain("saved");
    controller.stop();
  });

  test("native Yjs updates require the current generation and join the durable queue", async () => {
    const controller = new DurableCollaborationController(
      options({
        mint: async () => "grant",
        request: async (_token, body) =>
          body.update === undefined ? response("doc-1", "base") : response("doc-1", "base!"),
      }),
    );
    await controller.start();
    let update = "";
    const native = createSharedDoc({ onLocalUpdate: (value) => { update = value; } });
    native.applyRemote(controller.state.shared?.snapshot() ?? "");
    native.text.insert(native.text.length, "!");
    expect(update).not.toBe("");
    expect(controller.state.onUpdate("old-doc", update)).toBe(false);
    expect(controller.state.pending).toBe(0);
    expect(controller.state.onUpdate("doc-1", update)).toBe(true);
    expect(controller.state.text).toBe("base!");
    expect(controller.state.pending).toBe(1);
    native.destroy();
    controller.stop();
  });

  test("does not become ready or apply a late snapshot after stop", async () => {
    let release: ((value: CollaborationResponse) => void) | null = null;
    const controller = new DurableCollaborationController(
      options({
        mint: async () => "grant",
        request: async () => new Promise<CollaborationResponse>((resolve) => { release = resolve; }),
      }),
    );
    const starting = controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.state.ready).toBe(false);
    controller.stop();
    (release as ((value: CollaborationResponse) => void) | null)?.(response("doc-1", "late"));
    await starting;
    expect(controller.state.text).toBe("");
  });

  test("definitive auth failure revokes the controller and blocks repair", async () => {
    let calls = 0;
    const controller = new DurableCollaborationController(
      options({
        mint: async () => "grant",
        request: async () => {
          calls += 1;
          throw new Error("401");
        },
      }),
    );
    await controller.start();
    expect(controller.state.status).toBe("revoked");
    controller.repairForHook();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    controller.stop();
  });

  test("temporary gateway 404 stays unavailable and repairs to the same generation", async () => {
    let calls = 0;
    const controller = new DurableCollaborationController(
      options({
        mint: async () => "grant",
        request: async () => {
          calls += 1;
          if (calls === 1) throw new Error("404");
          return response("doc-1", "restored");
        },
      }),
    );
    await controller.start();
    expect(controller.state.status).toBe("unavailable");
    expect(controller.state.ready).toBe(false);
    controller.repairForHook();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.state.status).toBe("saved");
    expect(controller.state.text).toBe("restored");
    expect(calls).toBe(2);
    controller.stop();
  });

  test("pending dependency response keeps the sent batch", async () => {
    let writes = 0;
    const controller = new DurableCollaborationController(
      options({
        mint: async () => "grant",
        request: async (_token, body) => {
          if (body.update !== undefined) {
            writes += 1;
            return { ...response("doc-1", "base"), applied: false, pendingDependencies: true };
          }
          return response("doc-1", "base");
        },
      }),
    );
    await controller.start();
    controller.state.onChange("mine");
    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(writes).toBe(1);
    expect(controller.state.pending).toBe(1);
    controller.stop();
  });

  test("legacy recovery uses the exact retained base replacement and clears only matching ACK", async () => {
    const bodies: unknown[] = [];
    const states: { legacyAdopted?: { path: string; text: string; baseEtag: string } }[] = [];
    const server = new Y.Doc();
    server.getText("note").insert(0, "current");
    const serverResponse = (): CollaborationResponse => ({
      documentId: "doc-1",
      update: Buffer.from(Y.encodeStateAsUpdate(server)).toString("base64"),
      text: server.getText("note").toString(),
      etag: "doc-1-etag",
    });
    const controller = new DurableCollaborationController({
      ...options({
        mint: async () => "grant",
        request: async (_token, body) => {
          bodies.push(body);
          if (body.replacement !== undefined) {
            server.transact(() => {
              server.getText("note").delete(0, server.getText("note").length);
              server.getText("note").insert(0, "draft");
            });
          }
          return serverResponse();
        },
      }),
      legacyDraft: { baseline: "old ancestor", desired: "draft", baseEtag: "doc-1-earlier" },
      onState: (state) => states.push(state),
    });
    await controller.start();
    expect(bodies).toEqual([
      { path: "notes/a.md" },
      { path: "notes/a.md", replacement: { expectedEtag: "doc-1-earlier", text: "draft" } },
    ]);
    expect(controller.state.recovery).toBeUndefined();
    expect(controller.state.ready).toBe(true);
    expect(controller.state.text).toBe("draft");
    expect(states.at(-1)?.legacyAdopted).toEqual({ path: "notes/a.md", text: "draft", baseEtag: "doc-1-earlier" });
    server.destroy();
    controller.stop();
  });
});
