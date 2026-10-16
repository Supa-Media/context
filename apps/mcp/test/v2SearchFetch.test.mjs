/**
 * `search` and `fetch` in the v2 shape: every id row of the table, the ChatGPT
 * branch, and the refusals. `translate.js` (the caller) carries `context` and
 * `mailbox`; these functions must never put them in a result.
 *
 * The unit half is pure. The end-to-end half runs through `callToolForSession`'s
 * real entry point (`worker.fetch`) against a bucket stub, so the translated
 * call meets the same authority gates a v1 call does.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/tools/v2/searchFetch.js` and reverted.
 * Counts are the checks that failed.
 *
 * 1. **The `.md` precedence reversed (read_note first)** — the meeting, day,
 *    contact, image and lists rows fail.
 * 2. **The message anchor not split** — the anchor row fails: `read_note` gets
 *    `1-projects/a.md#abc` and the note is not found.
 * 3. **The ChatGPT branch removed** — the no-args rows fail.
 * 4. **`context` allowed inside args and passed through** — the addressing row fails.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { translateFetch, translateSearch } from "../src/tools/v2/searchFetch.js";
import worker from "../src/index.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const GPT = { client: "chatgpt" };
const OPENAI = { client: "openai-mcp" };
const CLAUDE = { client: "claude-code" };

describe("translateSearch", () => {
  it("sends a plain search to search_notes with its query", () => {
    assert.deepEqual(translateSearch({ query: "garden" }, CLAUDE), {
      name: "search_notes",
      arguments: { query: "garden" },
      action: "notes",
    });
  });

  it("passes prefix through, and omits it when absent", () => {
    assert.deepEqual(translateSearch({ query: "q", args: { prefix: "1-projects" } }, CLAUDE).arguments, {
      query: "q",
      prefix: "1-projects",
    });
    assert.deepEqual(translateSearch({ query: "q", args: {} }, CLAUDE).arguments, { query: "q" });
    assert.deepEqual(translateSearch({ query: "q", args: { prefix: undefined } }, CLAUDE).arguments, { query: "q" });
  });

  it("refuses any other key in args, naming the one search takes", () => {
    const out = translateSearch({ query: "q", args: { prefix: "a", limit: 3 } }, CLAUDE);
    assert.equal(out.error, "search takes args: prefix. orient lists what each id takes.");
    assert.equal(out.arguments, undefined);
  });

  it("refuses a non-object args", () => {
    assert.match(translateSearch({ query: "q", args: "prefix" }, CLAUDE).error, /args has to be an object/);
    assert.match(translateSearch({ query: "q", args: ["x"] }, CLAUDE).error, /args has to be an object/);
  });

  it("refuses context or mailbox written inside args, and never returns them", () => {
    assert.match(translateSearch({ query: "q", args: { context: "@supa" } }, CLAUDE).error, /context goes beside args/);
    assert.match(translateSearch({ query: "q", args: { mailbox: "x" } }, CLAUDE).error, /mailbox goes beside args/);
    const plain = translateSearch({ query: "q", context: "@supa", mailbox: "m" }, CLAUDE);
    assert.equal("context" in plain.arguments, false);
    assert.equal("mailbox" in plain.arguments, false);
  });

  it("keeps the deep-research search for ChatGPT when args are not given", () => {
    for (const app of [GPT, OPENAI, { client: "ChatGPT-Desktop" }]) {
      assert.deepEqual(translateSearch({ query: "garden" }, app), {
        name: "search",
        arguments: { query: "garden" },
        action: "notes",
      });
    }
  });

  it("translates ChatGPT's search to search_notes when args are given", () => {
    assert.deepEqual(translateSearch({ query: "q", args: { prefix: "2-areas" } }, GPT).name, "search_notes");
    assert.deepEqual(translateSearch({ query: "q", args: {} }, GPT).name, "search_notes");
  });

  it("treats a client that is not ChatGPT as everybody else", () => {
    assert.equal(translateSearch({ query: "q" }, { client: null }).name, "search_notes");
    assert.equal(translateSearch({ query: "q" }, {}).name, "search_notes");
    assert.equal(translateSearch({ query: "q" }).name, "search_notes");
  });
});

describe("translateFetch: keyword ids", () => {
  const cases = [
    ["meetings:", {}, "list_meetings", {}],
    ["meetings:", { limit: 5 }, "list_meetings", { limit: 5 }],
    ["messages:", {}, "list_channel_days", {}],
    ["messages:", { channel: "email", account: "work-at-example-com", limit: 3 }, "list_channel_days", { channel: "email", account: "work-at-example-com", limit: 3 }],
    ["contacts:", { limit: 7 }, "list_contacts", { limit: 7 }],
    ["activity:", { limit: 9 }, "read_activity", { limit: 9 }],
    ["changes:", {}, "list_changes", {}],
    ["changes:", { limit: 4, reads: true }, "list_changes", { limit: 4, reads: true }],
    ["proposals:", {}, "list_proposals", {}],
    ["links:", {}, "list_links", {}],
    ["vault:", {}, "vault_list", {}],
    ["plugins:", {}, "list_plugins", {}],
    ["access:", {}, "scope_info", {}],
    ["access:", { path: "1-projects/x.md", workspaces: true }, "scope_info", { path: "1-projects/x.md", workspaces: true }],
  ];
  for (const [id, args, name, expected] of cases) {
    it(`${id} with ${JSON.stringify(args)} is ${name}`, () => {
      const out = translateFetch({ id, args: Object.keys(args).length ? args : undefined }, CLAUDE);
      assert.equal(out.name, name);
      assert.deepEqual(out.arguments, expected);
      assert.equal(typeof out.action, "string");
    });
  }

  it("trims the keyword before matching it", () => {
    assert.equal(translateFetch({ id: "  meetings:  " }, CLAUDE).name, "list_meetings");
  });

  it("matches keywords case-sensitively", () => {
    // Not a keyword, no .md, no trailing slash: a folder named that way.
    assert.deepEqual(translateFetch({ id: "Meetings:" }, CLAUDE), {
      name: "list_notes",
      arguments: { prefix: "Meetings:" },
      action: "list",
    });
  });

  it("refuses an arg a keyword id does not take, naming what it takes", () => {
    assert.equal(
      translateFetch({ id: "links:", args: { limit: 2 } }, CLAUDE).error,
      'fetch "links:" takes no args. orient lists what each id takes.',
    );
    assert.equal(
      translateFetch({ id: "meetings:", args: { reads: true } }, CLAUDE).error,
      'fetch "meetings:" takes args: limit. orient lists what each id takes.',
    );
    assert.match(translateFetch({ id: "vault:", args: { fetch: {} } }, CLAUDE).error, /takes no args/);
    assert.match(translateFetch({ id: "changes:", args: { path: "x" } }, CLAUDE).error, /takes args: limit, reads/);
  });

  it("never passes fetch through the vault id", () => {
    const out = translateFetch({ id: "vault:" }, CLAUDE);
    assert.equal(out.name, "vault_list");
    assert.equal("fetch" in out.arguments, false);
  });
});

describe("translateFetch: proposals:<id>", () => {
  it("reads one proposal by its id", () => {
    assert.deepEqual(translateFetch({ id: "proposals:p_123" }, CLAUDE), {
      name: "read_proposal",
      arguments: { id: "p_123" },
      action: "proposal",
    });
  });

  it("refuses args on one proposal", () => {
    assert.equal(
      translateFetch({ id: "proposals:p_1", args: { limit: 1 } }, CLAUDE).error,
      'fetch "proposals:p_1" takes no args. orient lists what each id takes.',
    );
  });
});

describe("translateFetch: note paths", () => {
  it("reads a note by its path, with no args", () => {
    assert.deepEqual(translateFetch({ id: "1-projects/togather/status.md" }, CLAUDE), {
      name: "read_note",
      arguments: { path: "1-projects/togather/status.md" },
      action: "note",
    });
  });

  it("passes mail through, and omits it when absent", () => {
    assert.deepEqual(translateFetch({ id: "a.md", args: { mail: "all" } }, CLAUDE).arguments, { path: "a.md", mail: "all" });
    assert.deepEqual(translateFetch({ id: "a.md", args: { mail: true } }, CLAUDE).arguments, { path: "a.md", mail: true });
    assert.deepEqual(translateFetch({ id: "a.md", args: {} }, CLAUDE).arguments, { path: "a.md" });
  });

  it("reads an image out of a note", () => {
    assert.deepEqual(
      translateFetch({ id: "1-projects/a.md", args: { image: ".context/assets/images/h.png" } }, CLAUDE),
      { name: "read_image", arguments: { note: "1-projects/a.md", image: ".context/assets/images/h.png" }, action: "image" },
    );
  });

  it("evaluates a note's lists when lists is true", () => {
    assert.deepEqual(translateFetch({ id: "1-projects/a.md", args: { lists: true } }, CLAUDE), {
      name: "evaluate_lists",
      arguments: { path: "1-projects/a.md" },
      action: "lists",
    });
  });

  it("reads a meeting's transcript when transcript is given, even false", () => {
    assert.deepEqual(translateFetch({ id: "0-inbox/meetings/m.md", args: { transcript: true } }, CLAUDE), {
      name: "read_meeting",
      arguments: { path: "0-inbox/meetings/m.md", transcript: true },
      action: "meeting",
    });
    assert.deepEqual(translateFetch({ id: "0-inbox/meetings/m.md", args: { transcript: false } }, CLAUDE).arguments, {
      path: "0-inbox/meetings/m.md",
      transcript: false,
    });
  });

  it("reads a channel day's messages when messages is given", () => {
    assert.deepEqual(translateFetch({ id: "0-inbox/email/d.md", args: { messages: true } }, CLAUDE), {
      name: "read_channel_day",
      arguments: { path: "0-inbox/email/d.md", messages: true },
      action: "day",
    });
  });

  it("reads a contact's activity when activity is given", () => {
    assert.deepEqual(translateFetch({ id: "contacts/ada.md", args: { activity: true } }, CLAUDE), {
      name: "read_contact",
      arguments: { path: "contacts/ada.md", activity: true },
      action: "contact",
    });
  });

  it("treats a lists value other than true as an unknown key on a note", () => {
    assert.equal(
      translateFetch({ id: "a.md", args: { lists: false } }, CLAUDE).error,
      'fetch "a.md" takes args: mail. orient lists what each id takes.',
    );
  });

  it("refuses an arg a note does not take, naming what it takes", () => {
    assert.equal(
      translateFetch({ id: "a.md", args: { transcript: true, messages: true } }, CLAUDE).error,
      'fetch "a.md" takes args: transcript. orient lists what each id takes.',
    );
    assert.equal(
      translateFetch({ id: "a.md", args: { image: "x.png", mail: true } }, CLAUDE).error,
      'fetch "a.md" takes args: image. orient lists what each id takes.',
    );
    assert.equal(
      translateFetch({ id: "a.md", args: { limit: 3 } }, CLAUDE).error,
      'fetch "a.md" takes args: mail. orient lists what each id takes.',
    );
  });

  it("drops a message anchor and reads the note it names", () => {
    assert.deepEqual(translateFetch({ id: "0-inbox/email/d.md#msg-0123456789abcdef" }, CLAUDE), {
      name: "read_note",
      arguments: { path: "0-inbox/email/d.md" },
      action: "note",
    });
  });

  it("still applies a message anchor's note args", () => {
    assert.deepEqual(translateFetch({ id: "0-inbox/email/d.md#msg-0123456789abcdef", args: { messages: true } }, CLAUDE).name, "read_channel_day");
  });

  it("keeps a # that is not a message anchor as an ordinary character", () => {
    assert.deepEqual(translateFetch({ id: "notes/c#sharp.md" }, CLAUDE).arguments, { path: "notes/c#sharp.md" });
  });

  it("passes an @name path through unchanged, for routing to address", () => {
    assert.deepEqual(translateFetch({ id: "@band/gigs/show.md" }, CLAUDE).arguments, { path: "@band/gigs/show.md" });
    assert.deepEqual(translateFetch({ id: "@band/gigs/" }, CLAUDE).arguments, { prefix: "@band/gigs" });
  });
});

describe("translateFetch: folders", () => {
  it("lists a folder named with a trailing slash, without the slash", () => {
    assert.deepEqual(translateFetch({ id: "1-projects/" }, CLAUDE), {
      name: "list_notes",
      arguments: { prefix: "1-projects" },
      action: "list",
    });
  });

  it("lists a folder named without a trailing slash", () => {
    assert.deepEqual(translateFetch({ id: "1-projects" }, CLAUDE).arguments, { prefix: "1-projects" });
  });

  it("lists everything for an empty id or a bare slash", () => {
    assert.deepEqual(translateFetch({ id: "" }, CLAUDE).arguments, {});
    assert.deepEqual(translateFetch({ id: "/" }, CLAUDE).arguments, {});
    assert.equal(translateFetch({ id: "/" }, CLAUDE).name, "list_notes");
  });

  it("refuses args on a folder, which takes none", () => {
    assert.equal(
      translateFetch({ id: "1-projects/", args: { mail: true } }, CLAUDE).error,
      'fetch "1-projects/" takes no args. orient lists what each id takes.',
    );
  });
});

describe("translateFetch: ChatGPT", () => {
  it("keeps the deep-research fetch when args are not given", () => {
    for (const app of [GPT, OPENAI]) {
      assert.deepEqual(translateFetch({ id: "1-projects/a.md" }, app), {
        name: "fetch",
        arguments: { id: "1-projects/a.md" },
        action: "note",
      });
    }
  });

  it("passes a ChatGPT fetch id for an anchored result to the deep-research fetch unchanged", () => {
    assert.equal(translateFetch({ id: "0-inbox/email/d.md#msg-0123456789abcdef" }, GPT).name, "fetch");
  });

  it("translates ChatGPT's fetch to the keyword and note targets when args are given", () => {
    assert.equal(translateFetch({ id: "meetings:", args: { limit: 2 } }, GPT).name, "list_meetings");
    assert.equal(translateFetch({ id: "a.md", args: { mail: "new" } }, GPT).name, "read_note");
    assert.deepEqual(translateFetch({ id: "1-projects/", args: {} }, GPT).arguments, { prefix: "1-projects" });
  });

  it("does not treat a non-ChatGPT client as ChatGPT", () => {
    assert.equal(translateFetch({ id: "a.md" }, CLAUDE).name, "read_note");
  });
});

describe("translateFetch: refusals and shapes", () => {
  it("needs a string id", () => {
    assert.match(translateFetch({}, CLAUDE).error, /fetch needs an id/);
    assert.match(translateFetch({ id: 3 }, CLAUDE).error, /fetch needs an id/);
    assert.match(translateFetch({ id: 3 }, GPT).error, /fetch needs an id/);
  });

  it("refuses a non-object args", () => {
    assert.match(translateFetch({ id: "a.md", args: "mail" }, CLAUDE).error, /args has to be an object/);
  });

  it("refuses context or mailbox written inside args", () => {
    assert.match(translateFetch({ id: "a.md", args: { context: "@supa" } }, CLAUDE).error, /context goes beside args/);
  });

  it("never echoes more than 40 characters of the id in a refusal", () => {
    const long = `links:${"x".repeat(200)}`;
    const out = translateFetch({ id: long, args: { limit: 1 } }, CLAUDE);
    assert.match(out.error, /takes no args/);
    const shown = /fetch "([^"]*)"/.exec(out.error)[1];
    assert.equal(shown.length, 41);
    assert.ok(shown.endsWith("…"));
    assert.equal(out.error.includes("x".repeat(100)), false);
  });

  it("returns no context or mailbox in any result", () => {
    const results = [
      translateFetch({ id: "a.md", context: "@supa", mailbox: "m" }, CLAUDE),
      translateFetch({ id: "meetings:", context: "@supa" }, CLAUDE),
      translateFetch({ id: "1-projects/", mailbox: "m" }, CLAUDE),
      translateFetch({ id: "a.md", context: "@supa" }, GPT),
    ];
    for (const out of results) {
      assert.equal("context" in out.arguments ?? {}, false);
      assert.equal("mailbox" in out.arguments ?? {}, false);
      assert.equal("context" in out, false);
    }
  });
});

/* ------------------------------ end to end ------------------------------ */

