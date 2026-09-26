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

describe("durable collaboration", () => {
  test("each locally persisted edit is relayed before the bucket acknowledges it", async () => {
    const base = response("doc-live", "hello");
    const controller = new DurableCollaborationController(options({
      mint: async () => "grant",
      request: async (_token, body) => body.update ? new Promise(() => {}) : base,
    }));
    await controller.start();
    const received: string[] = [];
    const unsubscribe = controller.subscribeLiveUpdates((frame) => received.push(frame.update));
    controller.changeForHook("hello!");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toHaveLength(1);
    expect(controller.state.pending).toBe(1);
    expect(controller.state.status).not.toBe("saved");
    const peer = createSharedDoc({});
    peer.applyRemote(base.update);
    peer.applyRemote(received[0]);
    expect(peer.markdown()).toBe("hello!");
    unsubscribe();
    peer.destroy();
    controller.stop();
  });

  test("a received live edit is durable locally without echoing or claiming a bucket save", async () => {
    const base = response("doc-live", "hello");
    const store = memoryStore();
    const controller = new DurableCollaborationController(options({
      mint: async () => "grant",
      request: async (_token, body) => body.update ? new Promise(() => {}) : base,
    }, store));
    await controller.start();
    const echoes: unknown[] = [];
    controller.subscribeLiveUpdates((frame) => echoes.push(frame));
    const peer = createSharedDoc({});
    peer.applyRemote(base.update);
    const before = Y.encodeStateVector(peer.doc);
    peer.text.insert(peer.text.length, " peer");
    const update = Buffer.from(Y.encodeStateAsUpdate(peer.doc, before)).toString("base64");
    expect(controller.receiveLiveUpdate("wrong-generation", update)).toBe(false);
    expect(controller.receiveLiveUpdate("doc-live", update)).toBe(true);
    expect(controller.receiveLiveUpdate("doc-live", update)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(controller.state.text).toBe("hello peer");
    expect(controller.state.pending).toBe(1);
    expect(controller.state.status).not.toBe("saved");
    expect(echoes).toEqual([]);
    controller.stop();
    const reopened = new DurableCollaborationController({
      ...options({ mint: async () => "grant", request: async () => base }, store),
      online: () => false,
    });
    await reopened.start();
    expect(reopened.state.text).toBe("hello peer");
    expect(reopened.state.pending).toBe(1);
    reopened.stop();
    peer.destroy();
  });

  test("read-only live recipients never publish, and saved waits for the server's matching state", async () => {
    const server = createSharedDoc({});
    server.text.insert(0, "hello");
    const requests: unknown[] = [];
    const controller = new DurableCollaborationController({
      ...options({ mint: async () => "grant", request: async (_token, body) => {
        requests.push(body);
        return { documentId: "doc-live", etag: "server", update: server.snapshot(), text: server.markdown() };
      } }),
      canWrite: () => false,
    });
    await controller.start();
    const peer = createSharedDoc({});
    peer.applyRemote(server.snapshot());
    const before = Y.encodeStateVector(peer.doc);
    peer.text.insert(peer.text.length, " peer");
    const update = Buffer.from(Y.encodeStateAsUpdate(peer.doc, before)).toString("base64");
    controller.receiveLiveUpdate("doc-live", update);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(requests).toHaveLength(1);
    controller.repairForHook();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(controller.state.status).not.toBe("saved");
    expect(controller.state.pending).toBe(1);
    server.applyRemote(update);
    controller.repairForHook();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(controller.state.status).toBe("saved");
    expect(controller.state.pending).toBe(0);
    expect(requests.every((body) => !(body as { update?: string }).update)).toBe(true);
    controller.stop(); peer.destroy(); server.destroy();
  });

  test("out-of-order live edits and deletes survive reload and settle against server history", async () => {
    const server = new Y.Doc({ gc: false });
    server.getText("note").insert(0, "hello");
    const serverResponse = () => ({ documentId: "doc-live", etag: "server",
      update: Buffer.from(Y.encodeStateAsUpdate(server)).toString("base64"), text: server.getText("note").toString() });
    const store = memoryStore();
    const setup = { ...options({ mint: async () => "grant", request: async () => serverResponse() }, store), canWrite: () => false };
    const first = new DurableCollaborationController(setup);
    await first.start();
    const peer = createSharedDoc({});
    peer.applyRemote(serverResponse().update);
    const updates: string[] = [];
    peer.doc.on("update", (update: Uint8Array) => updates.push(Buffer.from(update).toString("base64")));
    peer.text.insert(5, " A");
    peer.text.insert(7, "B");
    peer.text.delete(0, 2);
    // A later edit can arrive first when authorization reads finish out of order.
    first.receiveLiveUpdate("doc-live", updates[1]);
    first.receiveLiveUpdate("doc-live", updates[2]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    first.stop();
    const reopened = new DurableCollaborationController(setup);
    await reopened.start();
    reopened.receiveLiveUpdate("doc-live", updates[0]);
    expect(reopened.state.text).toBe("llo AB");
    expect(reopened.state.pending).toBeGreaterThan(0);
    for (const update of updates) Y.applyUpdate(server, Buffer.from(update, "base64"));
    reopened.repairForHook();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reopened.state.text).toBe("llo AB");
    expect(reopened.state.pending).toBe(0);
    expect(reopened.state.status).toBe("saved");
    reopened.stop(); peer.destroy(); server.destroy();
  });

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
    // A 401 is retried once with the refused token named, because another
    // consumer rotating the shared grant produces one too. A 401 against the
    // replacement is the gateway's real answer.
    let calls = 0;
    const mints: (string | undefined)[] = [];
    const controller = new DurableCollaborationController(
      options({
        mint: async (rejected?: string) => {
          mints.push(rejected);
          return rejected === undefined ? "grant" : "replacement";
        },
        request: async () => {
          calls += 1;
          throw new Error("401");
        },
      }),
    );
    await controller.start();
    expect(controller.state.status).toBe("revoked");
    expect(mints).toEqual([undefined, "grant"]);
    controller.repairForHook();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    controller.stop();
  });

  test("repairs asked for while a read is in flight share one follow-up read", async () => {
    // Focus, a reconnect and the periodic repair can all ask in the same
    // second; each used to start its own overlapping read.
    let reads = 0;
    let release: (() => void) | null = null;
    const base = response("doc-1", "hello");
    const controller = new DurableCollaborationController(options({
      mint: async () => "grant",
      request: async () => {
        reads += 1;
        if (reads === 2) await new Promise<void>((resolve) => { release = resolve; });
        return base;
      },
    }));
    try {
      await controller.start();
      expect(reads).toBe(1);
      controller.repairForHook();
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (let ask = 0; ask < 5; ask += 1) controller.repairForHook();
      expect(reads).toBe(2);
      (release as (() => void) | null)?.();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(reads).toBe(3);
    } finally {
      (release as (() => void) | null)?.();
      controller.stop();
    }
  });

  test("a 403 is final at once: no credential refresh is attempted", async () => {
    let calls = 0;
    const mints: (string | undefined)[] = [];
    const controller = new DurableCollaborationController(
      options({
        mint: async (rejected?: string) => {
          mints.push(rejected);
          return "grant";
        },
        request: async () => {
          calls += 1;
          throw new Error("403");
        },
      }),
    );
    await controller.start();
    expect(controller.state.status).toBe("revoked");
    expect(calls).toBe(1);
    expect(mints).toEqual([undefined]);
    controller.stop();
  });

  test("a token another consumer rotated is replaced once and the save still lands", async () => {
    // Presence or the agent refreshing the shared grant revokes the token this
    // controller already holds. That used to strand the note on "revoked".
    const seen: string[] = [];
    const controller = new DurableCollaborationController(
      options({
        mint: async (rejected?: string) => (rejected === "stale" ? "fresh" : "stale"),
        request: async (token) => {
          seen.push(token);
          if (token === "stale") throw new Error("401");
          return response("doc-1", "hello");
        },
      }),
    );
    await controller.start();
    expect(seen).toEqual(["stale", "fresh"]);
    expect(controller.state.status).toBe("saved");
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

  test("legacy recovery keeps a peer edit that arrived after the create ACK", async () => {
    const bodies: unknown[] = [];
    const server = new Y.Doc();
    server.getText("note").insert(0, "created peer");
    const serverResponse = (): CollaborationResponse => ({
      documentId: "doc-1",
      update: Buffer.from(Y.encodeStateAsUpdate(server)).toString("base64"),
      text: server.getText("note").toString(),
      etag: "c2-current",
    });
    const controller = new DurableCollaborationController({
      ...options({
        mint: async () => "grant",
        request: async (_token, body) => {
          bodies.push(body);
          if (body.replacement !== undefined) {
            expect(body.replacement.expectedEtag).toBe("raw-create");
            server.getText("note").insert(server.getText("note").length, " mine");
          }
          return serverResponse();
        },
      }),
      legacyDraft: { baseline: "created", desired: "created mine", baseEtag: "raw-create" },
    });
    await controller.start();
    expect(bodies).toEqual([
      { path: "notes/a.md" },
      { path: "notes/a.md", replacement: { expectedEtag: "raw-create", text: "created mine" } },
    ]);
    expect(controller.state.text).toContain("created peer");
    expect(controller.state.text).toContain("mine");
    server.destroy();
    controller.stop();
  });
});
