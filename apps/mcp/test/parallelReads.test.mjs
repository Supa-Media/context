/**
 * A front-door round runs its tool calls together only when every one is a
 * read on the allowlist (`parallelReads.js`). Two slow mailbox searches take
 * the time of the slower one. A write in the round keeps every call serial,
 * and so does `vault_list` with `fetch` (`send` action `api`). Results are
 * still appended in call order, and a thrown call is still that call's error.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BUILTIN_PROVIDER } from "../src/agent/builtin.js";
import { isParallelRead, PARALLEL_READS, roundIsParallel } from "../src/agent/parallelReads.js";
import { sixToolsOver } from "../src/agent/sixTools.js";
import { runTurn } from "../src/agent/turn.js";
import { translateFetch, translateSearch } from "../src/tools/v2/searchFetch.js";
import { EMAIL_ID_PREFIX } from "../src/tools/emailRead.js";
import { GOOGLE_CHAT_ID_PREFIX } from "../src/tools/googleChatRead.js";
import { TEXTS_ID_PREFIX } from "../src/tools/texts.js";

const MODEL = "@cf/zai-org/glm-4.7-flash";

const SEARCH_NOTES = {
  name: "search_notes",
  description: "Search notes",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  annotations: { readOnlyHint: true },
};
const SEARCH_EMAIL = {
  name: "search_email",
  description: "Search email",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, account: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};
const WRITE_NOTE = {
  name: "write_note",
  description: "Write a note",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false },
};
const SEARCH_WEB = {
  name: "search_web",
  description: "Search the web",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  annotations: { readOnlyHint: true },
};
const VAULT_LIST = {
  name: "vault_list",
  description: "List saved logins, or call one API with a saved key",
  inputSchema: { type: "object", properties: { fetch: { type: "object" } }, additionalProperties: false },
  annotations: { readOnlyHint: true },
};
// A vault fetch: an outbound request with a saved key attached. No secret here.
const VAULT_FETCH = { entry: "entry-1", field: "API_KEY", url: "https://api.example.com/v1/items", method: "POST" };

function scripted(replies) {
  const calls = [];
  return {
    calls,
    async run(_model, input) {
      calls.push({ input });
      const next = replies.shift();
      if (!next) throw new Error("fake ai: the script ran out");
      return next;
    },
  };
}

function completion(text, calls = []) {
  return {
    choices: [
      {
        message: {
          content: text,
          tool_calls: calls.map((call, i) => ({
            id: `call_${i}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function turn(ai, overrides) {
  return runTurn({
    question: "What came in?",
    credential: { provider: BUILTIN_PROVIDER, apiKey: null },
    tools: [SEARCH_NOTES, SEARCH_EMAIL, WRITE_NOTE],
    env: { AI: ai, AGENT_BUILTIN_MODEL: MODEL },
    providerOptions: { ai },
    texting: true,
    ...overrides,
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toolTexts(ai) {
  return ai.calls.at(-1).input.messages.filter((message) => message.role === "tool").map((message) => message.content);
}

test("search, fetch and web search resolve to the allowlist, and a write, send or browser does not", () => {
  assert.equal(translateSearch({ query: "dentist" }).name, "search_notes");
  assert.equal(translateSearch({ query: "invoice", args: { email: true, account: "one@example.com" } }).name, "search_email");
  assert.equal(translateSearch({ query: "hello", args: { texts: true, with: "Ada" } }).name, "search_texts");
  for (const translated of [
    translateSearch({ query: "dentist" }),
    translateSearch({ query: "invoice", args: { email: true, account: "one@example.com" } }),
    translateSearch({ query: "hello", args: { texts: true, with: "Ada" } }),
  ]) {
    assert.equal(translated.error, undefined, translated.error);
    assert.equal(PARALLEL_READS.has(translated.name), true, translated.name);
  }

  const fetches = [
    ["1-projects/status.md", "read_note"],
    ["1-projects/status.md", "read_image", { image: "cover.png" }],
    ["1-projects/status.md", "related_notes", { related: true }],
    ["1-projects/status.md", "evaluate_lists", { lists: true }],
    ["1-projects/status.md", "read_meeting", { transcript: true }],
    ["1-projects/status.md", "read_channel_day", { messages: true }],
    ["1-projects/status.md", "read_contact", { activity: true }],
    ["inbox/receipt.pdf", "read_file"],
    ["1-projects/", "list_notes"],
    ["tex/history.ledger.json", "read_note"],
    ["notes:", "read_notes"],
    ["meetings:", "list_meetings"],
    ["calendar:", "read_calendar"],
    ["messages:", "list_channel_days"],
    ["contacts:", "list_contacts"],
    ["activity:", "read_activity"],
    ["changes:", "list_changes"],
    ["links:", "list_links"],
    ["vault:", "vault_list"],
    ["plugins:", "list_plugins"],
    ["access:", "scope_info"],
    ["texts:", "list_texts"],
    [`${TEXTS_ID_PREFIX}abc`, "read_texts"],
    [`${GOOGLE_CHAT_ID_PREFIX}spaces/abc`, "read_google_chat"],
    [`${EMAIL_ID_PREFIX}one@example.com/abc`, "read_email"],
  ];
  for (const [id, name, args] of fetches) {
    const translated = translateFetch({ id, ...(args ? { args } : {}) });
    assert.equal(translated.name, name, id);
    assert.equal(PARALLEL_READS.has(name), true, name);
  }
  // The same name posts a message, and app_read runs a tool the model names.
  assert.equal(translateFetch({ id: "chat:" }).name, "google_chat");
  assert.equal(translateFetch({ id: "apps:" }).name, "app_read");
  assert.equal(PARALLEL_READS.has("google_chat"), false);
  assert.equal(PARALLEL_READS.has("app_read"), false);

  const six = sixToolsOver([
    SEARCH_NOTES,
    SEARCH_EMAIL,
    { name: "read_skill", description: "Read a skill", inputSchema: { type: "object" } },
    { name: "group_chats", description: "Group chats", inputSchema: { type: "object" } },
    SEARCH_WEB,
    WRITE_NOTE,
    { name: "browse", description: "Browse", inputSchema: { type: "object" } },
    { name: "send_email", description: "Send email", inputSchema: { type: "object" } },
    { name: "google_chat", description: "Google Chat", inputSchema: { type: "object" } },
    { name: "start_background_job", description: "Start a job", inputSchema: { type: "object" } },
    { name: "open_page", description: "Open a page", inputSchema: { type: "object" } },
  ]);
  assert.equal(six.resolve("send", { action: "search_web", query: "katz deli" }).name, "search_web");
  assert.equal(six.resolve("fetch", { id: "skill:cooking" }).name, "read_skill");
  assert.equal(six.resolve("search", { query: "setlist", args: { groups: true } }).name, "group_chats");
  assert.equal(roundIsParallel(["search_email", "search_web", "read_note"]), true);
  assert.equal(roundIsParallel(["search_notes"]), false, "one call stays serial");
  for (const name of ["write_note", "browse", "open_page", "send_email", "google_chat", "start_background_job", "say_nothing", "tapback", "ask_advisor"]) {
    assert.equal(roundIsParallel(["search_notes", name]), false, name);
  }
});

test("two slow reads finish in about the time of the slower one", async () => {
  const SLOW = 160;
  const FAST = 70;
  let active = 0;
  let maxActive = 0;
  const ai = scripted([
    completion("", [
      { name: "search", args: { query: "invoice", args: { email: true, account: "one@example.com" } } },
      { name: "search", args: { query: "invoice", args: { email: true, account: "two@example.com" } } },
    ]),
    completion("Both mailboxes are in."),
  ]);
  const result = await turn(ai, {
    callTool: async (name, args) => {
      assert.equal(name, "search_email");
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(args.account === "one@example.com" ? SLOW : FAST);
      active -= 1;
      return { content: [{ type: "text", text: args.account }] };
    },
  });
  assert.equal(maxActive, 2);
  const traced = result.timing.trace.filter((entry) => entry.kind === "tool");
  const sum = traced.reduce((total, entry) => total + entry.ms, 0);
  const slowest = Math.max(...traced.map((entry) => entry.ms));
  assert.ok(result.timing.toolMs + 30 >= slowest, `toolMs ${result.timing.toolMs} fell under the slowest call ${slowest}`);
  assert.ok(result.timing.toolMs < sum - 40, `toolMs ${result.timing.toolMs} summed the calls (${sum})`);
  assert.deepEqual(toolTexts(ai), ["one@example.com", "two@example.com"]);
  assert.equal(result.answer, "Both mailboxes are in.");
});

test("vault_list with fetch is not a parallel read, and a plain listing is", () => {
  assert.equal(isParallelRead("vault_list"), true);
  assert.equal(isParallelRead("vault_list", {}), true);
  assert.equal(isParallelRead("vault_list", { fetch: null }), true);
  assert.equal(isParallelRead("vault_list", { fetch: VAULT_FETCH }), false);
  assert.equal(isParallelRead("search_notes", { query: "dentist" }), true);
  assert.equal(isParallelRead("write_note"), false);

  const six = sixToolsOver([SEARCH_NOTES, VAULT_LIST]);
  const api = six.resolve("send", { action: "api", args: VAULT_FETCH });
  assert.equal(api.error, undefined, api.error);
  assert.equal(api.name, "vault_list");
  assert.deepEqual(api.args.fetch, VAULT_FETCH);
  assert.equal(isParallelRead(api.name, api.args), false, "send api");
  const listing = six.resolve("fetch", { id: "vault:" });
  assert.equal(listing.error, undefined, listing.error);
  assert.equal(listing.name, "vault_list");
  assert.equal(listing.args.fetch, undefined);
  assert.equal(isParallelRead(listing.name, listing.args), true, "fetch vault:");

  assert.equal(
    roundIsParallel([
      { name: "search_notes", args: { query: "dentist" } },
      { name: "vault_list", args: {} },
    ]),
    true,
  );
  assert.equal(
    roundIsParallel([
      { name: "search_notes", args: { query: "dentist" } },
      { name: "vault_list", args: { fetch: VAULT_FETCH } },
    ]),
    false,
  );
  assert.equal(
    roundIsParallel([
      { name: "vault_list", args: { fetch: VAULT_FETCH } },
      { name: "vault_list", args: { fetch: { ...VAULT_FETCH, method: "PATCH", url: "https://api.example.com/v1/items/1" } } },
    ]),
    false,
  );
});

test("a vault fetch mixed into the round keeps it serial", async () => {
  let active = 0;
  let maxActive = 0;
  const spans = [];
  const ai = scripted([
    completion("", [
      { name: "search_notes", args: { query: "dentist" } },
      { name: "vault_list", args: { fetch: VAULT_FETCH } },
    ]),
    completion("Called it."),
  ]);
  const result = await turn(ai, {
    tools: [SEARCH_NOTES, VAULT_LIST],
    callTool: async (name) => {
      const start = Date.now();
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(80);
      active -= 1;
      spans.push({ name, start, end: Date.now() });
      return { content: [{ type: "text", text: name }] };
    },
  });
  assert.equal(maxActive, 1);
  assert.ok(spans[1].start >= spans[0].end, "the vault fetch started before the search finished");
  assert.deepEqual(
    result.steps.map((step) => step.tool),
    ["search_notes", "vault_list"],
  );
});

test("send api beside a search keeps the round serial", async () => {
  let active = 0;
  let maxActive = 0;
  const ai = scripted([
    completion("", [
      { name: "search", args: { query: "dentist" } },
      { name: "send", args: { action: "api", args: VAULT_FETCH } },
    ]),
    completion("Called it."),
  ]);
  const result = await turn(ai, {
    tools: [SEARCH_NOTES, VAULT_LIST],
    callTool: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(80);
      active -= 1;
      return { content: [{ type: "text", text: "ok" }] };
    },
  });
  assert.equal(maxActive, 1);
  assert.deepEqual(
    result.steps.map((step) => step.tool),
    ["search_notes", "vault_list"],
  );
});

test("two vault fetches in one round stay serial", async () => {
  let active = 0;
  let maxActive = 0;
  const spans = [];
  const ai = scripted([
    completion("", [
      { name: "vault_list", args: { fetch: VAULT_FETCH } },
      { name: "vault_list", args: { fetch: { ...VAULT_FETCH, method: "PATCH", url: "https://api.example.com/v1/items/1" } } },
    ]),
    completion("Both calls landed."),
  ]);
  await turn(ai, {
    tools: [VAULT_LIST],
    callTool: async (name) => {
      const start = Date.now();
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(80);
      active -= 1;
      spans.push({ name, start, end: Date.now() });
      return { content: [{ type: "text", text: name }] };
    },
  });
  assert.equal(maxActive, 1);
  assert.ok(spans[1].start >= spans[0].end, "the second vault fetch started before the first finished");
});

test("a write mixed into the round keeps it serial", async () => {
  let active = 0;
  let maxActive = 0;
  const spans = [];
  const ai = scripted([
    completion("", [
      { name: "search_notes", args: { query: "dentist" } },
      { name: "write_note", args: { path: "1-projects/dentist.md", content: "Tuesday at 3." } },
    ]),
    completion("Saved it."),
  ]);
  const result = await turn(ai, {
    callTool: async (name) => {
      const start = Date.now();
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(80);
      active -= 1;
      spans.push({ name, start, end: Date.now() });
      return { content: [{ type: "text", text: name }] };
    },
  });
  assert.equal(maxActive, 1);
  assert.ok(spans[1].start >= spans[0].end, "the write started before the search finished");
  const sum = spans.reduce((total, span) => total + (span.end - span.start), 0);
  assert.ok(result.timing.toolMs + 20 >= sum, `toolMs ${result.timing.toolMs} dropped a serial call (${sum})`);
  assert.deepEqual(
    result.steps.map((step) => step.tool),
    ["search_notes", "write_note"],
  );
});

test("results stay in call order when the later read finishes first", async () => {
  const ai = scripted([
    completion("", [
      { name: "search_notes", args: { query: "slow" } },
      { name: "search_web", args: { query: "fast" } },
    ]),
    completion("In order."),
  ]);
  const result = await turn(ai, {
    web: {
      tools: [SEARCH_WEB],
      call: async (_name, args) => {
        await delay(args.query === "fast" ? 20 : 120);
        return { content: [{ type: "text", text: args.query }] };
      },
    },
    callTool: async (_name, args) => {
      await delay(120);
      return { content: [{ type: "text", text: args.query }] };
    },
  });
  assert.deepEqual(toolTexts(ai), ["slow", "fast"]);
  assert.deepEqual(
    result.timing.trace.filter((entry) => entry.kind === "tool").map((entry) => entry.tool),
    ["search_notes", "search_web"],
  );
});

test("a read that throws stays in its slot and does not drop the other result", async () => {
  let active = 0;
  let maxActive = 0;
  const ai = scripted([
    completion("", [
      { name: "search", args: { query: "invoice", args: { email: true, account: "one@example.com" } } },
      { name: "search", args: { query: "invoice", args: { email: true, account: "two@example.com" } } },
    ]),
    completion("One mailbox answered."),
  ]);
  const result = await turn(ai, {
    callTool: async (_name, args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(60);
      active -= 1;
      if (args.account === "one@example.com") throw new Error("gmail down");
      return { content: [{ type: "text", text: "two@example.com" }] };
    },
  });
  assert.equal(maxActive, 2);
  const texts = toolTexts(ai);
  assert.match(texts[0], /Don't guess/);
  assert.doesNotMatch(texts[0], /gmail down/);
  assert.equal(texts[1], "two@example.com");
  assert.deepEqual(
    result.steps.map((step) => step.ok),
    [false, true],
  );
});