const OWNER_TOKEN = `cat_v2sf_owner_${"0".repeat(18)}`;
const TEAM_TOKEN = `cat_v2sf_team_${"0".repeat(19)}`;

const MANIFEST =
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

const PLAN = "1-projects/plan.md";
const SECRET = "2-areas/secret.md";
const PLAN_TEXT = "# Plan\n\nShip the search and fetch translation.\n";

function createBucket() {
  const objects = new Map();
  let etags = 0;
  return {
    seed(key, body) {
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        etag: stored.etag,
        text: async () => stored.body,
        arrayBuffer: async () => new TextEncoder().encode(stored.body).buffer,
      };
    },
    async put(key, value) {
      const body = typeof value === "string" ? value : new TextDecoder().decode(value);
      objects.set(key, { body, etag: `e${++etags}`, uploaded: new Date() });
      return { etag: `e${etags}` };
    },
    async delete(key) {
      objects.delete(key);
      return {};
    },
    async list({ prefix } = {}) {
      return {
        objects: [...objects.keys()]
          .filter((key) => !prefix || key.startsWith(prefix))
          .sort()
          .map((key) => ({
            key,
            size: objects.get(key).body.length,
            uploaded: objects.get(key).uploaded,
            etag: objects.get(key).etag,
          })),
        truncated: false,
      };
    },
  };
}

