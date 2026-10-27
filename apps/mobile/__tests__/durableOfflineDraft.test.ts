/**
 * A shared note with no copy of its shared document on this device yet, opened
 * with no connection or a weak one (Dev2, 2026-10-25: "when I don't have
 * reliable data service ... the cursor just doesn't show up ... I just can't
 * edit my notes offline").
 *
 * The editor used to stay read-only until the gateway's first read answered,
 * which offline is never. Now the note takes typing as an offline draft over
 * the version on screen, and that draft is merged on the server against that
 * version when the connection is back (`offlineDraft.ts`).
 */
import { describe, expect, test } from "@jest/globals";
import { memoryStore, type KeyValueStore } from "../features/offline/memory";
import { createSharedDoc } from "../features/console/presence/sharedDoc";
import { DurableCollaborationController, type CollaborationResponse } from "../features/console/collaboration/durable";
import { documentIdOf } from "../features/console/collaboration/offlineDraft";
import { waitingOnDevice } from "../features/offline/cache";
import { scopedKeyFor } from "../features/offline/keys";

const BASE = "c2.doc-1.r1";

/** One server document, as the gateway keeps it: each answer is its state now. */
const server = createSharedDoc({});
function answer(text: string, etag = "c2.doc-1.r2"): CollaborationResponse {
  server.doc.transact(() => {
    server.text.delete(0, server.text.length);
    server.text.insert(0, text);
  }, "server");
  return { documentId: "doc-1", update: server.snapshot(), text, etag };
}

type Body = { path: string; documentId?: string; update?: string; replacement?: { expectedEtag: string; text: string } };

