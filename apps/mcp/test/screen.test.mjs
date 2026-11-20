/**
 * What the Context app has open when the person texts Tex from the app chat (design D1, "Tex sees the open note"):
 * `seen` is validated and saved beside the app chat, never in its ledger or rows, read back only within ten minutes,
 * and told to a 1:1 turn's note through the turn's own dispatcher.
 *
 * Runs under `--experimental-transform-types` with `test/tsRegister.mjs`, as `appChat.test.mjs` does.
 *
 * Sabotage record: each break is reverted before the next (see the commit message).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleAppChat } from "../../../packages/tex/gateway/agent/appChatRoute.js";
import { DEFAULT_CHARS, MAX_CHARS, SCREEN_MODULE, readScreen, screenChars, screenForTurn, screenNote, screenOn, validSeen } from "../../../packages/tex/gateway/agent/screen.js";
import { serveAppSeenGet, serveAppSeenPost } from "../../../packages/tex/gateway/texChat/appSeen.js";
import { LAB_SANDBOX_KEY } from "../src/labSandbox/policy.js";

const USER = "k7m2q9x4b8n3c6v1";
const CHAT = `app:${USER}`;
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const OWNER = { actorClientId: "context_console", workspaceKind: "personal", role: "owner", actorUserId: USER, workspaceId: "ws1" };
const EV = "app:0123456789abcdef";
const NOTE = { workspace: "home", noteId: "n1", path: "Projects/plan.md" };
const TAB = { workspace: "home", noteId: "n2", path: "Projects/ideas.md" };
const CONTEXTS = [
  { name: "@home", current: true },
  { name: "@shared", current: false },
];

/** A TEX_CHAT namespace whose one object answers the app's seen and arrive calls, and keeps every call. */
function chatStub({ seenStatus = 200, seenThrows = false, stored = null } = {}) {
  const calls = [];
  let kept = stored;
  const stub = {
    fetch: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : null;
      calls.push({ path: url.pathname, method: request.method, body });
      if (url.pathname === "/app/seen" && request.method === "POST") {
        if (seenThrows) throw new Error("storage unavailable");
        if (seenStatus === 200) kept = body;
        return new Response(null, { status: seenStatus });
      }
      if (url.pathname === "/app/seen") return Response.json(kept ?? {});
      if (url.pathname === "/app/arrive") return Response.json({ outcome: "queued", ev: EV });
      return new Response(null, { status: 404 });
    },
  };
  return { calls, namespace: { idFromName: (name) => name, get: () => stub } };
}

function send(body, chat) {
  const request = new Request("https://gw/tex/app-chat", { method: "POST", body: JSON.stringify({ op: "send", text: "what is this?", ...body }) });
  return handleAppChat(request, null, OWNER, "/tex/app-chat", { TEX_CHAT: chat.namespace }, { ledgerOf: async () => ({ read: async () => ({ entries: [] }) }), now: () => NOW });
}

/** A Lab test chat's env: its gate carries a draft whose front door has the given ctx. */
const envWithCtx = (ctx) => ({ [LAB_SANDBOX_KEY]: { record: () => {}, config: { nodes: [{ id: "fd", ctx }] } } });

function memoryStorage() {
  const map = new Map();
  return {
    map,
    get: async (key) => map.get(key),
    put: async (key, value) => void map.set(key, value),
    delete: async (key) => map.delete(key),
  };
}