async function rpc(env, token, method, params) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx,
  );
  const body = await response.json();
  await settle();
  return body;
}

async function call(env, token, name, args = {}) {
  const result = (await rpc(env, token, "tools/call", { name, arguments: args }))?.result;
  return { text: result?.content?.[0]?.text ?? "", isError: result?.isError === true };
}

describe("end to end through callToolForSession", { concurrency: false }, () => {
  let env;
  let restore;

  before(async () => {
    const bucket = createBucket();
    const controlPlane = createControlPlaneStub();
    restore = controlPlane.install();
    controlPlane.addWorkspace("ws_v2sf", "seyi", {
      provider: "r2-binding",
      bindingName: "V2SF_BUCKET",
      capabilities: { conditionalWrite: true, conditionalCreate: true },
      status: "active",
    });
    await controlPlane.addGrant({
      accessToken: OWNER_TOKEN,
      workspaceId: "ws_v2sf",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_v2sf_owner",
      userId: "user_seyi",
    });
    // Team tier: no private grant, so a `private` note is not theirs to see.
    await controlPlane.addGrant({
      accessToken: TEAM_TOKEN,
      workspaceId: "ws_v2sf",
      role: "owner",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_v2sf_team",
      userId: "user_seyi",
    });
    env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "V2SF_BUCKET",
      V2SF_BUCKET: bucket,
    };
    controlPlane.serveTreesFrom(env);
    bucket.seed("privacy.md", MANIFEST);
    bucket.seed("index.md", "# Context\n");
    bucket.seed(PLAN, PLAN_TEXT);
    bucket.seed(SECRET, "# Secret\n\nPrivate to the owner.\n");
  });

  after(() => restore?.());

  it("fetch of a note returns its text and an etag", async () => {
    const out = await call(env, OWNER_TOKEN, "fetch", { id: PLAN });
    assert.equal(out.isError, false);
    assert.match(out.text, /Ship the search and fetch translation\./);
    assert.match(out.text, /etag/i);
  });

  it("fetch of a folder with a trailing slash lists its notes", async () => {
    const out = await call(env, OWNER_TOKEN, "fetch", { id: "1-projects/" });
    assert.equal(out.isError, false);
    assert.match(out.text, /1-projects\/plan\.md/);
    assert.equal(out.text.includes(SECRET), false);
  });

  it("a team-tier caller fetching a private note gets the same answer as a missing note", async () => {
    const hidden = await call(env, TEAM_TOKEN, "fetch", { id: SECRET });
    const absent = await call(env, TEAM_TOKEN, "fetch", { id: "2-areas/never-written.md" });
    assert.equal(hidden.isError, absent.isError);
    assert.equal(hidden.text, absent.text);
    assert.equal(hidden.text.includes("Private to the owner"), false);
  });

  it("fetch of links: from a team-tier caller is refused as list_links is", async () => {
    const viaFetch = await call(env, TEAM_TOKEN, "fetch", { id: "links:" });
    const direct = await call(env, TEAM_TOKEN, "list_links", {});
    assert.equal(viaFetch.text, direct.text);
    assert.equal(viaFetch.isError, direct.isError);
  });
});
