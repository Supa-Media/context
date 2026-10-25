/**
 * Typing left on the device in a shared note that is no longer open.
 *
 * An offline draft or an unsent update used to wait for that note to be
 * opened again: close it, reconnect, and the edit stayed on the phone until
 * somebody happened to go back to it. Now every reconnection sends them
 * (`collaboration/closedNotes.ts`), and a note that is open is left to the
 * controller the editor holds, which always wins.
 */
import { describe, expect, test } from "@jest/globals";
import { memoryStore, type KeyValueStore } from "../features/offline/memory";
import { createSharedDoc } from "../features/console/presence/sharedDoc";
import { DurableCollaborationController, type CollaborationResponse, type CollaborationTransport } from "../features/console/collaboration/durable";
import { sendClosedNotes } from "../features/console/collaboration/closedNotes";

type Body = Parameters<CollaborationTransport["request"]>[1];

const BASE = "c2.doc-1.r1";

/** One server document, as the gateway keeps it. */
function gateway() {
  const server = createSharedDoc({});
  server.doc.transact(() => server.text.insert(0, "hello"), "server");
  const bodies: Body[] = [];
  const answer = (): CollaborationResponse => ({ documentId: "doc-1", update: server.snapshot(), text: server.markdown(), etag: "c2.doc-1.r2" });
  const request = async (body: Body): Promise<CollaborationResponse> => {
    bodies.push(body);
    if (body.replacement !== undefined) {
      server.doc.transact(() => {
        server.text.delete(0, server.text.length);
        server.text.insert(0, body.replacement!.text);
      }, "server");
    }
    if (body.update !== undefined) server.applyRemote(body.update);
    return answer();
  };
  return { server, bodies, request };
}

function controller(store: KeyValueStore, request: (body: Body) => Promise<CollaborationResponse>, online: () => boolean, path = "notes/a.md") {
  return new DurableCollaborationController({
    workspaceId: "workspace",
    path,
    scope: "private",
    initialText: "hello",
    base: () => ({ text: "hello", etag: BASE }),
    transport: { mint: async () => "grant", request: async (_token, body) => request(body) },
    store,
    onText: () => {},
    onState: () => {},
    online,
    draftWaitMs: 20,
  });
}

const transportTo = (request: (body: Body) => Promise<CollaborationResponse>) => () => ({
  mint: async () => "grant",
  request: async (_token: string, body: Body) => request(body),
});

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<CollaborationResponse>(() => {});

async function record(store: KeyValueStore) {
  const key = (await store.keys()).find((one) => !one.includes("::superseded::"))!;
  return JSON.parse((await store.get(key))!) as { pending: unknown[]; recovery?: unknown };
}

describe("typing left in a closed shared note", () => {
  test("an offline draft is sent on reconnection without the note being opened", async () => {
    const store = memoryStore();
    const offline = controller(store, never, () => false);
    await offline.start();
    offline.changeForHook("hello world");
    await tick();
    offline.stop();

    const remote = gateway();
    const report = await sendClosedNotes(store, { transport: transportTo(remote.request), mine: () => true, online: () => true });
    expect(remote.bodies).toEqual([{ path: "notes/a.md", replacement: { expectedEtag: BASE, text: "hello world" } }]);
    expect(remote.server.markdown()).toBe("hello world");
    expect(report).toEqual({ sent: 1, left: 0 });
    expect((await record(store)).recovery).toBeUndefined();
  });

  test("unsent updates of a note this device already holds are sent too", async () => {
    const store = memoryStore();
    const remote = gateway();
    let online = true;
    const open = controller(store, remote.request, () => online);
    await open.start();
    expect(open.state.ready).toBe(true);
    online = false;
    open.changeForHook("hello there");
    await tick(200);
    open.stop();
    expect((await record(store)).pending).toHaveLength(1);
    remote.bodies.length = 0;

    const report = await sendClosedNotes(store, { transport: transportTo(remote.request), mine: () => true, online: () => true });
    expect(remote.bodies.some((body) => body.update !== undefined)).toBe(true);
    expect(remote.server.markdown()).toBe("hello there");
    expect(report).toEqual({ sent: 1, left: 0 });
    expect((await record(store)).pending).toEqual([]);
  });

  test("a note open on the device is left to its own editor", async () => {
    const store = memoryStore();
    const offline = controller(store, never, () => false);
    await offline.start();
    offline.changeForHook("hello world");
    await tick();
    // Still open: its controller sends this draft itself.
    const remote = gateway();
    const report = await sendClosedNotes(store, { transport: transportTo(remote.request), mine: () => true, online: () => true });
    expect(remote.bodies).toEqual([]);
    expect(report).toEqual({ sent: 0, left: 0 });
    offline.stop();
  });

  test("opening a note while it is being sent hands it to the editor, which reads what the sender kept", async () => {
    const store = memoryStore();
    const offline = controller(store, never, () => false);
    await offline.start();
    offline.changeForHook("hello world");
    await tick();
    offline.stop();

    // The background send never answers: a weak connection.
    const sending = sendClosedNotes(store, { transport: transportTo(never), mine: () => true, online: () => true, settleMs: 5_000 });
    await tick();
    const remote = gateway();
    const reopened = controller(store, remote.request, () => true);
    await reopened.start();
    await tick();
    // The editor's own controller sent the draft, once, and the sender stood down.
    expect(remote.bodies).toEqual([{ path: "notes/a.md", replacement: { expectedEtag: BASE, text: "hello world" } }]);
    expect(reopened.state.ready).toBe(true);
    expect(reopened.state.text).toBe("hello world");
    expect(await sending).toEqual({ sent: 0, left: 1 });
    reopened.stop();
  });

  test("nothing is sent after sign-out, offline, or for an older draft that needs review", async () => {
    const store = memoryStore();
    const offline = controller(store, never, () => false);
    await offline.start();
    offline.changeForHook("hello world");
    await tick();
    offline.stop();
    const remote = gateway();
    expect(await sendClosedNotes(store, { transport: transportTo(remote.request), mine: () => false, online: () => true })).toEqual({ sent: 0, left: 0 });
    expect(await sendClosedNotes(store, { transport: transportTo(remote.request), mine: () => true, online: () => false })).toEqual({ sent: 0, left: 0 });

    // The same draft as an older legacy one, kept for review rather than sent unasked.
    const key = (await store.keys())[0]!;
    const kept = JSON.parse((await store.get(key))!);
    await store.set(key, JSON.stringify({ ...kept, recovery: { baseline: "hello", desired: "hello world", baseEtag: BASE } }));
    expect(await sendClosedNotes(store, { transport: transportTo(remote.request), mine: () => true, online: () => true })).toEqual({ sent: 0, left: 0 });
    expect(remote.bodies).toEqual([]);
  });

  test("a gateway that cannot be reached leaves the typing on the device for next time", async () => {
    const store = memoryStore();
    const offline = controller(store, never, () => false);
    await offline.start();
    offline.changeForHook("hello world");
    await tick();
    offline.stop();
    const report = await sendClosedNotes(store, {
      transport: transportTo(async () => {
        throw new TypeError("Network request failed");
      }),
      mine: () => true,
      online: () => true,
    });
    expect(report).toEqual({ sent: 0, left: 1 });
    expect((await record(store)).recovery).toEqual(expect.objectContaining({ desired: "hello world", offline: true }));
  });
});