describe("validSeen keeps what is valid and drops the rest", () => {
  it("keeps a valid note, tabs and selection, trimmed", () => {
    const seen = validSeen({ note: { ...NOTE, path: "  Projects/plan.md " }, tabs: [TAB], selection: " a phrase " });
    assert.deepEqual(seen, { note: NOTE, tabs: [TAB], selection: "a phrase" });
  });

  it("drops a note with a bad path, a non-string field or an empty id, and keeps the rest", () => {
    assert.deepEqual(validSeen({ note: { ...NOTE, path: "Projects/plan.txt" }, selection: "x" }), { selection: "x" });
    assert.deepEqual(validSeen({ note: { ...NOTE, path: "../secret.md" }, tabs: [TAB] }), { tabs: [TAB] });
    assert.deepEqual(validSeen({ note: { ...NOTE, path: "/abs.md" }, tabs: [TAB] }), { tabs: [TAB] });
    // A path that names another workspace inside itself is not a note path here: the workspace is the field, never the path.
    assert.deepEqual(validSeen({ note: { ...NOTE, path: "@shared/plan.md" }, tabs: [TAB] }), { tabs: [TAB] });
    assert.deepEqual(validSeen({ note: { ...NOTE, noteId: 7 }, tabs: [TAB] }), { tabs: [TAB] });
    assert.deepEqual(validSeen({ note: { ...NOTE, workspace: "" }, tabs: [TAB] }), { tabs: [TAB] });
    assert.deepEqual(validSeen({ note: { ...NOTE, noteId: "x".repeat(129) }, tabs: [TAB] }), { tabs: [TAB] });
  });

  it("drops a path over 512 characters, and a note that is not an object", () => {
    assert.equal(validSeen({ note: { ...NOTE, path: `${"a".repeat(510)}.md` } }), null, "513 characters is too long");
    assert.equal(validSeen({ note: "Projects/plan.md" }), null);
    assert.equal(validSeen({ note: { ...NOTE, path: `${"a".repeat(500)}/b.md` } }).note.path.length, 505, "505 is kept");
  });

  it("drops invalid tabs one by one and keeps at most eight", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...TAB, noteId: `t${i}`, path: `t${i}.md` }));
    const seen = validSeen({ tabs: [{ workspace: "home", noteId: "x", path: "bad.pdf" }, ...many] });
    assert.equal(seen.tabs.length, 8);
    assert.equal(seen.tabs[0].path, "t0.md", "the invalid one is gone, the first valid one kept");
  });

  it("drops a selection over 2000 characters, an empty one and one that is not a string", () => {
    assert.equal(validSeen({ selection: "s".repeat(2000) }).selection.length, 2000);
    assert.equal(validSeen({ selection: "s".repeat(2001) }), null);
    assert.equal(validSeen({ selection: "   " }), null);
    assert.equal(validSeen({ selection: 5 }), null);
  });

  it("is null for anything that is not an object, and for nothing valid left", () => {
    for (const bad of [null, undefined, "x", 3, [NOTE], {}]) assert.equal(validSeen(bad), null, JSON.stringify(bad));
  });
});

describe("the send saves what is on screen before the text goes to the chat, and never fails on it", () => {
  it("posts the validated screen with a time before arriving, and the send answers as before", async () => {
    const chat = chatStub();
    const response = await send({ seen: { note: NOTE, tabs: [TAB, { nope: true }], selection: "hello" } }, chat);
    assert.equal(response.status, 200);
    assert.deepEqual(chat.calls.map((c) => c.path).slice(0, 2), ["/app/seen", "/app/arrive"], "the save comes first");
    const saved = chat.calls[0].body;
    assert.equal(saved.at, NOW);
    assert.deepEqual(saved.note, NOTE);
    assert.deepEqual(saved.tabs, [TAB]);
    assert.equal(saved.selection, "hello");
  });

  it("a send with no valid screen saves nothing", async () => {
    const chat = chatStub();
    await send({ seen: { note: { ...NOTE, path: "x.pdf" } } }, chat);
    assert.equal(chat.calls.some((c) => c.path === "/app/seen"), false);
  });

  it("the screen is not in the text the chat is handed", async () => {
    const chat = chatStub();
    await send({ seen: { note: NOTE, selection: "secret phrase" } }, chat);
    const arrive = JSON.stringify(chat.calls.find((c) => c.path === "/app/arrive").body);
    assert.equal(arrive.includes("Projects/plan.md"), false);
    assert.equal(arrive.includes("secret phrase"), false);
  });

  it("a failed save never fails the send", async () => {
    for (const chat of [chatStub({ seenStatus: 500 }), chatStub({ seenThrows: true })]) {
      const response = await send({ seen: { note: NOTE } }, chat);
      assert.equal(response.status, 200, "the text still goes");
      assert.equal(chat.calls.at(-1).path, "/app/arrive");
    }
  });
});