function setup(request: (body: Body) => Promise<CollaborationResponse>, more: { store?: KeyValueStore; online?: () => boolean; initialEtag?: string | null; legacyDraft?: { baseline: string; desired: string; baseEtag?: string | null }; canWrite?: () => boolean } = {}) {
  const store = more.store ?? memoryStore();
  // What the editor shows, which a later read can replace before typing starts.
  const shown = { text: "hello", etag: BASE };
  const states: { ready: boolean; status: string; text: string }[] = [];
  const texts: string[] = [];
  const controller = new DurableCollaborationController({
    workspaceId: "workspace",
    path: "notes/a.md",
    scope: "private",
    initialText: "hello",
    base: () => ({ text: shown.text, etag: "initialEtag" in more ? more.initialEtag ?? null : shown.etag }),
    ...(more.legacyDraft === undefined ? {} : { legacyDraft: more.legacyDraft }),
    transport: { mint: async () => "grant", request: async (_token, body) => request(body) },
    store,
    onText: (text) => texts.push(text),
    onState: (state) => states.push(state),
    online: more.online ?? (() => true),
    draftWaitMs: 20,
    ...(more.canWrite === undefined ? {} : { canWrite: more.canWrite }),
  });
  return { controller, store, states, texts, shown };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<CollaborationResponse>(() => {});

describe("offline drafts of a shared note", () => {
  test("the document id is read from a c2 version and from nothing else", () => {
    expect(documentIdOf("c2.doc-e29d0064-c115.r0")).toBe("doc-e29d0064-c115");
    expect(documentIdOf("plain-etag")).toBeNull();
    expect(documentIdOf(null)).toBeNull();
    expect(documentIdOf(undefined)).toBeNull();
  });

  test("offline, the note takes typing at once and keeps it on the device", async () => {
    const offline = setup(never, { online: () => false });
    await offline.controller.start();
    expect(offline.controller.state.ready).toBe(false);
    expect(offline.controller.state.drafting).toBe(true);
    offline.controller.changeForHook("hello world");
    await tick();
    expect(offline.controller.state.text).toBe("hello world");
    expect(offline.texts.at(-1)).toBe("hello world");
    expect(offline.controller.state.status).toBe("offline");
    expect(offline.controller.state.pending).toBe(1);
    // Signing out, say, is told there is unsent work on this device.
    expect((await waitingOnDevice(offline.store, null)).pending).toBe(1);
    offline.controller.stop();

    // Reopened, still offline: the draft is there, and still takes typing.
    const reopened = setup(never, { online: () => false, store: offline.store });
    await reopened.controller.start();
    expect(reopened.controller.state.text).toBe("hello world");
    expect(reopened.controller.state.drafting).toBe(true);
    reopened.controller.changeForHook("hello world!");
    expect(reopened.controller.state.text).toBe("hello world!");
    reopened.controller.stop();
  });

  test("a versioned change from the native editor is a draft too, not dropped", async () => {
    const offline = setup(never, { online: () => false });
    await offline.controller.start();
    offline.controller.changeVersionedForHook("hello there", "");
    expect(offline.controller.state.text).toBe("hello there");
    offline.controller.stop();
  });

  test("back online, the draft is merged against the version it was typed on", async () => {
    let online = false;
    const bodies: Body[] = [];
    const draft = setup(async (body) => {
      bodies.push(body);
      return answer(body.replacement?.text === "hello world" ? "peer: hello world" : "peer: hello");
    }, { online: () => online });
    await draft.controller.start();
    draft.controller.changeForHook("hello world");
    online = true;
    draft.controller.repairForHook();
    await tick();
    expect(bodies).toEqual([{ path: "notes/a.md", replacement: { expectedEtag: BASE, text: "hello world" } }]);
    expect(draft.controller.state.ready).toBe(true);
    expect(draft.controller.state.drafting).toBe(false);
    expect(draft.controller.state.recovery).toBeUndefined();
    expect(draft.controller.state.text).toBe("peer: hello world");
    expect(draft.controller.state.status).toBe("saved");
    draft.controller.stop();
  });

  test("typing while the draft is on its way is sent next, against the version that answered", async () => {
    let online = false;
    const bodies: Body[] = [];
    let release: (() => void) | null = null;
    const draft = setup((body) => {
      bodies.push(body);
      if (bodies.length === 1) {
        return new Promise((resolve) => {
          release = () => resolve(answer("hello world", "c2.doc-1.r2"));
        });
      }
      return Promise.resolve(answer("hello world, again", "c2.doc-1.r3"));
    }, { online: () => online });
    await draft.controller.start();
    draft.controller.changeForHook("hello world");
    online = true;
    draft.controller.repairForHook();
    await tick();
    draft.controller.changeForHook("hello world, again");
    expect(draft.controller.state.text).toBe("hello world, again");
    release!();
    await tick();
    expect(bodies.map((body) => body.replacement)).toEqual([
      { expectedEtag: BASE, text: "hello world" },
      { expectedEtag: "c2.doc-1.r2", text: "hello world, again" },
    ]);
    expect(draft.controller.state.ready).toBe(true);
    expect(draft.controller.state.text).toBe("hello world, again");
    draft.controller.stop();
  });

  test("a draft is based on the version on screen when typing starts, not when the note opened", async () => {
    let online = false;
    const bodies: Body[] = [];
    const draft = setup(async (body) => {
      bodies.push(body);
      return answer("hello again!");
    }, { online: () => online });
    await draft.controller.start();
    // The bucket's newer copy replaced the cached one before the first keystroke.
    draft.shown.text = "hello again";
    draft.shown.etag = "c2.doc-1.r5";
    draft.controller.changeForHook("hello again!");
    online = true;
    draft.controller.repairForHook();
    await tick();
    expect(bodies[0]?.replacement).toEqual({ expectedEtag: "c2.doc-1.r5", text: "hello again!" });
    draft.controller.stop();
  });

  test("a weak connection: the note takes typing once the first read is slow", async () => {
    const slow = setup(never);
    void slow.controller.start();
    await tick(5);
    expect(slow.controller.state.drafting).toBe(false);
    await tick(40);
    expect(slow.controller.state.drafting).toBe(true);
    slow.controller.changeForHook("hello there");
    expect(slow.controller.state.text).toBe("hello there");
    slow.controller.stop();
  });

  test("typing that starts while the first read is out goes as a draft once it answers", async () => {
    const bodies: Body[] = [];
    let release: (() => void) | null = null;
    const slow = setup((body) => {
      bodies.push(body);
      if (bodies.length === 1) {
        return new Promise((resolve) => {
          release = () => resolve(answer("hello"));
        });
      }
      return Promise.resolve(answer("hello there"));
    });
    void slow.controller.start();
    await tick(40);
    slow.controller.changeForHook("hello there");
    release!();
    await tick();
    expect(bodies[1]).toEqual({ path: "notes/a.md", replacement: { expectedEtag: BASE, text: "hello there" } });
    expect(slow.controller.state.ready).toBe(true);
    expect(slow.controller.state.text).toBe("hello there");
    slow.controller.stop();
  });

  /*
    A legacy draft with a shared version to merge against is no longer a reason
    to refuse typing: it is the editor's own unsaved typing on a note that just
    turned shared (Dev2, 2026-10-27, "I have to wait about 5 seconds"), and it
    is taken up as the draft, below. One with no shared version still waits.
  */
  test("no draft without a shared version to merge against, over a legacy queue without one, or for a reader", async () => {
    for (const more of [
      { initialEtag: null },
      { initialEtag: "plain-etag" },
      { legacyDraft: { baseline: "hello", desired: "hello!", baseEtag: "plain-etag" } },
      { canWrite: () => false },
    ]) {
      const offline = setup(never, { online: () => false, ...more });
      await offline.controller.start();
      expect(offline.controller.state.drafting).toBe(false);
      offline.controller.changeForHook("typed");
      expect(offline.controller.state.text).not.toBe("typed");
      offline.controller.stop();
    }
  });

  describe("the editor's own typing, on a note that just turned shared", () => {
    const legacyDraft = { baseline: "hello", desired: "hello there", baseEtag: BASE };

    test("is a draft from the controller's first moment, before anything is read", () => {
      const fresh = setup(never, { legacyDraft });
      expect(fresh.controller.state.drafting).toBe(true);
      expect(fresh.controller.state.text).toBe("hello there");
      fresh.controller.changeForHook("hello there, and more");
      expect(fresh.controller.state.text).toBe("hello there, and more");
      fresh.controller.stop();
    });

    test("goes as one replacement against its version, typing on top included, and clears the queue it came from", async () => {
      const sent: Body[] = [];
      const taken = setup(async (body) => {
        sent.push(body);
        return answer(body.replacement?.text ?? "hello");
      }, { legacyDraft });
      taken.controller.changeForHook("hello there, and more");
      await taken.controller.start();
      await tick();
      expect(sent.map((body) => body.replacement)).toEqual([{ expectedEtag: BASE, text: "hello there, and more" }]);
      expect(sent.every((body) => body.update === undefined)).toBe(true);
      expect(taken.controller.state.ready).toBe(true);
      expect(taken.controller.state.text).toBe("hello there, and more");
      // The full-text save it began as is matched by what it was, not by what it became.
      expect(taken.states.map((state) => (state as { legacyAdopted?: unknown }).legacyAdopted).filter(Boolean))
        .toEqual([{ path: "notes/a.md", text: "hello there", baseEtag: BASE }]);
      taken.controller.stop();
    });

    test("typed before the device's record is read, it is laid over a record that holds nothing yet", async () => {
      const store = memoryStore();
      const key = scopedKeyFor("collaboration", "private", "workspace", "notes/a.md");
      // The marker a controller writes before its first read (`start`).
      await store.set(key, JSON.stringify({ version: 1, documentId: null, etag: null, snapshot: "", pending: [] }));
      const taken = setup(never, { legacyDraft, store, online: () => false });
      taken.controller.changeForHook("hello there, typed at once");
      await taken.controller.start();
      await tick();
      expect(taken.controller.state.drafting).toBe(true);
      expect(taken.controller.state.text).toBe("hello there, typed at once");
      expect(JSON.parse((await store.get(key))!).recovery.desired).toBe("hello there, typed at once");
      taken.controller.stop();
    });

    test("and never written over a record with unsent typing of its own, which is kept as it was", async () => {
      const store = memoryStore();
      const key = scopedKeyFor("collaboration", "private", "workspace", "notes/a.md");
      const earlier = { version: 1, documentId: "doc-1", etag: BASE, snapshot: "", pending: [{ id: "earlier", update: "AAA=" }] };
      await store.set(key, JSON.stringify(earlier));
      const taken = setup(never, { legacyDraft, store, online: () => false });
      taken.controller.changeForHook("hello there, typed at once");
      await taken.controller.start();
      await tick();
      const kept = JSON.parse((await store.get(key))!);
      expect(kept.pending).toEqual(earlier.pending);
      expect(kept.recovery).toBeUndefined();
      taken.controller.stop();
    });
  });

  test("a first read that fails never reports the note as empty (the note that vanished)", async () => {
    for (const failure of [new TypeError("Network request failed"), new Error("503"), new Error("404"), new Error("500")]) {
      const failing = setup(async () => {
        throw failure;
      });
      await failing.controller.start();
      expect(failing.states.length).toBeGreaterThan(0);
      for (const state of failing.states) expect(state.text).toBe("hello");
      expect(failing.texts).not.toContain("");
      expect(failing.controller.state.text).toBe("hello");
      failing.controller.stop();
    }
    const offline = setup(never, { online: () => false, initialEtag: null });
    await offline.controller.start();
    for (const state of offline.states) expect(state.text).toBe("hello");
    offline.controller.stop();
  });

  test("an empty shared document kept on the device never opens the note blank", async () => {
    const store = memoryStore();
    const first = setup(never, { store, online: () => false });
    // What a record written before the first read used to hold: an empty doc.
    const empty = createSharedDoc({});
    const key = (await (async () => {
      await first.controller.start();
      first.controller.changeForHook("hello world");
      await tick();
      return (await store.keys())[0];
    })());
    first.controller.stop();
    const record = JSON.parse((await store.get(key))!);
    await store.set(key, JSON.stringify({ ...record, snapshot: empty.snapshot(), recovery: undefined }));
    empty.destroy();
    const reopened = setup(never, { store, online: () => false });
    await reopened.controller.start();
    expect(reopened.controller.state.ready).toBe(false);
    expect(reopened.texts).not.toContain("");
    reopened.controller.stop();
  });
});