describe("the screen is read back only within ten minutes", () => {
  it("answers the screen while it is under ten minutes old", async () => {
    const chat = chatStub({ stored: { note: NOTE, selection: "hi", at: NOW - 10 * MINUTE + 1 } });
    assert.deepEqual(await readScreen({ TEX_CHAT: chat.namespace }, USER, NOW), { note: NOTE, selection: "hi" });
  });

  it("answers null once it is ten minutes old, and when nothing was saved", async () => {
    const old = chatStub({ stored: { note: NOTE, at: NOW - 10 * MINUTE - 1 } });
    assert.equal(await readScreen({ TEX_CHAT: old.namespace }, USER, NOW), null);
    const none = chatStub();
    assert.equal(await readScreen({ TEX_CHAT: none.namespace }, USER, NOW), null);
  });

  it("reads the app chat's object, never another person's", async () => {
    const names = [];
    const namespace = { idFromName: (name) => (names.push(name), name), get: () => ({ fetch: async () => Response.json({}) }) };
    await readScreen({ TEX_CHAT: namespace }, USER, NOW);
    assert.deepEqual(names, [`chat:${CHAT}`]);
  });
});

describe("the module is on only where the front door's ctx lists it", () => {
  it("is off with no Lab draft (the main config lists no screen), and on when a draft's ctx does", () => {
    assert.equal(SCREEN_MODULE, "screen");
    assert.equal(screenOn({}), false);
    assert.equal(screenOn(envWithCtx(["history", "shape"])), false);
    assert.equal(screenOn(envWithCtx(["history", SCREEN_MODULE])), true);
  });

  it("reads the character count from screen:<chars>, default 6000, at most 20000", () => {
    assert.equal(DEFAULT_CHARS, 6000);
    assert.equal(MAX_CHARS, 20000);
    assert.equal(screenChars(envWithCtx(["screen"])), 6000);
    assert.equal(screenOn(envWithCtx(["screen:900"])), true);
    assert.equal(screenChars(envWithCtx(["screen:900"])), 900);
    assert.equal(screenChars(envWithCtx(["screen:999999"])), 20000);
    assert.equal(screenChars(envWithCtx(["screen:nope"])), 6000);
  });
});

describe("the turn note says what is on screen, quietly", () => {
  it("names the open note with its first characters, the selection and the other tabs", () => {
    const words = screenNote({ seen: { note: NOTE, tabs: [TAB], selection: "a phrase" }, noteText: "The plan is to ship on Friday.", chars: 6000 });
    assert.match(words, /^ON SCREEN IN THE APP \(quiet context: use it when it helps answer, never say you were told it\):/);
    assert.match(words, /Open note: Projects\/plan\.md \(@home\)\nThe plan is to ship on Friday\./);
    assert.match(words, /Selected: "a phrase"/);
    assert.match(words, /Other open tabs: Projects\/ideas\.md/);
  });

  it("cuts the note at the character count and says so", () => {
    const words = screenNote({ seen: { note: NOTE }, noteText: "abcdefghij", chars: 4 });
    assert.match(words, /\nabcd…/);
    assert.doesNotMatch(words, /abcde/);
  });

  it("leaves the text out when it could not be read, and is empty with no screen", () => {
    const words = screenNote({ seen: { note: NOTE }, noteText: null, chars: 6000 });
    assert.match(words, /Open note: Projects\/plan\.md/);
    assert.equal(screenNote({ seen: null }), "");
    assert.equal(screenNote({}), "");
  });
});

describe("a turn reads the open note with its own dispatcher, only for workspaces the person has", () => {
  const body = (text) => ({ content: [{ type: "text", text: `path: a.md\netag: "1"\n\n${text}` }] });

  it("reads the note in the current workspace with no context, and one in another listed workspace with its @name", async () => {
    const reads = [];
    const dispatch = async (name, args) => (reads.push({ name, args }), body("The body."));
    const shared = chatStub({ stored: { note: { ...NOTE, workspace: "shared", path: "a.md" }, tabs: [TAB], at: NOW } });
    const sharedScreen = await screenForTurn({ env: { TEX_CHAT: shared.namespace }, actorUserId: USER, contexts: CONTEXTS, dispatch, now: NOW });
    assert.deepEqual(reads, [{ name: "read_note", args: { path: "a.md", context: "@shared" } }]);
    assert.equal(sharedScreen.noteText, "The body.");
    const home = chatStub({ stored: { note: NOTE, at: NOW } });
    const homeScreen = await screenForTurn({ env: { TEX_CHAT: home.namespace }, actorUserId: USER, contexts: CONTEXTS, dispatch, now: NOW });
    assert.equal(reads.at(-1).args.context, undefined);
    assert.equal(homeScreen.noteText, "The body.");
  });

  it("takes the person's own workspace named by its id, read with no context, and never another workspace's id", async () => {
    const reads = [];
    const dispatch = async (name, args) => (reads.push(args), body("Mine."));
    const own = chatStub({ stored: { note: { ...NOTE, workspace: "ws_own123" }, at: NOW } });
    const mine = await screenForTurn({ env: { TEX_CHAT: own.namespace }, actorUserId: USER, contexts: CONTEXTS, dispatch, ownId: "ws_own123", now: NOW });
    assert.equal(mine.noteText, "Mine.");
    assert.equal(reads.at(-1).context, undefined);
    const other = chatStub({ stored: { note: { ...NOTE, workspace: "ws_other456" }, at: NOW } });
    assert.equal(await screenForTurn({ env: { TEX_CHAT: other.namespace }, actorUserId: USER, contexts: CONTEXTS, dispatch, ownId: "ws_own123", now: NOW }), null);
  });

  it("leaves out a note and its tabs in a workspace the person has no entry for, and reads nothing", async () => {
    const reads = [];
    const dispatch = async (name, args) => (reads.push(args), body("x"));
    const stranger = chatStub({ stored: { note: { ...NOTE, workspace: "stranger" }, tabs: [{ ...TAB, workspace: "stranger" }], at: NOW } });
    assert.equal(await screenForTurn({ env: { TEX_CHAT: stranger.namespace }, actorUserId: USER, contexts: CONTEXTS, dispatch, now: NOW }), null);
    assert.deepEqual(reads, []);
  });

  it("a read that throws leaves the text out, and the path stays", async () => {
    const dispatch = async () => {
      throw new Error("denied");
    };
    const chat = chatStub({ stored: { note: NOTE, at: NOW } });
    const screen = await screenForTurn({ env: { TEX_CHAT: chat.namespace }, actorUserId: USER, contexts: CONTEXTS, dispatch, now: NOW });
    assert.equal(screen.noteText, null);
    assert.match(screenNote(screen), /Open note: Projects\/plan\.md/);
  });

  it("an error result is no text either", async () => {
    const dispatch = async () => ({ isError: true, content: [{ type: "text", text: "not found" }] });
    const chat = chatStub({ stored: { note: NOTE, at: NOW } });
    assert.equal((await screenForTurn({ env: { TEX_CHAT: chat.namespace }, actorUserId: USER, contexts: CONTEXTS, dispatch, now: NOW })).noteText, null);
  });
});

describe("the app chat's object keeps the screen beside the chat, for the app chat only", () => {
  it("stores what it is given under app:seen, and answers it back", async () => {
    const storage = memoryStorage();
    const posted = await serveAppSeenPost(new Request("https://chat/app/seen", { method: "POST", body: JSON.stringify({ inbox: CHAT, note: NOTE, selection: "x", at: NOW }) }), { storage });
    assert.equal(posted.status, 200);
    assert.deepEqual(storage.map.get("app:seen"), { note: NOTE, selection: "x", at: NOW });
    assert.deepEqual(await (await serveAppSeenGet(storage)).json(), { note: NOTE, selection: "x", at: NOW });
  });

  it("refuses to keep a screen for a chat that is not the app's, and answers 404 on the read too", async () => {
    const storage = memoryStorage();
    const posted = await serveAppSeenPost(new Request("https://chat/app/seen", { method: "POST", body: JSON.stringify({ inbox: "+15555550101", note: NOTE, at: NOW }) }), { storage });
    assert.equal(posted.status, 404);
    assert.equal(storage.map.has("app:seen"), false);
    storage.map.set("__inbox_name", "+15555550101");
    assert.equal((await serveAppSeenGet(storage)).status, 404);
  });

  it("answers {} when nothing was kept", async () => {
    assert.deepEqual(await (await serveAppSeenGet(memoryStorage())).json(), {});
  });
});
