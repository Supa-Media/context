import worker from "../src/index.js";
import { R2Store } from "../src/store/r2.js";
import { SUPPORTED_SCOPES, visibilityTierForGrant } from "../src/session.js";
import { runStoreChecks } from "./store.test.mjs";
import { runOrientationChecks } from "./orientation.test.mjs";
import { runSearchFilterChecks } from "./searchFilter.test.mjs";
import { runSearchIndexerChecks } from "./searchIndexer.test.mjs";
import { runSearchIntegrationChecks } from "./searchIntegration.test.mjs";
import { runSearchQueryChecks } from "./searchQuery.test.mjs";
import { runSearchShardQueryChecks } from "./searchShardQuery.test.mjs";
import { runSearchShardsChecks } from "./searchShards.test.mjs";
import { runSearchPacingChecks } from "./searchPacing.test.mjs";
import { runSearchV2IntegrationChecks } from "./searchV2Integration.test.mjs";
import { runStoreFactoryChecks } from "./storeFactory.test.mjs";
import { runTenancyChecks } from "./tenancy.test.mjs";
import { runPluginChecks } from "./plugins.test.mjs";
import { runCrossContextChecks } from "./crossContext.test.mjs";
import { runLinkChecks } from "./links.test.mjs";
import { runUsageReportingChecks } from "./usageReporting.test.mjs";
import { runMeetingChecks } from "./meetings.test.mjs";
import { runSearchD1Checks } from "./searchD1.test.mjs";
import { runSearchProjectionChecks } from "./searchProjection.test.mjs";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
} from "./controlPlaneStub.mjs";

// --- in-memory R2 stub, wrapped in the same adapter the worker builds ---
//
// Objects are held as bytes, not as strings. This stub used to decode every
// non-string `put` with a `TextDecoder` and re-encode it on the way out, which
// is lossless only for text: any byte sequence that is not valid UTF-8 came
// back as U+FFFD. That made it impossible to test a stored image at all, and
// worse, it would have made a broken binary write *pass*. Bytes in, bytes out;
// `text()` decodes on demand, exactly as R2 does.
const objects = new Map();
let etagCounter = 0;
const encoder = new TextEncoder();
const bucket = {
  async get(key) {
    if (!objects.has(key)) return null;
    const { bytes, etag } = objects.get(key);
    return {
      etag,
      text: async () => new TextDecoder().decode(bytes),
      // A fresh copy per call: a caller that mutates what it reads must not be
      // able to rewrite the stored object through the back door.
      arrayBuffer: async () => bytes.slice().buffer,
    };
  },
  async put(key, value, options = {}) {
    const expected = options?.onlyIf?.etagMatches;
    if (expected && objects.get(key)?.etag !== expected) return null;
    const bytes =
      typeof value === "string"
        ? encoder.encode(value)
        : value instanceof Uint8Array
          ? new Uint8Array(value)
          : new Uint8Array(value);
    const etag = `e${++etagCounter}`;
    objects.set(key, { bytes, etag });
    return { etag };
  },
  async delete(key) {
    objects.delete(key);
  },
  async list({ prefix, cursor, limit } = {}) {
    const listed = [...objects.keys()]
      .filter((k) => !prefix || k.startsWith(prefix))
      .sort()
      // `etag` per listed object mirrors what R2 and S3 both report, and the
      // search index's staleness diff is built on it. Without it every note
      // compares unequal on every sync and the backfill never converges.
      .map((key) => ({
        key,
        size: objects.get(key).bytes.length,
        uploaded: new Date(),
        etag: objects.get(key).etag,
      }));
    return { objects: listed, truncated: false };
  },
};

/**
 * Decode a stored object for an assertion. The stub holds bytes, so the checks
 * that used to reach in for `.body` decode here instead of each doing it.
 * Returns undefined for a key that was never written, so `?.includes(...)` at a
 * call site still short-circuits rather than throwing.
 */
function storedText(key) {
  const entry = objects.get(key);
  return entry ? new TextDecoder().decode(entry.bytes) : undefined;
}

// Seeds and assertions go through the ContextStore, so the suite exercises the
// same adapter the worker uses rather than the raw binding.
const contextStore = new R2Store(bucket);

/**
 * This suite used to hand the worker three static env tokens. There are no
 * static tokens any more: every request resolves through OAuth and the control
 * plane, so the harness stands up a control plane that speaks the real HTTP
 * contract and binds one workspace to the in-memory bucket above.
 *
 * The short names below (`priv-token`, `team-token`, …) survive as *labels*
 * only, mapped to real OAuth-shaped access tokens by `accessTokenFor`. Keeping
 * them means the ~200 behavioural checks in this file stayed exactly as they
 * were while the access model underneath them changed completely — which is the
 * point: privacy semantics are supposed to be unaffected by how a caller
 * authenticated.
 */
const controlPlane = createControlPlaneStub();
controlPlane.install();

const WORKSPACE_ID = "ws_primary";
controlPlane.addWorkspace(WORKSPACE_ID, "primary", {
  provider: "r2-binding",
  bindingName: "CONTEXT_BUCKET",
  capabilities: { conditionalWrite: true },
  status: "active",
});

/**
 * Real tokens are long and opaque; the labels are not. Anything short would be
 * rejected before it reached the control plane, which is itself correct.
 */
const ACCESS_TOKENS = {
  "priv-token": "cat_test_owner_full_0000000000000000",
  "team-token": "cat_test_member_read_000000000000000",
  "pub-token": "cat_test_member_alias_00000000000000",
  "inbox-token": "cat_test_capture_only_00000000000000",
  "readonly-token": "cat_test_owner_readonly_000000000000",
  // The tier is a property of the grant now, so "an owner" is no longer one
  // fixture. These two differ in exactly one scope and in nothing else.
  "owner-team-token": "cat_test_owner_team_tier_00000000000",
  "member-asked-private-token": "cat_test_member_asked_private_000000",
};
function accessTokenFor(label) {
  return ACCESS_TOKENS[label] || label;
}

// An owner who granted private-tier: sees every note, including their own
// private ones. Note that this now takes THREE scopes. The tier is something
// the person chose on the consent screen and the grant records — being the
// owner is necessary and no longer sufficient, which is the entire point of
// this change and the reason ~200 privacy checks below still read the same.
await controlPlane.addGrant({
  accessToken: ACCESS_TOKENS["priv-token"],
  workspaceId: WORKSPACE_ID,
  role: "owner",
  scopes: ["context:read", "context:write", "context:private"],
  clientId: "mcp_client_owner",
  userId: "user_owner",
});
// The same owner, connecting a different client at team level — the thing that
// was impossible before and the thing they asked for. Identical in every
// respect except the missing `context:private`.
//
// It is also what every grant issued before the tier existed looks like, so the
// checks against this token are simultaneously the migration test: an unmarked
// legacy grant reads as `team`, not as the owner's ceiling.
await controlPlane.addGrant({
  accessToken: ACCESS_TOKENS["owner-team-token"],
  workspaceId: WORKSPACE_ID,
  role: "owner",
  scopes: ["context:read", "context:write"],
  clientId: "mcp_client_owner_team",
  userId: "user_owner",
});
// A member whose grant somehow carries the tier scope anyway — the control
// plane refuses to write this, twice, so reaching it takes a compromised
// control plane. The gateway must still refuse to honour it.
await controlPlane.addGrant({
  accessToken: ACCESS_TOKENS["member-asked-private-token"],
  workspaceId: WORKSPACE_ID,
  role: "member",
  scopes: ["context:read", "context:write", "context:private"],
  clientId: "mcp_client_member_private",
  userId: "user_member",
});
// Editors: privacy tier `team`, may write team content. Two of them, because
// `pub-token` used to be a second static credential and the checks that used it
// are really checks about the team tier.
for (const label of ["team-token", "pub-token"]) {
  await controlPlane.addGrant({
    accessToken: ACCESS_TOKENS[label],
    workspaceId: WORKSPACE_ID,
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: `mcp_client_${label}`,
    userId: "user_colleague",
  });
}
// Capture-only: may POST to /inbox and may not read a single note.
await controlPlane.addGrant({
  accessToken: ACCESS_TOKENS["inbox-token"],
  workspaceId: WORKSPACE_ID,
  role: "editor",
  scopes: ["context:capture"],
  clientId: "mcp_client_capture",
  userId: "user_automation",
});
// An owner whose client was connected read-only.
await controlPlane.addGrant({
  accessToken: ACCESS_TOKENS["readonly-token"],
  workspaceId: WORKSPACE_ID,
  role: "owner",
  scopes: ["context:read"],
  clientId: "mcp_client_readonly",
  userId: "user_owner",
});

const env = {
  CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  // The one binding name this deployment will honour from a control-plane
  // answer. Anything else is refused even if it exists on `env`.
  NATIVE_BINDINGS: "CONTEXT_BUCKET",
  CONTEXT_BUCKET: bucket,
  // Cron and webhook ingestion only; no caller can reach this.
  LOCAL_CONTEXT_BUCKET: bucket,
  GRANOLA_WEBHOOK_SECRET: `whsec_${btoa("granola-webhook-secret")}`,
  GRANOLA_API_KEY: "granola-api-key",
};

// seed
await contextStore.put(
  "privacy.md",
  `---\nrole: privacy-manifest\nversion: 1\n---\n\n# Brain Privacy Map\n\n<!-- BEGIN BRAIN PRIVACY RULES -->\n\n\`\`\`yaml\ndefault_visibility: private\n\nfolder_defaults:\n  index.md: team\n  team-native: team\n  1-projects: team\n  1-projects/private: private\n  1-projects/secret-thing: private\n  1-projects/private-folder: private\n  1-projects/mixed/private: private\n  2-areas: team\n  2-areas/private: private\n  2-areas/calendar: private\n  2-areas/health: private\n  2-areas/engineering/one-on-ones: private\n  3-resources: team\n  3-resources/private: private\n  4-archive: team\n  4-archive/private: private\n\nnote_overrides:\n  # none\n\`\`\`\n\n<!-- END BRAIN PRIVACY RULES -->\n`
);
await contextStore.put("index.md", "# public manifest");
await contextStore.put("index-private.md", "# PRIVATE manifest");
await contextStore.put("team-native/info.md", "native team scope marker");
await contextStore.put("1-projects/togather/status.md", "togather status SECRETWORD-no wait, public");
await contextStore.put("1-projects/secret-thing/status.md", "hidden project PRIVATEWORD");
await contextStore.put("2-areas/engineering/practices.md", "eng practices");
await contextStore.put("2-areas/engineering/one-on-ones/alex.md", "sensitive 1:1");
await contextStore.put("1-projects/portable/a.md", "portable a");
await contextStore.put("1-projects/portable/existing.md", "portable existing");
await contextStore.put("1-projects/mixed/public.md", "public half");
await contextStore.put("1-projects/mixed/private/secret.md", "private half");
await contextStore.put("1-projects/private-folder/a.md", "private folder a");
await contextStore.put(".obsidian/app.json", "{}");

let rpcId = 0;
async function rpc(token, method, params) {
  const req = new Request("https://x/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessTokenFor(token)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const res = await worker.fetch(req, env, { waitUntil() {} });
  return res.status === 202 ? null : await res.json();
}
async function call(token, name, args = {}) {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  return r.result;
}

/**
 * TEXT came back, and it does not contain NEEDLE.
 *
 * The symmetric counterpart to `succeeded()`, and needed for the same reason.
 * `!text.includes(x)` is the natural way to assert something is hidden, and
 * once `text` is optional-chained — which the crash convention requires — an
 * absent result reads `!undefined`, which is `true`. So every "a team
 * connection cannot see this" check would pass on a call that returned
 * nothing, which is the failure those checks exist to catch. Six of them have
 * no positive companion on the same variable, so nothing else would go red.
 *
 * `typeof text === "string"` is the half that rejects the absent result;
 * `!text.includes` is the half that does the actual hiding assertion.
 */
function lacks(text, needle) {
  return typeof text === "string" && !text.includes(needle);
}

/**
 * A tool call SUCCEEDED: a result came back, and it is not an error.
 *
 * `!(await call(...)).isError` is the natural way to write this and it is not
 * the same claim. `isError` is absent on success, so optional-chaining it —
 * which the crash convention above otherwise requires — makes the expression
 * read true when there is no result AT ALL: a JSON-RPC error, or a handler
 * that threw. That is precisely the failure such a check exists to catch, so
 * the guard against a crash would have bought a silent pass instead.
 *
 * Both halves are load-bearing. `Boolean(result)` rejects the absent result;
 * `!result.isError` rejects the tool-level refusal.
 */
function succeeded(result) {
  return Boolean(result) && !result.isError;
}

let failures = 0;
function check(label, cond) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
}

// -- protocol basics
//
// Every `.result` access below is optional-chained on purpose.
//
// A break that makes an early call return an error instead of a result used to
// throw a TypeError here and kill the process before a single check ran —
// exit 1, zero PASS, zero FAIL. That looks like detection if you measure by
// counting FAIL lines, and it is the opposite: the named checks that should
// own the failure never execute, so they cannot report, and every later check
// silently becomes dead weight. A crash is a worse signal than a failure
// because it takes the rest of the suite with it.
const init = await rpc("priv-token", "initialize", { protocolVersion: "2025-06-18" });
check("initialize echoes protocol", init.result?.protocolVersion === "2025-06-18");
check("initialize has instructions", typeof init.result?.instructions === "string" && init.result.instructions.length > 500);
// PARA is the default scaffold, not the format. The instructions used to state
// that the context "is organized by the PARA method" and then tell agents to
// file under `1-projects/` — which is wrong for every customer who chose a
// custom layout or connected a bucket they had organized years earlier, and
// those are the people this product exists for. It may be mentioned; it may not
// be asserted, and it must be paired with the instruction not to assume it.
check(
  "the instructions do not assert a folder layout",
  !/is organized by the PARA/i.test(init.result.instructions.replace(/\s+/g, " ")) &&
    /Do not assume a layout/i.test(init.result.instructions.replace(/\s+/g, " "))
);
// A client asking for a revision from the future must get a counter-offer in a
// normal result — never a JSON-RPC error, which is how servers actually fail to
// connect — and the counter-offer must be the newest thing we speak, not an
// arbitrarily older one.
const futureInit = await rpc("priv-token", "initialize", { protocolVersion: "2999-01-01" });
check("an unknown protocol revision is answered, not errored", !futureInit.error);
check(
  "an unknown protocol revision is counter-offered the newest we support",
  futureInit.result?.protocolVersion === "2025-11-25"
);
// `2026-07-28` deleted `initialize`. Counter-offering it to a client that just
// sent one would name a revision that client cannot possibly speak.
check(
  "the initialize counter-offer never names a revision that has no initialize",
  futureInit.result?.protocolVersion !== "2026-07-28"
);
const olderInit = await rpc("priv-token", "initialize", { protocolVersion: "2024-11-05" });
check(
  "a revision we still support is echoed rather than upgraded",
  olderInit.result?.protocolVersion === "2024-11-05"
);
const versionlessInit = await rpc("priv-token", "initialize", {});
check(
  "an initialize with no protocolVersion is answered with the newest we support",
  versionlessInit.result?.protocolVersion === "2025-11-25"
);
const newestInit = await rpc("priv-token", "initialize", { protocolVersion: "2025-11-25" });
check(
  "the newest legacy revision is echoed and carries a server description",
  newestInit.result?.protocolVersion === "2025-11-25" &&
    typeof newestInit.result?.serverInfo.description === "string"
);
check("initialize prompts proactive durable memory", init.result?.instructions.includes("rediscover"));
// Compared on whitespace-normalized text: these are wrapped prose, so a phrase
// that reads as one sentence is two lines in the string, and an `includes` on
// the sentence fails for a reason that has nothing to do with the meaning.
const instructionsFlat = init.result.instructions.replace(/\s+/g, " ");
check(
  "initialize prompts scoped session saving",
  instructionsFlat.includes("save_context") &&
    instructionsFlat.includes("Default privacy follows this connection")
);
// The argument for using this at all, which is the only reason the rest gets
// read. Asserted because it is the part a tidy-up would cut as "not a rule",
// and because the whole payload is worthless if it opens with housekeeping.
check(
  "initialize leads with the instruction to orient, in the clear",
  /READ THIS BEFORE YOU ANSWER ANYTHING ELSE/.test(instructionsFlat) &&
    /CALL `orient` FIRST\. EVERY SESSION\./.test(instructionsFlat)
);
check(
  "initialize makes the case rather than only stating rules",
  /Skipping it is not a neutral choice/i.test(instructionsFlat) &&
    /richest source of information about this person/i.test(instructionsFlat)
);
// It has to reach the model before any housekeeping does. Measured rather than
// asserted in a comment: a later edit that reinstates a preamble above the
// instruction is the exact regression this payload was rewritten to undo.
check(
  "the call to action comes before any of the rules",
  instructionsFlat.indexOf("CALL `orient` FIRST") <
    instructionsFlat.indexOf("FOUR RULES") &&
    instructionsFlat.indexOf("CALL `orient` FIRST") < 500
);
const noteRes = await worker.fetch(
  new Request("https://x/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessTokenFor("priv-token")}` },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }),
  env,
  { waitUntil() {} }
);
check("notification → 202", noteRes.status === 202);
const tools = await rpc("priv-token", "tools/list");
// 18 became 20 when `search` and `fetch` landed — ChatGPT's ordinary chats can
// invoke only those two names on a custom connector, so they are the same
// read capabilities wearing OpenAI's deep-research contract. 21 with
// `read_image`, which is a read capability over the same access map. 24 with
// `list_meetings` and `read_meeting`: a meeting is an ordinary note, and these
// are the two reads that know a transcript is appended to one and that a model
// has to ask for it.
check("24 tools listed", tools.result?.tools.length === 24);

// -- list_plugins through the worker
//
// The unit checks in `plugins.test.mjs` cover the scan, the inventory and the
// wording. These three cover the wiring, which nothing else would: the tool is
// reachable, it is classified read-only so a read-only grant is offered it, and
// a capture-only grant — which may POST to /inbox and read nothing — cannot use
// it to read `.obsidian/`, a prefix the privacy manifest has no say over.
await contextStore.put(
  ".obsidian/plugins/obsidian-git/manifest.json",
  JSON.stringify({ id: "obsidian-git", name: "Obsidian Git", version: "2.33.0" })
);
await contextStore.put(
  ".obsidian/plugins/obsidian-git/main.js",
  'const cp = require("child_process");'
);
const pluginReport = await call("priv-token", "list_plugins");
check(
  "list_plugins reads .obsidian/plugins and names the call that refuses one",
  pluginReport?.content?.[0]?.text?.includes("Obsidian Git") &&
    pluginReport.content[0].text.includes("child_process")
);
/*
  THIS ASSERTED THE OPPOSITE, AND ITS REASON IS WHAT WAS WRONG.

  It read: "and it is offered to a read-only grant, because it writes nothing."
  Writing nothing is true and is not the question. `.obsidian/` sits outside the
  privacy manifest entirely — `isPlumbing` hides every dot-segment from
  `read_note`, `list_notes` and search, for every role — so `list_plugins` is
  the only read path into that prefix, and the tier that governs it had never
  been decided.

  `readonly-token` owns this context and holds `context:read` alone, so it reads
  at `team`: an owner who deliberately did not hand this client private reach.
  It was being handed every plugin's id, name, version and author, the blocked
  internals each bundle names, and up to twelve hostnames pulled out of bundle
  text. A count over what the grant cannot see, and then the list — which is the
  reasoning that already makes the note census owner-only.

  Corrected rather than deleted, so the next reader sees which of the two
  questions this check used to answer.
*/
check(
  "and it is NOT offered to a grant that reads at team tier, whatever it writes",
  !(await rpc("readonly-token", "tools/list"))?.result?.tools.some(
    (t) => t.name === "list_plugins"
  )
);
check(
  "while a grant that reads private somewhere is offered it",
  (await rpc("priv-token", "tools/list"))?.result?.tools.some((t) => t.name === "list_plugins")
);
check(
  "and a team-tier grant that calls it anyway is refused",
  (await call("readonly-token", "list_plugins"))?.isError === true
);
check(
  "a capture-only grant cannot read the vault's plugins",
  (await call("inbox-token", "list_plugins")) === undefined ||
    (await call("inbox-token", "list_plugins")).isError === true
);
check(
  "a plugin bundle is never reachable as a note",
  (await call("priv-token", "read_note", { path: ".obsidian/plugins/obsidian-git/main.js" }))
    .isError === true
);
check("set_visibility tool is discoverable", tools.result?.tools.some((tool) => tool.name === "set_visibility"));
check(
  "set_folder_visibility tool is discoverable",
  tools.result?.tools.some((tool) => tool.name === "set_folder_visibility")
);
const writeNoteTool = tools.result?.tools.find((tool) => tool.name === "write_note");
const setVisibilityTool = tools.result?.tools.find((tool) => tool.name === "set_visibility");
const setFolderVisibilityTool = tools.result?.tools.find(
  (tool) => tool.name === "set_folder_visibility"
);
const scopeInfoTool = tools.result?.tools.find((tool) => tool.name === "scope_info");
const searchNotesTool = tools.result?.tools.find((tool) => tool.name === "search_notes");
const saveContextTool = tools.result?.tools.find((tool) => tool.name === "save_context");
check(
  "write_note advertises only private and team visibility",
  JSON.stringify(writeNoteTool.inputSchema.properties.visibility?.enum) === JSON.stringify(["private", "team"])
);
check(
  "set_visibility advertises explicit team-publication confirmation",
  setVisibilityTool?.inputSchema?.properties?.confirm_team_publish?.type === "boolean"
);
check(
  "set_folder_visibility supports dry-run, inheritance, and privacy etag protection",
  setFolderVisibilityTool?.inputSchema?.properties?.dry_run?.type === "boolean" &&
    setFolderVisibilityTool?.inputSchema?.properties?.expected_privacy_etag?.type === "string" &&
    setFolderVisibilityTool?.inputSchema?.properties?.visibility?.enum?.includes("inherit")
);
check("scope_info advertises an optional path", scopeInfoTool?.inputSchema?.properties?.path?.type === "string");
check(
  "search_notes advertises an optional performance prefix",
  searchNotesTool?.inputSchema?.properties?.prefix?.type === "string"
);
check(
  "save_context exposes no internet-public visibility option",
  JSON.stringify(saveContextTool.inputSchema.properties.visibility?.enum) === JSON.stringify(["private", "team"])
);
// The tool shipped as `archive_chat`, and a client that cached the old list is
// still calling that name. It is deliberately no longer advertised — but a
// rename that drops somebody's session on the floor is not a rename, it is data
// loss on the one call whose whole job is not losing anything.
check(
  "archive_chat is no longer advertised",
  !tools.result?.tools.some((tool) => tool.name === "archive_chat")
);
check(
  "tool surface uses team terminology instead of the old public-access wording",
  !/(?:public connections?|writable public|public archive)/i.test(JSON.stringify(tools.result?.tools))
);
check(
  "read tools have read-only annotations",
  tools.result?.tools.find((tool) => tool.name === "read_note").annotations.readOnlyHint === true
);

// -- auth
const bad = await worker.fetch(
  new Request("https://x/mcp", { method: "POST", body: "{}" }),
  env,
  { waitUntil() {} }
);
check("no token → 401", bad.status === 401);
const teamAliasPing = await rpc("team-token", "ping", {});
check("an editor grant authenticates as a team connection", !!teamAliasPing?.result);
check(
  "a second editor grant is an independent connection at the same tier",
  !!(await rpc("pub-token", "ping", {}))?.result
);
check(
  "native team scope rules and legacy public scope rules both resolve as team-visible",
  succeeded(await call("team-token", "read_note", { path: "team-native/info.md" })) &&
    succeeded(await call("team-token", "read_note", { path: "1-projects/togather/status.md" }))
);
// This asserted the instructions said there was "no anonymous or
// internet-public tier". That sentence is no longer true of the *product* — an
// owner can hand out an unlisted link to one note from their console — and a
// server contract that says something false is worse than one that says less.
//
// What is still true, and is the thing a connected client actually has to know,
// is narrower and stronger: visibility here is private or team, and nothing on
// this connection can publish past the people the owner named. The check is
// pinned to that rather than to a phrase, so the day somebody gives an AI
// client a way to publish, this fails instead of reassuring a model that it
// cannot do what it just did.
check(
  "server contract says visibility here is private or team",
  /team/i.test(init.result?.instructions) &&
    /private or team/i.test(init.result?.instructions)
);

/**
 * ...AND IT DOES NOT CLAIM THIS CONNECTION CANNOT PUBLISH, BECAUSE IT CAN.
 *
 * The check above used to also require the instructions to say no tool here can
 * publish past the people the owner named, and its own comment said it existed
 * so that "the day somebody gives an AI client a way to publish, this fails
 * instead of reassuring a model that it cannot do what it just did".
 *
 * That day was the same commit. An unlisted share serves the entry note **and
 * the notes the entry note links to**, resolved from its live body on every
 * read (`functions/lib/noteLinks.ts`, an authorization input by its own
 * header), with `/x.md` resolving from the bucket root. Nothing in the write
 * path or in this gateway knows a share exists. So `write_note` adding one
 * markdown link to a note somebody already handed an unlisted link to publishes
 * any team-visible note in that bucket to anyone holding the link -- which is
 * the ordinary shape of "add a reference to the salaries note in the plan".
 *
 * The reasoning that missed it stopped at "no tool here is named publish".
 * Publishing is not a tool, it is a consequence of an edit.
 *
 * So the instructions state what is true and say what an agent can actually act
 * on, and this pins BOTH halves: the absolute must not come back, and the
 * warning that replaces it must not quietly go away.
 */
check(
  "and does not claim this connection cannot publish, because an edit can",
  // Word-anchored. Unanchored, `not` matches inside "note", and the warning
  // this check exists to protect trips its own assertion.
  !/\b(?:no|not|never|cannot|can't)\b[^\n.]{0,60}publish/i.test(init.result?.instructions)
);
check(
  "instead it warns that a link added to a note can widen a link already sent",
  /widen/i.test(init.result?.instructions) &&
    /\blinks?\b[^\n]{0,80}\bwiden|\bwiden[^\n]{0,80}\blinks?\b/i.test(
      init.result?.instructions
    )
);

// -- Origin validation on the Streamable HTTP transport (DNS rebinding)
//
// The whole point of this control is that a browser sets `Origin` and page
// script cannot override it. So these checks are written the way a browser
// would send them: a header that is either absent (every non-browser client) or
// a serialized origin — never a plausible-looking string a server invented.
//
// ## Sabotage record
//
// A guard nobody has checked is not a guard, so `src/origin.js` was broken
// thirteen ways as temporary local edits and each break was confirmed to fail a
// named check below. Nothing ships to reproduce them — a switch that disables
// origin validation is not something that belongs in a deployable artifact:
//
//   `null` folded in with an absent header ......... 1 check
//   exact match weakened to endsWith ............... 2 checks
//   exact match weakened to startsWith ............. 3 checks
//   absent Origin treated as an attack ............. suite dies at the first RPC
//   raw header compared instead of the normalized .. 2 checks
//   opaque origins accepted after parsing .......... 1 check
//   wildcard entries given wildcard meaning ........ 1 check
//   /inbox dropped from the guarded paths .......... 1 check
//   guard moved below the OPTIONS short-circuit .... 1 check
//   refusal varying with the caller's token ........ 1 check
//   guard applied before the token is stripped ..... 1 check
//   unconfigured allowlist failing open ............ 1 check
//   empty Origin header read as absent ............. 1 check
//
// The opaque-origin case is here *because* of that pass: the first version
// refused `null` on the header side only, an allowlist entry of `file://`
// normalized to the string "null" and matched it, and every other check in this
// file stayed green.
const CONSOLE_ORIGIN = "https://console.context.test";
const originEnv = { ...env, ALLOWED_ORIGINS: CONSOLE_ORIGIN };
const noAllowlistEnv = { ...env, ALLOWED_ORIGINS: undefined };

async function transportRequest(
  originHeader,
  { token = "priv-token", useEnv = originEnv, path = "/mcp", method = "POST" } = {}
) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${accessTokenFor(token)}`;
  if (originHeader !== undefined) headers.Origin = originHeader;
  const init = { method, headers };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify({ jsonrpc: "2.0", id: 90210, method: "ping", params: {} });
  }
  return worker.fetch(new Request(`https://x${path}`, init), useEnv, { waitUntil() {} });
}

/** Everything a caller can observe about a response, as one comparable string. */
async function fingerprint(response) {
  const headers = [...response.headers]
    .map(([name, value]) => `${name}: ${value}`)
    .sort()
    .join("\n");
  return `${response.status}\n${headers}\n${await response.text()}`;
}

const originAllowed = await transportRequest(CONSOLE_ORIGIN);
const originAllowedBody = await originAllowed.json();
check("an allowlisted browser origin reaches the transport", originAllowed.status === 200);
check(
  "an allowlisted origin gets a real MCP answer, not merely a status",
  originAllowedBody.id === 90210 && originAllowedBody.result !== undefined
);
check(
  "a disallowed browser origin is refused",
  (await transportRequest("https://evil.example")).status === 403
);

/*
 * The absent-Origin cases.
 *
 * Every non-browser MCP client — Claude Desktop, Codex CLI, ChatGPT — sends no
 * Origin header at all. Absence is not an attack signal, and refusing it is the
 * one mistake here that breaks every real client at once while looking like a
 * tightening.
 *
 * These exist because the behaviour was correct and *unpinned*: inverting
 * `originIsAllowed` to refuse an absent header failed zero checks. Every other
 * origin rule had a test; this one did not, so the regression that costs the
 * most was the only one CI would have missed.
 */
const originAbsent = await transportRequest(undefined);
check(
  "a request with no Origin header reaches the transport",
  originAbsent.status === 200
);
check(
  "a non-browser client gets a real MCP answer, not merely a status",
  (await originAbsent.json()).id === 90210
);
check(
  "no Origin is still accepted when an allowlist IS configured",
  (await transportRequest(undefined, { useEnv: originEnv })).status === 200
);
check(
  "no Origin is still accepted when no allowlist is configured",
  (await transportRequest(undefined, { useEnv: noAllowlistEnv })).status === 200
);
check(
  "absence and empty-string are treated differently — empty is a browser saying nothing",
  (await transportRequest(undefined)).status === 200 &&
    (await transportRequest("")).status === 403
);
check(
  "the /inbox path also accepts a headerless client",
  (await transportRequest(undefined, { path: "/inbox" })).status !== 403
);
check(
  "a refused origin is told why, without an auth challenge to retry against",
  await (async () => {
    const res = await transportRequest("https://evil.example");
    const body = await res.json();
    return (
      // The spec is specific about this one thing: if a 403 carries a body it
      // must be a JSON-RPC error response with no `id`.
      body.jsonrpc === "2.0" &&
      body.id === null &&
      typeof body.error?.code === "number" &&
      body.result === undefined &&
      !res.headers.has("WWW-Authenticate") &&
      // No CORS header either: the browser should not get to read the refusal.
      !res.headers.has("Access-Control-Allow-Origin")
    );
  })()
);

// Rule 1: absence is not an attack signal. Claude Desktop, Codex CLI and the
// SDKs send no Origin at all; if this check ever fails, every client is down.
check(
  "a request with no Origin still works (non-browser clients send none)",
  (await transportRequest(undefined)).status === 200
);
check(
  "a request with no Origin works even with nothing allowlisted",
  (await transportRequest(undefined, { useEnv: noAllowlistEnv })).status === 200
);
check(
  "an unconfigured allowlist still refuses a browser origin",
  (await transportRequest("https://evil.example", { useEnv: noAllowlistEnv })).status === 403
);

// Rule 2: `null` is present-and-untrusted, not absent. A sandboxed iframe is
// the one-line bypass this exists to close.
check(
  "the null origin is refused, not treated as absent",
  (await transportRequest("null")).status === 403
);
check(
  "an opaque file:// origin is refused",
  (await transportRequest("file://")).status === 403
);
// `new URL("file:///x").origin` is the *string* "null", so an operator who put
// an opaque scheme in the allowlist would otherwise authorize every sandboxed
// iframe and local file on the internet at once. Both sides of the comparison
// have to refuse it. (Found by sabotage: refusing it only on the header side
// left this open and every other check stayed green.)
check(
  "an opaque allowlist entry authorizes nothing",
  (
    await transportRequest("file://", { useEnv: { ...env, ALLOWED_ORIGINS: "file:///" } })
  ).status === 403
);
check(
  "an opaque allowlist entry does not authorize the null origin either",
  (
    await transportRequest("null", { useEnv: { ...env, ALLOWED_ORIGINS: "file:///" } })
  ).status === 403
);
check(
  "an empty Origin header is refused rather than read as absent",
  (await transportRequest("")).status === 403
);
check(
  "an Origin that is not a URL at all is refused",
  (await transportRequest("console.context.test")).status === 403
);

// Rule 3: exact — scheme, host, port. Every one of these is a real attack
// shape against a check written with startsWith/endsWith/includes.
check(
  "a scheme downgrade does not match an https allowlist entry",
  (await transportRequest("http://console.context.test")).status === 403
);
check(
  "a different port is a different origin",
  (await transportRequest("https://console.context.test:8443")).status === 403
);
check(
  "the default port is not a different origin",
  (await transportRequest("https://console.context.test:443")).status === 200
);
check(
  "suffix confusion is refused (https://context.lc.evil.com)",
  (await transportRequest("https://console.context.test.evil.com")).status === 403
);
check(
  "an allowed origin's name buried in a hostile URL's path is refused",
  (await transportRequest("https://evil.example/console.context.test")).status === 403
);
check(
  "a prefix of an allowed origin is refused",
  (await transportRequest("https://console.context.tes")).status === 403
);
check(
  "an unlisted subdomain of an allowed origin is refused",
  (await transportRequest("https://staging.console.context.test")).status === 403
);
check(
  "the parent domain of an allowed origin is refused",
  (await transportRequest("https://context.test")).status === 403
);
check(
  "a trailing-dot host is a different origin and is refused",
  (await transportRequest("https://console.context.test.")).status === 403
);
// Scheme and host are case-insensitive per RFC 6454, so this must be ACCEPTED.
// Getting it backwards would look like hardening and would break a client.
check(
  "case differences in scheme and host still match",
  (await transportRequest("HTTPS://CONSOLE.CONTEXT.TEST")).status === 200
);
check(
  "an allowlist entry written in mixed case matches a lowercase browser origin",
  (
    await transportRequest(CONSOLE_ORIGIN, {
      useEnv: { ...env, ALLOWED_ORIGINS: "HTTPS://Console.Context.TEST" },
    })
  ).status === 200
);

// No wildcards, configured or otherwise. `https://*.console.context.test`
// parses, so it lands in the allowlist as a host literally named `*.…` — which
// no browser can send. Inert, and asserted to stay that way.
check(
  "a wildcard allowlist entry grants no subdomain",
  (
    await transportRequest("https://app.console.context.test", {
      useEnv: { ...env, ALLOWED_ORIGINS: "https://*.console.context.test" },
    })
  ).status === 403
);
check(
  "a bare * in the allowlist grants nothing",
  (
    await transportRequest("https://evil.example", {
      useEnv: { ...env, ALLOWED_ORIGINS: "*" },
    })
  ).status === 403
);
check(
  "a malformed allowlist entry is dropped without taking the good ones with it",
  (
    await transportRequest(CONSOLE_ORIGIN, {
      useEnv: { ...env, ALLOWED_ORIGINS: `not-a-url, ${CONSOLE_ORIGIN} ,,` },
    })
  ).status === 200
);
// The self-origin is whatever the deployment DECLARED, never whatever `Host`
// the caller claimed. With no `PUBLIC_ORIGIN` there is no declared origin, so
// there is no self to allow — which is what "unconfigured means non-browser
// clients only" has always claimed and did not do. Before this, `publicOrigin`
// fell back to the request's own `Host`, so the allowlist became a function of
// attacker input in exactly the rebinding case the file exists to stop: a page
// sending `Host: x` and `Origin: https://x` matched itself.
check(
  "with no PUBLIC_ORIGIN, a browser origin matching the claimed Host is refused",
  (await transportRequest("https://x", { useEnv: noAllowlistEnv })).status === 403
);
check(
  "a declared PUBLIC_ORIGIN is still permitted without being listed",
  (
    await transportRequest("https://x", {
      useEnv: { ...noAllowlistEnv, PUBLIC_ORIGIN: "https://x" },
    })
  ).status === 200
);
// Named for what it actually asserts. It was "a claimed Host cannot smuggle
// itself past a declared PUBLIC_ORIGIN", which passes against the pre-fix code
// too — `publicOrigin()` always preferred `env.PUBLIC_ORIGIN` when one was set,
// so the `Host` fallback this change removes was never reached on this path.
// The check above it is the one that fails on revert; a name promising more
// than the assertion delivers is how a guard comes to look covered.
check(
  "a declared PUBLIC_ORIGIN admits itself and nothing else",
  (
    await transportRequest("https://x", {
      useEnv: { ...noAllowlistEnv, PUBLIC_ORIGIN: "https://mcp.context.test" },
    })
  ).status === 403
);
check(
  "tightening the self-origin leaves non-browser clients alone",
  (await transportRequest(undefined, { useEnv: noAllowlistEnv })).status === 200
);

// -- the top-level catch
//
// The guard `index.js` grew for the two throws that reached the runtime as a
// bodyless 1101. Untested it is an assertion in a comment: deleting the whole
// `try`/`catch` left all 457 checks green, which is precisely the shape this
// repo's "a guard nobody has checked is not a guard" rule names.
//
// `env` is a proxy that throws on first touch, so the throw originates inside
// `route()` rather than being handed to the catch directly.
const throwingEnv = new Proxy(
  {},
  {
    get() {
      throw new TypeError("secret-bucket-key-abc123 not readable");
    },
  }
);
const loggedLines = [];
const realConsoleError = console.error;
console.error = (...parts) => loggedLines.push(parts.join(" "));
// Caught here, not left to propagate. Removing the guard makes `fetch` throw,
// and an uncaught throw at this line kills the process — exit 1, zero FAIL,
// which is the "looks like detection and is the opposite" shape the header of
// this file warns about. A null response turns it into four named failures.
let caughtRes = null;
try {
  caughtRes = await worker.fetch(new Request("https://x/mcp", { method: "POST" }), throwingEnv, {
    waitUntil() {},
  });
} catch {
  caughtRes = null;
} finally {
  console.error = realConsoleError;
}
check("an unhandled throw becomes a 500, not a dead request", caughtRes?.status === 500);
const caughtBody = caughtRes ? await caughtRes.text() : "";
check("the 500 says nothing about what threw", caughtBody === '{"error":"server_error"}');
check(
  "and the thrown message reaches neither body nor headers",
  caughtRes !== null &&
    !caughtBody.includes("secret-bucket-key-abc123") &&
    ![...caughtRes.headers.values()].some((v) => v.includes("secret-bucket-key-abc123"))
);
// Catching removes the throw from Cloudflare's exception stream, and this
// Worker logs nowhere else. A silent catch would trade a dead request for an
// invisible one.
check(
  "the operator gets the error class, and only the class",
  loggedLines.length === 1 &&
    loggedLines[0].includes("TypeError") &&
    !loggedLines[0].includes("secret-bucket-key-abc123")
);

// The log line must not be able to defeat the catch it lives in. Both cases
// need our own code to throw a non-Error, which nothing does today — every
// `throw` in `src/` raises an `Error` subclass. That is a fact about code
// somebody will edit, so it is asserted rather than audited.
async function fetchThrowing(thrown) {
  const lines = [];
  const real = console.error;
  console.error = (...parts) => lines.push(parts.join(" "));
  let res = null;
  try {
    res = await worker.fetch(
      new Request("https://x/mcp", { method: "POST" }),
      new Proxy({}, { get() { throw thrown; } }),
      { waitUntil() {} }
    );
  } catch {
    res = null;
  } finally {
    console.error = real;
  }
  return { status: res?.status ?? null, logged: lines.join(" | ") };
}

// A plain object carrying its own `constructor.name` — read unguarded, that
// name is printed verbatim, and it is whatever the thrower put there.
const forgedClass = await fetchThrowing({
  constructor: { name: "secret-bucket-key-abc123" },
  name: "secret-bucket-key-abc123",
});
check("a thrown non-Error cannot name its own class in the log", forgedClass.status === 500);
check(
  "and nothing it carries is printed",
  !forgedClass.logged.includes("secret-bucket-key-abc123") && forgedClass.logged.includes("object")
);

// Reading a property can throw. Unguarded that throw escapes `fetch` and the
// request dies as a bodyless 1101 — the guard undone by the input it is for.
const hostileGetter = await fetchThrowing(
  new Proxy(new TypeError("boom"), {
    get(target, prop) {
      if (prop === "name" || prop === "constructor") throw new Error("nope");
      return Reflect.get(target, prop);
    },
  })
);
check("a throw while reading the error still answers 500", hostileGetter.status === 500);

// A thrown string, number, null: no class to read at all.
for (const [label, thrown] of [
  ["a string", "secret-bucket-key-abc123"],
  ["null", null],
]) {
  const res = await fetchThrowing(thrown);
  check(
    `a thrown ${label} still answers 500 and logs nothing of it`,
    res.status === 500 && !res.logged.includes("secret-bucket-key-abc123")
  );
}

// The refusal must not become the oracle the rest of the gateway avoids being.
const refusalFingerprints = await Promise.all([
  transportRequest("https://evil.example").then(fingerprint),
  transportRequest("https://evil.example", { token: null }).then(fingerprint),
  transportRequest("https://evil.example", { token: "cat_not_a_real_token_00000000000000" }).then(
    fingerprint
  ),
  transportRequest("https://evil.example", { token: "readonly-token" }).then(fingerprint),
  transportRequest("https://evil.example", { path: "/@primary/mcp" }).then(fingerprint),
  transportRequest("https://evil.example", { path: "/@nobody-has-this-name/mcp" }).then(fingerprint),
]);
check(
  "the origin refusal is byte-identical whatever the token or workspace",
  new Set(refusalFingerprints).size === 1
);
check(
  "a bad origin is refused as a bad origin, never as an auth failure",
  (await transportRequest("https://evil.example", { token: null })).status === 403
);

// Coverage of the transport's other spellings and its neighbour.
check(
  "the token-in-path transport form is guarded too",
  (
    await transportRequest("https://evil.example", {
      token: null,
      path: `/t/${accessTokenFor("priv-token")}/mcp`,
    })
  ).status === 403
);
check(
  "the capture endpoint is guarded too",
  (
    await transportRequest("https://evil.example", { token: "inbox-token", path: "/inbox" })
  ).status === 403
);
check(
  "the capture endpoint still serves a client that sends no Origin",
  (await transportRequest(undefined, { token: "inbox-token", path: "/inbox" })).status !== 403
);

// The preflight is refused on the same terms as the request it precedes —
// otherwise the browser is told the call is permitted and then it isn't.
check(
  "a preflight from a disallowed origin is refused",
  (await transportRequest("https://evil.example", { method: "OPTIONS", token: null })).status === 403
);
check(
  "a preflight from an allowed origin succeeds",
  (await transportRequest(CONSOLE_ORIGIN, { method: "OPTIONS", token: null })).status === 204
);
check(
  "a preflight for a non-transport path is unaffected",
  (
    await transportRequest("https://evil.example", {
      method: "OPTIONS",
      token: null,
      path: "/.well-known/oauth-protected-resource",
    })
  ).status === 204
);
// Discovery is public, unauthenticated, and fetched cross-origin by browser
// clients before they hold any credential. Guarding it would break the flow it
// exists to start, and it exposes nothing.
check(
  "discovery documents stay reachable from any origin",
  (
    await worker.fetch(
      new Request("https://x/.well-known/oauth-protected-resource", {
        headers: { Origin: "https://evil.example" },
      }),
      originEnv,
      { waitUntil() {} }
    )
  ).status === 200
);

// -- protocol revisions: the legacy handshake era and the modern per-request era
//
// `2026-07-28` is not an increment on `2025-11-25`; it deletes `initialize`,
// sessions, the GET stream, resumability and `ping`, and replaces the
// counter-offer with an error. This gateway is dual-era, so the checks below
// come in pairs: the modern shape works, and the legacy shape is untouched by
// it. The second half of each pair is the one that matters — every client in
// the wild today is legacy.
const MODERN = "2026-07-28";

async function modernFetch({
  method,
  params = {},
  id = 4242,
  bodyVersion = MODERN,
  headerVersion = MODERN,
  headerMethod,
  headerName,
  token = "priv-token",
  omitBodyVersion = false,
  omitHeaderVersion = false,
  omitHeaderMethod = false,
  omitHeaderName = false,
  rawBody,
  httpMethod = "POST",
} = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${accessTokenFor(token)}`;
  if (!omitHeaderVersion) headers["MCP-Protocol-Version"] = headerVersion;
  if (!omitHeaderMethod) headers["Mcp-Method"] = headerMethod ?? method;
  const nameSource = method === "tools/call" ? params.name : undefined;
  if (nameSource !== undefined && !omitHeaderName) {
    headers["Mcp-Name"] = headerName ?? nameSource;
  }
  const meta = omitBodyVersion
    ? {}
    : { "io.modelcontextprotocol/protocolVersion": bodyVersion };
  const body =
    rawBody !== undefined
      ? rawBody
      : JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: meta } });
  const res = await worker.fetch(
    new Request("https://x/mcp", {
      method: httpMethod,
      headers,
      body: httpMethod === "POST" ? body : undefined,
    }),
    env,
    { waitUntil() {} }
  );
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 202 and 405 carry no body */
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

// server/discover is the one RPC 2026-07-28 makes unconditionally mandatory.
// Advertising the revision without it is self-detecting: a conformant client
// probes with it and correctly concludes the server is legacy.
const discover = await modernFetch({ method: "server/discover" });
check("server/discover answers on the modern path", discover.status === 200);
check(
  "server/discover reports the modern revisions and the tools capability",
  JSON.stringify(discover.body.result?.supportedVersions) === JSON.stringify([MODERN]) &&
    !!discover.body.result?.capabilities.tools
);
check(
  "server/discover never offers a handshake revision on the modern path",
  !discover.body.result?.supportedVersions.some((v) => v.startsWith("2025-") || v.startsWith("2024-"))
);
check(
  "server/discover carries instructions and the server identity in _meta",
  discover.body.result?.instructions.includes("PARA") &&
    discover.body.result?._meta["io.modelcontextprotocol/serverInfo"].name === "context"
);
check("every modern result is tagged complete", discover.body.result?.resultType === "complete");
// `tools/list` has had this check since the modern path landed; `discover` did
// not, and it is the one that matters more. Its `instructions` carry a sketch
// of THIS caller's context — their front page and their filtered folder map —
// so `public` here would hand one person's notes to whoever a shared
// intermediary served next. (Not recency: the sketch's own header points at
// `orient` for that, and no timestamp enters this payload.) Two comments in
// `index.js` say exactly that and nothing enforced it: marking discover
// `public` passed the whole suite.
check(
  "the per-caller context sketch is never marked publicly cacheable",
  discover.body.result?.cacheScope === "private"
);
check(
  "and it carries the freshness hints the revision requires at all",
  typeof discover.body.result?.ttlMs === "number"
);

const modernList = await modernFetch({ method: "tools/list" });
check("modern tools/list works", modernList.status === 200 && modernList.body.result?.tools.length === 24);
check(
  "modern tools/list carries the required freshness hints",
  typeof modernList.body.result?.ttlMs === "number" &&
    modernList.body.result?.resultType === "complete"
);
// `public` would let a shared proxy serve one grant's tool list to another —
// and this list is filtered by the caller's scopes.
check(
  "a per-grant list is never marked publicly cacheable",
  modernList.body.result?.cacheScope === "private"
);
check(
  "modern tools/list is filtered by grant scope exactly as the legacy path is",
  (await modernFetch({ method: "tools/list", token: "readonly-token" })).body.result?.tools.every(
    (tool) => tool.annotations?.readOnlyHint === true
  )
);

const modernCall = await modernFetch({
  method: "tools/call",
  params: { name: "read_note", arguments: { path: "index.md" } },
});
// `tools/call` returns the note bodies themselves — strictly more sensitive
// than the tool array or the connect sketch, and the one modern result that
// carries no cacheability hints at all. That is the right answer, and it was
// the answer nothing asserted: marking it `public` passed the whole suite.
// Asserting their ABSENCE rather than their value is the point — a hint here
// would be wrong however it was spelled — and it is also what makes the call's
// own success part of the assertion: a call that failed outright satisfies an
// absence for free, `body.result` being undefined and so being both reads. The
// next check would catch that loudly, but a check that can only be trusted by
// reading its neighbour is one somebody will later move.
//
// The guard is `result`, not the status. A 200 is not enough on its own — a
// thrown handler is answered with a JSON-RPC *error* over HTTP 200, as the
// connect helper in `orientation.test.mjs` says in as many words — so a
// status-only conjunct would still leave the absence vacuously true on
// exactly the failure it was added to exclude.
check(
  "tools/call is not cacheable at all, because it carries the notes",
  modernCall.status === 200 &&
    Boolean(modernCall.body.result) &&
    modernCall.body.result?.cacheScope === undefined &&
    modernCall.body.result?.ttlMs === undefined
);
check(
  "modern tools/call reaches the same tool implementation",
  modernCall.status === 200 &&
    modernCall.body.result?.content?.[0]?.text.includes("public manifest") &&
    modernCall.body.result?.resultType === "complete"
);
check(
  "the write-scope gate applies on the modern path too",
  (
    await modernFetch({
      method: "tools/call",
      token: "readonly-token",
      params: { name: "write_note", arguments: { path: "1-projects/x.md", content: "no" } },
    })
  ).body.result?.content?.[0]?.text.includes("permission denied")
);

// The mirrored headers exist so an intermediary can route without parsing the
// body. That is only safe if the server that parses the body proves they agree.
const headerMismatchCases = [
  ["a missing MCP-Protocol-Version header", { method: "tools/list", omitHeaderVersion: true, headerMethod: "tools/list" }],
  ["a body with no declared protocol version", { method: "tools/list", omitBodyVersion: true }],
  ["a header version that disagrees with the body", { method: "tools/list", headerVersion: "2025-11-25" }],
  ["a missing Mcp-Method header", { method: "tools/list", omitHeaderMethod: true }],
  ["an Mcp-Method that disagrees with the body", { method: "tools/list", headerMethod: "tools/call" }],
  [
    "a missing Mcp-Name header on tools/call",
    { method: "tools/call", params: { name: "read_note", arguments: {} }, omitHeaderName: true },
  ],
  [
    "an Mcp-Name that disagrees with the body",
    { method: "tools/call", params: { name: "read_note", arguments: {} }, headerName: "archive_note" },
  ],
];
for (const [label, options] of headerMismatchCases) {
  const res = await modernFetch(options);
  check(
    `${label} is refused with 400 and HeaderMismatch`,
    res.status === 400 && res.body?.error?.code === -32020
  );
}
// A method name inherited from Object.prototype must be an ordinary unknown
// method, not a crash. `NAME_HEADER_SOURCE` is a plain object literal, so a
// bare lookup resolved `__proto__`, `valueOf` and friends through the
// prototype: each is truthy, so the mirrored-header check took it for a rule
// and called it. That threw *outside* the try in `handleModernMcp`, escaped
// `fetch`, and returned a bodyless 500 in place of the JSON-RPC error the
// modern contract requires. The legacy path is a `switch` and never was
// affected — so this is per-era divergence, the shape CLAUDE.md warns about.
for (const prototypeMethod of [
  "__proto__",
  "valueOf",
  "hasOwnProperty",
  "__defineGetter__",
  "constructor",
  "toString",
]) {
  const modernRes = await modernFetch({ method: prototypeMethod });
  check(
    `a prototype-named method (${prototypeMethod}) is method-not-found on the modern path, not a crash`,
    modernRes.status !== 500 && modernRes.body?.error?.code === -32601
  );
  const legacyRes = await rpc("priv-token", prototypeMethod, {});
  check(
    `and the legacy path answers it identically (${prototypeMethod})`,
    legacyRes?.error?.code === -32601
  );
}

// A non-ASCII tool name travels base64-wrapped; the server must decode before
// comparing, or a legal name looks like an attack.
check(
  "a base64-sentinel Mcp-Name is decoded before it is compared",
  (
    await modernFetch({
      method: "tools/call",
      params: { name: "read_note", arguments: { path: "index.md" } },
      headerName: `=?base64?${btoa("read_note")}?=`,
    })
  ).status === 200
);
check(
  "a base64-sentinel Mcp-Name that decodes to the wrong name is still refused",
  (
    await modernFetch({
      method: "tools/call",
      params: { name: "read_note", arguments: { path: "index.md" } },
      headerName: `=?base64?${btoa("archive_note")}?=`,
    })
  ).body?.error?.code === -32020
);

// The modern era inverts negotiation: an error carrying `supported`, not a
// counter-offer in a result. Implementing these two backwards is precisely the
// bug that has broken real servers.
const unsupported = await modernFetch({
  method: "tools/list",
  bodyVersion: "2027-01-01",
  headerVersion: "2027-01-01",
});
check(
  "an unsupported modern version is a 400 UnsupportedProtocolVersionError",
  unsupported.status === 400 && unsupported.body?.error?.code === -32022
);
check(
  "the version error names what was requested and what is supported",
  unsupported.body?.error?.data?.requested === "2027-01-01" &&
    JSON.stringify(unsupported.body?.error?.data?.supported) === JSON.stringify([MODERN])
);
check(
  "the modern version error never points a modern client at a handshake revision",
  !unsupported.body?.error?.data?.supported?.some((v) => v < "2026-01-01")
);

// Unknown method is 404 on this transport, not 200-with-an-error. The status is
// what lets a dual-era client tell "no such method" from "not a modern server".
for (const gone of ["ping", "initialize", "logging/setLevel", "subscriptions/listen"]) {
  const res = await modernFetch({ method: gone });
  check(
    `${gone} is 404 with method-not-found in the modern era`,
    res.status === 404 && res.body?.error?.code === -32601
  );
}
check(
  "a modern notification is accepted with 202 and no body",
  (await modernFetch({ method: "notifications/progress", id: null })).status === 202
);
check(
  "batching does not exist in the modern era",
  (
    await modernFetch({
      method: "tools/list",
      rawBody: JSON.stringify([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } },
        },
      ]),
    })
  ).status === 400
);

// Sessions and resumability are gone: ignore the headers, never mint or echo.
const sessionProbe = await worker.fetch(
  new Request("https://x/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessTokenFor("priv-token")}`,
      "MCP-Protocol-Version": MODERN,
      "Mcp-Method": "tools/list",
      "Mcp-Session-Id": "attacker-chosen-session",
      "Last-Event-ID": "17",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: { _meta: { "io.modelcontextprotocol/protocolVersion": MODERN } },
    }),
  }),
  env,
  { waitUntil() {} }
);
check(
  "a session id is ignored and never echoed back",
  sessionProbe.status === 200 && !sessionProbe.headers.has("Mcp-Session-Id")
);
for (const verb of ["GET", "DELETE"]) {
  check(
    `${verb} on the MCP endpoint is 405`,
    (await modernFetch({ method: "tools/list", httpMethod: verb })).status === 405
  );
}

// --- and now the half that must not have moved: legacy clients ---
check(
  "a legacy client sending no version header still works",
  (await rpc("priv-token", "tools/list"))?.result?.tools.length === 24
);
async function legacyWithVersionHeader(version) {
  return worker.fetch(
    new Request("https://x/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessTokenFor("priv-token")}`,
        "MCP-Protocol-Version": version,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }),
    }),
    env,
    { waitUntil() {} }
  );
}
for (const version of ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]) {
  check(
    `a legacy client echoing ${version} is served`,
    (await legacyWithVersionHeader(version)).status === 200
  );
}
// At least one shipping client sends its own latest revision here instead of
// the negotiated one. Refusing that would break a session that negotiated fine.
check(
  "a legacy request whose version header names the modern revision is not silently mis-served",
  (await legacyWithVersionHeader("2026-07-28")).status === 400
);
check(
  "a version header naming a revision this server has never implemented is refused",
  (await legacyWithVersionHeader("1999-01-01")).status === 400
);

// The era inversion again, one layer down: same status code, opposite body
// obligation. Half of this is quoted and half is inferred, and the halves are
// labelled separately on purpose — nobody should later go hunting for a clause
// that does not exist.
//
// QUOTED. On the modern path the body is mandated: an unsupported version
// "MUST respond with `400 Bad Request` and an `UnsupportedProtocolVersionError`
// listing its supported versions", and a client is told that a recognized
// modern error in the body means "retry ... rather than falling back". So a
// bare `400` there is not a lesser failure, it is a wrong one — it routes the
// client into the era it just declined to use.
//
// INFERRED, and ours. The legacy rule says only "it MUST respond with `400 Bad
// Request`". No body is required and none is forbidden. That the legacy 400
// must *not* look like a modern error is this gateway's own hardening, argued
// rather than cited: both eras share one endpoint, so dressing a legacy-shaped
// refusal in a modern error body would hand a probing dual-era client the wrong
// era determination. Asserted rather than assumed, because an invariant with no
// clause behind it is exactly the kind that gets tidied away.
function isRecognizableModernError(res, code) {
  return (
    res.status === 400 &&
    res.body?.jsonrpc === "2.0" &&
    res.body?.error?.code === code &&
    typeof res.body?.error?.message === "string"
  );
}
check(
  "a modern version refusal is a recognizable modern error, never a bare 400",
  isRecognizableModernError(unsupported, -32022)
);
check(
  "a modern header refusal is a recognizable modern error, never a bare 400",
  isRecognizableModernError(
    await modernFetch({ method: "tools/list", omitHeaderMethod: true }),
    -32020
  )
);
check(
  "a legacy refusal is deliberately not a modern error body, so fallback still works",
  await (async () => {
    const res = await legacyWithVersionHeader("1999-01-01");
    const body = await res.json().catch(() => null);
    return res.status === 400 && body?.error?.code !== -32022 && body?.error?.code !== -32020;
  })()
);

check(
  "a legacy batch is still served for the revisions that defined batching",
  await (async () => {
    const res = await worker.fetch(
      new Request("https://x/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessTokenFor("priv-token")}`,
        },
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 21, method: "ping", params: {} },
          { jsonrpc: "2.0", id: 22, method: "ping", params: {} },
        ]),
      }),
      env,
      { waitUntil() {} }
    );
    return (await res.json()).length === 2;
  })()
);

// Incremental scope consent: name the scope that was missing, not the menu.
const scopeRefusal = await worker.fetch(
  new Request("https://x/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessTokenFor("inbox-token")}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 31, method: "ping", params: {} }),
  }),
  env,
  { waitUntil() {} }
);
check(
  "a scope refusal challenges for the one scope it needed",
  scopeRefusal.status === 403 &&
    /scope="context:read"/.test(scopeRefusal.headers.get("WWW-Authenticate"))
);
check(
  "a 401 with no grant at all still advertises the full scope menu",
  // Derived from the module rather than restated, so adding a scope and
  // forgetting the challenge header cannot pass here.
  new RegExp(`scope="${SUPPORTED_SCOPES.join(" ")}"`).test(
    (
      await worker.fetch(new Request("https://x/mcp", { method: "POST", body: "{}" }), env, {
        waitUntil() {},
      })
    ).headers.get("WWW-Authenticate")
  )
);

// -- orient scoping
const oPriv = (await call("priv-token", "orient"))?.content?.[0]?.text;
const oPub = (await call("pub-token", "orient"))?.content?.[0]?.text;
check("private orient has private manifest", oPriv?.includes("PRIVATE manifest"));
// Was: asserts orient tells agents to keep a ledger under `2-areas/agent-todos/`.
// That is one customer's house rule, and this gateway serves buckets organized
// years before it existed. The contract now points at their own front page for
// conventions, which is where a ledger rule actually belongs — and `orient`
// returns that front page directly above it.
check(
  "orient defers to the context's own conventions rather than inventing filing",
  oPriv?.includes("Follow their conventions, not a template") &&
    lacks(oPriv, "Read your weekly file")
);
check("team orient lacks private manifest", lacks(oPub, "PRIVATE manifest"));
check("team orient lacks secret project", lacks(oPub, "secret-thing"));
check("team orient shows team project", oPub?.includes("1-projects/togather"));
check("team orient hides 1:1 subfolder", lacks(oPub, "one-on-ones"));
check("orient hides .obsidian", lacks(oPub, ".obsidian") && lacks(oPriv, ".obsidian"));

// -- orient is the front door, so it has to be worth walking through
//
// The complaint these checks exist for is not a privacy bug: it is that a
// connected agent reads the orientation, learns nothing it can act on, and
// never comes back. So orient owes the caller three things beyond a folder
// list — the user's own front page, what they touched recently, and a reason
// to write anything back.
check("orient names the front page", oPriv?.includes("## Front page — index.md"));
check("orient carries the front page content", oPriv?.includes("# public manifest"));
check("orient surfaces recent activity", oPriv?.includes("## Recently updated"));
check(
  "orient dates recent activity relatively",
  /## Recently updated\n(?:- \S+\.md — (?:just now|\d+(?:m|h|d|w|mo|y) ago)\n)+/.test(oPriv)
);
check("orient asks the agent to write back", oPriv?.includes("Leave more than you took"));
check(
  "orient points at the next call rather than ending",
  oPriv?.includes("list_notes") && oPriv?.includes("search_notes")
);

// A count that included notes the caller cannot see would let a colleague
// subtract and derive exactly how much of the owner's context is being withheld
// from them — an exact private-note total handed to the person it was withheld
// from. So the numbers are derived from the same visibility filter as the
// listing, and asserted against `list_notes` rather than against a literal,
// so seeding another fixture below cannot quietly make this vacuous.
function orientFolderCount(text, prefix) {
  // `text` comes from a call result this file now guards, so it can be
  // undefined where it previously could not. The use is an argument rather
  // than a dereference, which is why no sweep for `oPriv.` or `oPriv?.` finds
  // it — the crash moved here when the assignment stopped throwing.
  if (typeof text !== "string") return null;
  const line = text.match(new RegExp(`^- ${prefix} — (\\d+)(\\+?) notes?$`, "m"));
  return line ? { count: Number(line[1]), floor: line[2] === "+" } : null;
}
/**
 * How many notes this connection can list under `prefix`, or `null` if the
 * listing never arrived.
 *
 * `null` rather than `undefined` on purpose, and it is the third shape of the
 * same bug. Neither `succeeded()` nor `lacks()` reaches an EQUALITY whose two
 * operands can both go absent independently: the callers below compare this
 * against `orientFolderCount(...)?.count`, and `undefined === undefined` is
 * `true`. Both counts vanishing is exactly the state where the two checks
 * asserting a team connection counts less than the owner would report PASS
 * having measured nothing on either side — and those are the named owners of
 * the property that stops a colleague deriving an exact private-note total.
 *
 * An empty listing is a real `0` and must stay distinguishable from that.
 */
async function visibleNoteCount(tokenLabel, prefix) {
  const listed = (await call(tokenLabel, "list_notes", { prefix }))?.content?.[0]?.text;
  if (typeof listed !== "string") return null;
  return listed === "(no visible notes under that prefix)" ? 0 : listed.split("\n").length;
}
const projectsPriv = orientFolderCount(oPriv, "1-projects/");
const projectsPub = orientFolderCount(oPub, "1-projects/");
check(
  "orient counts notes per folder",
  projectsPriv !== null && projectsPub !== null && !projectsPriv.floor && !projectsPub.floor
);
check(
  "orient counts only what the owner can see",
  typeof projectsPriv?.count === "number" &&
    projectsPriv.count === (await visibleNoteCount("priv-token", "1-projects"))
);
check(
  "orient counts only what a team connection can see",
  typeof projectsPub?.count === "number" &&
    projectsPub.count === (await visibleNoteCount("pub-token", "1-projects"))
);
check(
  "orient's team count is smaller than the owner's",
  projectsPub?.count < projectsPriv?.count
);
// Split first, then assert through `lacks`. Written inline the chain reads
// `!oPub?.split(...)[0].includes(x)`, and optional chaining short-circuits the
// WHOLE chain to undefined — so on a failed orient the negation is true twice
// and the check passes without an orientation existing.
const pubRecentActivity =
  typeof oPub === "string" ? oPub.split("## Structure")[0] : undefined;
check(
  "orient's recent activity never names a private note",
  lacks(pubRecentActivity, "secret-thing") && lacks(pubRecentActivity, "one-on-ones")
);
check(
  "orient omits the floor caveat when nothing was truncated",
  lacks(oPriv, "are floors")
);

// -- the ChatGPT dialect: search and fetch
//
// Outside developer mode, ChatGPT's chats can invoke exactly two tools on a
// custom connector — ones literally named `search` and `fetch`, in OpenAI's
// deep-research shape. Verified live before these existed: asked "who is my
// sister?", ChatGPT ranked Gmail and Contacts as the plausible sources and
// never considered this connector, because none of its tools were reachable.
// These are the same read capabilities as search_notes and read_note, so the
// checks that matter are that the shape parses and that the dialect discloses
// nothing the ordinary tools would not.
const openaiSearch = JSON.parse(
  (await call("priv-token", "search", { query: "togather" }))?.content?.[0]?.text
);
check(
  "search answers OpenAI's shape: a results array of id/title/text/url",
  Array.isArray(openaiSearch.results) &&
    openaiSearch.results.length > 0 &&
    openaiSearch.results.every(
      (r) =>
        typeof r.id === "string" &&
        typeof r.title === "string" &&
        typeof r.text === "string" &&
        typeof r.url === "string"
    )
);
check(
  "a result id round-trips through fetch",
  await (async () => {
    const fetched = JSON.parse(
      (await call("priv-token", "fetch", { id: openaiSearch.results[0].id }))?.content?.[0]?.text
    );
    return (
      fetched.id === openaiSearch.results[0].id &&
      typeof fetched.text === "string" &&
      fetched.text.length > 0 &&
      typeof fetched.metadata?.etag === "string"
    );
  })()
);
// The privacy checks, which are the reason this is not just a formatter: a
// team connection's search must not surface a private note, and fetch of a
// private path must be byte-identical to fetching a path that never existed.
const teamSearch = JSON.parse(
  (await call("pub-token", "search", { query: "PRIVATEWORD" }))?.content?.[0]?.text
);
check("a team search cannot surface a private note", teamSearch.results.length === 0);
const teamFetchPrivate = await call("pub-token", "fetch", { id: "1-projects/secret-thing/status.md" });
const teamFetchMissing = await call("pub-token", "fetch", { id: "1-projects/never-existed.md" });
check(
  "fetch of a private note is indistinguishable from fetch of nothing",
  teamFetchPrivate.isError === true &&
    JSON.stringify(teamFetchPrivate) === JSON.stringify(teamFetchMissing)
);
check(
  "fetch refuses plumbing and non-note ids",
  (await call("priv-token", "fetch", { id: "privacy.md" }))?.isError === true &&
    (await call("priv-token", "fetch", { id: ".history/index.md.x.archive.md" }))?.isError === true
);

// `.context/recover/` is new, and what it holds is the owner's copy of their
// own access map — the one file where "unreadable to every client" matters most.
// It is covered by the same dot-segment rule as everything else, which is the
// argument for putting it there; this is the check that the argument holds,
// at the owner's own scope and through every reader.
await contextStore.put(".context/recover/privacy.md.2026-01-01T00-00-00-000Z.md", "# manifest\n");
check(
  "the recovered manifest copy is unreadable to every client, owner included",
  (await call("priv-token", "fetch", { id: ".context/recover/privacy.md.2026-01-01T00-00-00-000Z.md" }))
    ?.isError === true &&
    (await call("priv-token", "read_note", {
      path: ".context/recover/privacy.md.2026-01-01T00-00-00-000Z.md",
    }))?.isError === true &&
    (await call("priv-token", "write_note", {
      path: ".context/recover/forged.md",
      content: "x",
    }))?.isError === true
);
check(
  "the dialect is read-only, so a read-only grant keeps it",
  (await rpc("readonly-token", "tools/list"))?.result.tools.some((t) => t.name === "search") &&
    succeeded(await call("readonly-token", "search", { query: "togather" }))
);

// -- the privacy tier is a property of the grant, not of the approver's role
//
// `owner-team-token` and `priv-token` are the SAME PERSON, the same role, the
// same workspace and the same bucket. They differ in one scope. Everything
// below is that one scope doing its job, in both directions — because a control
// that only ever narrows for the wrong reason (a broken token, a missing
// binding) is not a control, it is an outage.
//
// This is also the migration test. A grant issued before the tier existed looks
// exactly like `owner-team-token`: an owner, read and write, no
// `context:private`. It must read as `team`, because the alternative — reading
// an unmarked grant as private — leaves every grant that predates this feature
// at full access forever, on exactly the grants nobody was ever asked about.
const ownerTeamPrivateRead = await call("owner-team-token", "read_note", {
  path: "1-projects/secret-thing/status.md",
});
check(
  "an owner who granted team-tier cannot read their own private note",
  ownerTeamPrivateRead.isError === true &&
    ownerTeamPrivateRead.content[0].text === "not found" &&
    !JSON.stringify(ownerTeamPrivateRead).includes("PRIVATEWORD")
);
const ownerTeamSearch = await call("owner-team-token", "search_notes", { query: "PRIVATEWORD" });
check(
  "and cannot find it by searching for its contents",
  !JSON.stringify(ownerTeamSearch).includes("secret-thing")
);
const ownerTeamOrient = (await call("owner-team-token", "orient"))?.content?.[0]?.text;
check(
  "and is not shown the private manifest their private-tier client sees",
  lacks(ownerTeamOrient, "PRIVATE manifest") && lacks(ownerTeamOrient, "secret-thing")
);
// The other direction, so the three checks above are proving a tier and not a
// broken grant: the same token reads team content perfectly well, and the same
// note is readable by the same person's private-tier client.
const ownerTeamTeamRead = await call("owner-team-token", "read_note", {
  path: "1-projects/togather/status.md",
});
check(
  "the same team-tier grant still reads team notes normally",
  !ownerTeamTeamRead.isError && ownerTeamTeamRead.content[0].text.includes("togather status")
);
const ownerPrivateRead = await call("priv-token", "read_note", {
  path: "1-projects/secret-thing/status.md",
});
check(
  "and their private-tier client reads the very note the team-tier one cannot",
  !ownerPrivateRead.isError && ownerPrivateRead.content[0].text.includes("PRIVATEWORD")
);

// The role clamp, from the other side. This grant carries `context:private`
// because the control plane was compromised or confused — it refuses to write
// one, in two independent places — and the gateway still will not honour it.
const memberAskedPrivate = await call("member-asked-private-token", "read_note", {
  path: "1-projects/secret-thing/status.md",
});
check(
  "a member's grant carrying the tier scope is still refused private notes",
  memberAskedPrivate.isError === true && memberAskedPrivate.content[0].text === "not found"
);
// Same grant, same request, `context:write` in its scopes: a member is
// read-only in the workspace model, so the grant cannot confer writing either.
const memberAskedWrite = await call("member-asked-private-token", "write_note", {
  path: "1-projects/member-should-not-write.md",
  content: "no",
});
check(
  "and is still refused writing, whatever its scopes say",
  memberAskedWrite.isError === true &&
    memberAskedWrite.content[0].text.includes("permission denied") &&
    objects.has("1-projects/member-should-not-write.md") === false
);

// A narrowed scope set is enforced where it counts, not merely displayed. This
// owner ticked read and left write unticked; being the owner does not put it
// back.
const readonlyWrite = await call("readonly-token", "write_note", {
  path: "1-projects/readonly-should-not-write.md",
  content: "no",
});
check(
  "an owner's read-only grant cannot write, on the legacy path too",
  readonlyWrite.isError === true &&
    readonlyWrite.content[0].text.includes("permission denied") &&
    objects.has("1-projects/readonly-should-not-write.md") === false
);
check(
  "the tier is read off the grant and clamped by role, in one function",
  visibilityTierForGrant(["context:read", "context:private"], "owner") === "private" &&
    visibilityTierForGrant(["context:read"], "owner") === "team" &&
    visibilityTierForGrant([], "owner") === "team" &&
    visibilityTierForGrant(["context:read", "context:private"], "editor") === "team" &&
    visibilityTierForGrant(["context:read", "context:private"], "member") === "team"
);
check("orient exposes team write surface", oPub?.includes("Team-writable folder defaults") && oPub?.includes("2-areas"));
check(
  "orient identifies shared credentials as team access",
  /connection (?:scope|access): team/i.test(oPub) &&
    !/connection (?:scope|access): public/i.test(oPub) &&
    !/writable public prefixes/i.test(oPub)
);
const publicScopeInfo = (await call("pub-token", "scope_info"))?.content?.[0]?.text;
const privateScopeInfo = (await call("priv-token", "scope_info"))?.content?.[0]?.text;
check("team scope_info lists broad team PARA roots", publicScopeInfo?.includes("1-projects") && publicScopeInfo?.includes("2-areas") && publicScopeInfo?.includes("3-resources") && publicScopeInfo?.includes("4-archive"));
check("team scope_info hides private override names", lacks(publicScopeInfo, "one-on-ones"));
check("private scope_info can audit private overrides", privateScopeInfo?.includes("one-on-ones"));

// -- list/read scoping
const lPub = (await call("pub-token", "list_notes"))?.content?.[0]?.text;
check("team list hides privacy.md", lacks(lPub, "privacy.md"));
check("team list hides private", lacks(lPub, "secret-thing") && lacks(lPub, "one-on-ones"));
const rPub = await call("pub-token", "read_note", { path: "1-projects/secret-thing/status.md" });
check("team read of private → not found", rPub.isError && rPub.content[0].text === "not found");
const rPub2 = await call("pub-token", "read_note", { path: "2-areas/engineering/one-on-ones/alex.md" });
check("deeper private rule beats team parent", rPub2.isError);
const rPub3 = await call("pub-token", "read_note", { path: "2-areas/engineering/practices.md" });
check("team reads team area", rPub3.content[0].text.includes("eng practices"));

// -- writes
const wPub = await call("pub-token", "write_note", { path: "2-areas/health/gym.md", content: "x" });
check(
  "team write to private path returns non-leaking permission error",
  wPub.isError && wPub.content[0].text.includes("permission denied") && !wPub.content[0].text.includes("exists")
);
const wPub2 = await call("pub-token", "write_note", { path: "1-projects/togather/notes.md", content: "ok" });
check("legacy public token writes to a team path", !wPub2.isError);
const wPubNewFolder = await call("pub-token", "write_note", {
  path: "2-areas/apps/new-folder-created-by-note.md",
  content: "public app-area note",
});
check(
  "team connection creates a new folder under a broad team PARA root",
  !wPubNewFolder.isError && objects.has("2-areas/apps/new-folder-created-by-note.md")
);
const wPubDeepFolder = await call("team-token", "write_note", {
  path: "2-areas/apps/created-entirely-through-mcp/deep/nested/status.md",
  content: "deep team path",
});
check(
  "team connection creates arbitrarily nested implicit folders under a team default",
  !wPubDeepFolder.isError &&
    objects.has("2-areas/apps/created-entirely-through-mcp/deep/nested/status.md")
);

// -- folder defaults can be managed entirely through the personal MCP
const managedFolder = "2-areas/apps/mcp-managed-visibility";
const managedTeamPath = `${managedFolder}/team-before-change.md`;
const managedPrivatePath = `${managedFolder}/private-before-change.md`;
await call("priv-token", "write_note", {
  path: managedTeamPath,
  content: "team before folder change",
  visibility: "team",
  confirm_team_publish: true,
});
await call("priv-token", "write_note", {
  path: managedPrivatePath,
  content: "private before folder change",
  visibility: "private",
});
const folderPrivacyDryRun = await call("priv-token", "set_folder_visibility", {
  path: managedFolder,
  visibility: "private",
  dry_run: true,
});
const folderPrivacyDryRunText = folderPrivacyDryRun.content[0].text;
const folderPrivacyEtag = folderPrivacyDryRunText.match(/privacy_etag: (\S+)/)?.[1];
check(
  "folder visibility dry-run reports impact and makes no change",
  !folderPrivacyDryRun.isError &&
    folderPrivacyDryRunText.includes("dry run: no changes made") &&
    folderPrivacyDryRunText.includes("resulting_default: private") &&
    succeeded(await call("team-token", "read_note", { path: managedTeamPath }))
);
const folderPrivacyMissingEtag = await call("priv-token", "set_folder_visibility", {
  path: managedFolder,
  visibility: "private",
});
check(
  "folder visibility apply requires the privacy manifest etag",
  folderPrivacyMissingEtag.isError && folderPrivacyMissingEtag.content[0].text.includes("dry_run=true")
);
const makeFolderPrivate = await call("priv-token", "set_folder_visibility", {
  path: managedFolder,
  visibility: "private",
  expected_privacy_etag: folderPrivacyEtag,
});
const makeFolderPrivateText = makeFolderPrivate.content[0].text;
const privateFolderPrivacyEtag = makeFolderPrivateText.match(/new_privacy_etag: (\S+)/)?.[1];
const privacyAfterFolderPrivate = storedText("privacy.md");
check(
  "personal MCP atomically makes a folder private and hides every inherited note from team",
  !makeFolderPrivate.isError &&
    (await call("team-token", "read_note", { path: managedTeamPath }))?.isError &&
    (await call("team-token", "read_note", { path: managedPrivatePath }))?.isError &&
    privacyAfterFolderPrivate.includes(`  ${managedFolder}: private`)
);
/**
 * This check used to assert the opposite — that making a folder private removed
 * the now-redundant `private` override inside it. Since the fold, that line is
 * not only about its own path: it is the only thing narrowing every note that
 * folds onto it, including one in a differently-cased sibling folder that
 * `set_folder_visibility` never scans. Compacting it away published a private
 * note and reported `newly_team_visible_notes: 0`.
 *
 * The note's visibility is identical either way — it is private under the
 * folder rule and private under the override — so what was traded is a tidier
 * manifest for a fail-open publish, which is not a close call. A `team`
 * override that has become redundant is still compacted; only narrowings stay.
 */
check(
  "a redundant exact-note narrowing is kept, because a twin may be relying on it",
  privacyAfterFolderPrivate.includes(`  ${managedPrivatePath}: private`) &&
    (await call("team-token", "read_note", { path: managedPrivatePath }))?.isError === true
);
const teamBlockedUnderManagedPrivate = await call("team-token", "write_note", {
  path: `${managedFolder}/team-must-not-create.md`,
  content: "blocked",
});
check(
  "team nested creation is blocked only when the inherited folder default is private",
  teamBlockedUnderManagedPrivate.isError && !objects.has(`${managedFolder}/team-must-not-create.md`)
);
const publishFolderWithoutConfirmation = await call("priv-token", "set_folder_visibility", {
  path: managedFolder,
  visibility: "inherit",
  expected_privacy_etag: privateFolderPrivacyEtag,
});
check(
  "private folder to inherited-team transition requires explicit confirmation",
  publishFolderWithoutConfirmation.isError &&
    (await call("team-token", "read_note", { path: managedTeamPath }))?.isError
);
const publishFolderWithConfirmation = await call("priv-token", "set_folder_visibility", {
  path: managedFolder,
  visibility: "inherit",
  expected_privacy_etag: privateFolderPrivacyEtag,
  confirm_team_publish: true,
});
check(
  "confirmed inheritance change republishes the folder and removes its direct rule",
  !publishFolderWithConfirmation.isError &&
    succeeded(await call("team-token", "read_note", { path: managedTeamPath })) &&
    !storedText("privacy.md").includes(`  ${managedFolder}: private`)
);
const teamCannotChangeFolderVisibility = await call("team-token", "set_folder_visibility", {
  path: managedFolder,
  visibility: "private",
  dry_run: true,
});
check("team connections cannot mutate folder defaults", teamCannotChangeFolderVisibility.isError);

// -- per-note private/team visibility inside one logical folder
const teamMeetingPath = "2-areas/engineering/meetings/team-planning.md";
const privateMeetingPath = "2-areas/engineering/meetings/personnel-check-in.md";
const teamMeeting = await call("priv-token", "write_note", {
  path: teamMeetingPath,
  content: "# Team planning\n\nTEAM-SIDE-BY-SIDE-MARKER",
  visibility: "team",
  confirm_team_publish: true,
});
const privateMeeting = await call("priv-token", "write_note", {
  path: privateMeetingPath,
  content: "# Personnel check-in\n\nPRIVATE-SIDE-BY-SIDE-MARKER",
  visibility: "private",
});
check(
  "personal connection creates private and team notes side-by-side in one team folder",
  !teamMeeting.isError &&
    !privateMeeting.isError &&
    objects.has(teamMeetingPath) &&
    objects.has(privateMeetingPath)
);
check(
  "write_note reports the effective visibility explicitly",
  /visibility:\s*team/i.test(teamMeeting.content[0].text) &&
    /visibility:\s*private/i.test(privateMeeting.content[0].text)
);
const teamReadsTeamMeeting = await call("team-token", "read_note", { path: teamMeetingPath });
const teamReadsPrivateMeeting = await call("team-token", "read_note", { path: privateMeetingPath });
check("team connection reads the adjacent team note", !teamReadsTeamMeeting.isError);
check(
  "exact private note is indistinguishable from missing to a team connection",
  teamReadsPrivateMeeting.isError && teamReadsPrivateMeeting.content[0].text === "not found"
);
const teamMeetingList = (await call("team-token", "list_notes", {
  prefix: "2-areas/engineering/meetings",
})).content[0].text;
const teamPrivateSearch = (await call("team-token", "search_notes", {
  query: "PRIVATE-SIDE-BY-SIDE-MARKER",
})).content[0].text;
const teamOrientAfterPrivateNote = (await call("team-token", "orient"))?.content?.[0]?.text;
check(
  "private note is absent from team listings",
  teamMeetingList.includes(teamMeetingPath) && !teamMeetingList.includes(privateMeetingPath)
);
check("private note content is absent from team search", !teamPrivateSearch.includes(privateMeetingPath));
check(
  "private note name is absent from team orientation",
  lacks(teamOrientAfterPrivateNote, "personnel-check-in")
);

const privateScopeByPath = await call("priv-token", "scope_info", { path: privateMeetingPath });
const teamScopeByPath = await call("priv-token", "scope_info", { path: teamMeetingPath });
const hiddenScopeByPath = await call("team-token", "scope_info", { path: privateMeetingPath });
const absentMeetingPath = "2-areas/engineering/meetings/absent-note.md";
const absentScopeByPath = await call("team-token", "scope_info", { path: absentMeetingPath });
check(
  "scope_info(path) tells a personal connection the exact effective visibility",
  privateScopeByPath.content[0].text.includes(privateMeetingPath) &&
    /visibility:\s*private/i.test(privateScopeByPath.content[0].text) &&
    teamScopeByPath.content[0].text.includes(teamMeetingPath) &&
    /visibility:\s*team/i.test(teamScopeByPath.content[0].text)
);
check(
  "scope_info(path) does not disclose a private override to a team connection",
  !/effective visibility:\s*private/i.test(hiddenScopeByPath.content[0].text) &&
    !/(?:note|path) exists:\s*(?:yes|true)/i.test(hiddenScopeByPath.content[0].text) &&
    hiddenScopeByPath.content[0].text.replaceAll(privateMeetingPath, "<path>") ===
      absentScopeByPath.content[0].text.replaceAll(absentMeetingPath, "<path>")
);

const personalPrivateRead = (await call("priv-token", "read_note", {
  path: privateMeetingPath,
})).content[0].text;
const privateMeetingEtag = personalPrivateRead.match(/etag: (\S+)/)?.[1];
const privateUpdate = await call("priv-token", "write_note", {
  path: privateMeetingPath,
  content: "# Personnel check-in\n\nPRIVATE-UPDATED-MARKER",
  expected_etag: privateMeetingEtag,
});
check("updating a note without visibility preserves its private ACL", !privateUpdate.isError);
check(
  "updated private note stays unreadable and unsearchable to team",
  (await call("team-token", "read_note", { path: privateMeetingPath }))?.isError &&
    lacks(
      (await call("team-token", "search_notes", { query: "PRIVATE-UPDATED-MARKER" }))?.content?.[0]?.text,
      privateMeetingPath
    )
);

const teamCannotCreatePrivatePath = "2-areas/engineering/meetings/team-cannot-hide.md";
const teamPrivateWrite = await call("team-token", "write_note", {
  path: teamCannotCreatePrivatePath,
  content: "must not be filed",
  visibility: "private",
});
check(
  "team connection cannot directly create a private note",
  teamPrivateWrite.isError && !objects.has(teamCannotCreatePrivatePath)
);
const internetPublicWrite = await call("priv-token", "write_note", {
  path: "2-areas/engineering/meetings/internet-public.md",
  content: "must not become anonymous",
  visibility: "public",
});
check(
  "write_note exposes no internet-public visibility tier",
  internetPublicWrite.isError && !objects.has("2-areas/engineering/meetings/internet-public.md")
);
const misleadingFrontmatterPath = "2-areas/engineering/meetings/frontmatter-mismatch.md";
const misleadingFrontmatter = await call("priv-token", "write_note", {
  path: misleadingFrontmatterPath,
  content: "---\nscope: private\n---\n# Sensitive",
  visibility: "team",
  confirm_team_publish: true,
});
check(
  "server rejects private frontmatter paired with team visibility",
  misleadingFrontmatter.isError && !objects.has(misleadingFrontmatterPath)
);

const teamMeetingRead = (await call("priv-token", "read_note", { path: teamMeetingPath }))?.content?.[0]?.text;
const teamMeetingEtag = teamMeetingRead?.match(/etag: (\S+)/)?.[1];
const makeMeetingPrivate = await call("priv-token", "set_visibility", {
  path: teamMeetingPath,
  visibility: "private",
  expected_etag: teamMeetingEtag,
});
check(
  "personal connection can narrow a team note to private in place",
  !makeMeetingPrivate.isError &&
    objects.has(teamMeetingPath) &&
    (await call("team-token", "read_note", { path: teamMeetingPath }))?.isError
);
const nowPrivateMeetingRead = (await call("priv-token", "read_note", {
  path: teamMeetingPath,
})).content[0].text;
const nowPrivateMeetingEtag = nowPrivateMeetingRead.match(/etag: (\S+)/)?.[1];
const publishWithoutConfirmation = await call("priv-token", "set_visibility", {
  path: teamMeetingPath,
  visibility: "team",
  expected_etag: nowPrivateMeetingEtag,
});
check(
  "private to team transition requires explicit publication confirmation",
  publishWithoutConfirmation.isError &&
    (await call("team-token", "read_note", { path: teamMeetingPath }))?.isError
);
const publishWithConfirmation = await call("priv-token", "set_visibility", {
  path: teamMeetingPath,
  visibility: "team",
  expected_etag: nowPrivateMeetingEtag,
  confirm_team_publish: true,
});
check(
  "confirmed private to team transition publishes the same logical note",
  !publishWithConfirmation.isError &&
    objects.has(teamMeetingPath) &&
    succeeded(await call("team-token", "read_note", { path: teamMeetingPath }))
);
const teamCannotChangeVisibility = await call("team-token", "set_visibility", {
  path: teamMeetingPath,
  visibility: "private",
});
check("team connections cannot mutate note ACLs", teamCannotChangeVisibility.isError);

const inheritedPrivatePath = "2-areas/private/meetings/inherited-private.md";
const inheritedPrivateWrite = await call("priv-token", "write_note", {
  path: inheritedPrivatePath,
  content: "inherited private content",
  visibility: "private",
});
const inheritedPrivateEtag = (await call("priv-token", "read_note", {
  path: inheritedPrivatePath,
}))?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
const publishInsidePrivateFolder = await call("priv-token", "set_visibility", {
  path: inheritedPrivatePath,
  visibility: "team",
  expected_etag: inheritedPrivateEtag,
  confirm_team_publish: true,
});
const createTeamInsidePrivateFolder = await call("priv-token", "write_note", {
  path: "2-areas/private/meetings/invalid-team-child.md",
  content: "must stay absent",
  visibility: "team",
});
check("private note can be created under an inherited-private folder", !inheritedPrivateWrite.isError);
check(
  "explicitly confirmed exact team override works inside an inherited-private folder",
  !publishInsidePrivateFolder.isError &&
    createTeamInsidePrivateFolder.isError &&
    !objects.has("2-areas/private/meetings/invalid-team-child.md") &&
    succeeded(await call("team-token", "read_note", { path: inheritedPrivatePath }))
);
const teamUpdatesPublishedPrivateFolderNote = await call("team-token", "write_note", {
  path: inheritedPrivatePath,
  content: "team-updated exact exception",
  expected_etag: inheritedPrivateEtag,
});
check(
  "team connection can update a known exact-team note inside a private-default folder",
  !teamUpdatesPublishedPrivateFolderNote.isError
);

const teamToPrivateSource = "2-areas/engineering/meetings/team-to-private-move.md";
await call("priv-token", "write_note", {
  path: teamToPrivateSource,
  content: "team note that will move into a private tree",
  visibility: "team",
  confirm_team_publish: true,
});
const teamToPrivateMove = await call("priv-token", "move_note", {
  source: teamToPrivateSource,
  destination: "2-areas/private/meetings/team-to-private-move.md",
});
check(
  "moving a team note into an inherited-private folder safely tightens access",
  !teamToPrivateMove.isError &&
    (await call("team-token", "read_note", {
      path: "2-areas/private/meetings/team-to-private-move.md",
    })).isError
);

const movePrivateMeeting = await call("priv-token", "move_note", {
  source: privateMeetingPath,
  destination: "2-areas/engineering/meetings/personnel-check-in-renamed.md",
});
const movedPrivateMeetingPath = "2-areas/engineering/meetings/personnel-check-in-renamed.md";
check(
  "moving a private note within a team folder preserves its ACL",
  !movePrivateMeeting.isError &&
    objects.has(movedPrivateMeetingPath) &&
    !objects.has(privateMeetingPath) &&
    (await call("team-token", "read_note", { path: movedPrivateMeetingPath }))?.isError
);
const archivePrivateMeeting = await call("priv-token", "archive_note", {
  path: movedPrivateMeetingPath,
});
const archivedPrivateMeetingPath = archivePrivateMeeting.content[0].text.match(/→ (\S+)/)?.[1];
check(
  "archiving a private note preserves private visibility and logical history",
  !archivePrivateMeeting.isError &&
    archivedPrivateMeetingPath &&
    objects.has(archivedPrivateMeetingPath) &&
    !objects.has(movedPrivateMeetingPath) &&
    (await call("team-token", "read_note", { path: archivedPrivateMeetingPath }))?.isError
);

// -- etag CAS + history
const read1 = (await call("priv-token", "read_note", { path: "index.md" }))?.content?.[0]?.text;
const etag = read1?.match(/etag: (\S+)/)?.[1];
const wOk = await call("priv-token", "write_note", { path: "index.md", content: "v2", expected_etag: etag });
check("CAS write with fresh etag ok", !wOk.isError);
const wStale = await call("priv-token", "write_note", { path: "index.md", content: "v3", expected_etag: etag });
check("CAS write with stale etag conflicts", wStale.isError && wStale.content[0].text.includes("conflict"));
check(
  "an overwrite writes no history snapshot",
  ![...objects.keys()].some((k) => k.startsWith(".history/"))
);

// -- search scoping
const sPub = (await call("pub-token", "search_notes", { query: "status" }))?.content?.[0]?.text;
check("team search hides private hits", lacks(sPub, "secret-thing"));
const sPriv = (await call("priv-token", "search_notes", { query: "PRIVATEWORD" }))?.content?.[0]?.text;
check("private search finds private", sPriv?.includes("secret-thing"));
const sPrefixed = (await call("priv-token", "search_notes", {
  query: "portable",
  prefix: "1-projects/portable",
})).content[0].text;
check(
  "prefixed search stays inside the requested visible subtree",
  sPrefixed.includes("1-projects/portable/") && !sPrefixed.includes("2-areas/")
);

// -- archive
const arch = await call("priv-token", "archive_note", { path: "1-projects/togather/notes.md" });
const privateArchiveKey = [...objects.keys()].find((key) => key.endsWith("/1-projects/togather/notes.md"));
check(
  "archive preserves private ACL without a privacy-named folder",
  !arch.isError &&
    privateArchiveKey?.startsWith("4-archive/") &&
    !privateArchiveKey.startsWith("4-archive/private/") &&
    (await call("team-token", "read_note", { path: privateArchiveKey }))?.isError &&
    !objects.has("1-projects/togather/notes.md")
);
await call("pub-token", "write_note", { path: "1-projects/togather/probe.md", content: "temporary probe" });
const probeRead = (await call("pub-token", "read_note", { path: "1-projects/togather/probe.md" }))?.content?.[0]?.text;
const probeEtag = probeRead?.match(/etag: (\S+)/)?.[1];
const publicArchiveWithoutEtag = await call("pub-token", "archive_note", {
  path: "1-projects/togather/probe.md",
});
check("team archive requires etag", publicArchiveWithoutEtag.isError && objects.has("1-projects/togather/probe.md"));
const publicArchive = await call("pub-token", "archive_note", {
  path: "1-projects/togather/probe.md",
  expected_etag: probeEtag,
});
const publicArchiveKey = [...objects.keys()].find((key) => key.endsWith("/1-projects/togather/probe.md"));
check(
  "team archive retracts into team-visible recoverable archive",
  !publicArchive.isError &&
    publicArchiveKey?.startsWith("4-archive/") &&
    !publicArchiveKey.startsWith("4-archive/team/") &&
    !objects.has("1-projects/togather/probe.md")
);

// -- private-approval proposal queue
const proposal = await call("pub-token", "propose_note", {
  path: "2-areas/private/apps/example.md",
  content: "# Proposed app note",
  reason: "Apps belong in the apps area",
  agent: "Claude Code",
});
const proposalText = proposal.content[0].text;
const proposalId = proposalText.match(/proposal queued: ([0-9a-f-]+)/i)?.[1];
check(
  "team connection can queue a private-destination proposal without filing it",
  !proposal.isError && proposalId && !objects.has("2-areas/private/apps/example.md")
);
const publicProposalList = await call("pub-token", "list_proposals");
check("team connection cannot inspect proposal queue", publicProposalList.isError);
const privateProposalList = (await call("priv-token", "list_proposals"))?.content?.[0]?.text;
check(
  "private connection lists proposal metadata",
  privateProposalList?.includes(proposalId) &&
    privateProposalList?.includes("2-areas/private/apps/example.md") &&
    lacks(privateProposalList, "# Proposed app note")
);
const privateProposalRead = (await call("priv-token", "read_proposal", { id: proposalId }))?.content?.[0]?.text;
check("private connection reads proposal content", privateProposalRead?.includes("# Proposed app note"));
const approveProposal = await call("priv-token", "review_proposal", {
  id: proposalId,
  action: "approve",
});
check(
  "private approval files proposal and clears pending queue",
  !approveProposal.isError && objects.has("2-areas/private/apps/example.md") &&
    (await call("priv-token", "list_proposals"))?.content?.[0]?.text.includes("no pending")
);
const rejectedProposal = await call("pub-token", "propose_note", {
  path: "2-areas/private/apps/rejected.md",
  content: "reject me",
  reason: "testing rejection",
  agent: "Claude Code",
});
const rejectedId = rejectedProposal.content[0].text.match(/proposal queued: ([0-9a-f-]+)/i)?.[1];
const rejectReview = await call("priv-token", "review_proposal", { id: rejectedId, action: "reject" });
check("private rejection preserves no destination note", !rejectReview.isError && !objects.has("2-areas/private/apps/rejected.md"));

// -- privacy-aware chat history archives
const privateChatArchive = await call("priv-token", "save_context", {
  platform: "codex",
  history: "## User\nBuild the Brain.\n\n## Assistant\nDone.",
  completeness: "full-visible-transcript",
  title: "Private Codex transcript",
  session_id: "thread-private-1",
});
const privateChatPath = privateChatArchive.content[0].text.match(/saved: (\S+)/)?.[1];
check(
  "private connection defaults chat history to private",
  !privateChatArchive.isError &&
    privateChatPath?.startsWith("4-archive/chat-history/codex/") &&
    storedText(privateChatPath).includes('visibility: "private"') &&
    storedText(privateChatPath).includes('completeness: "full-visible-transcript"')
);
const publicReadPrivateChat = await call("pub-token", "read_note", { path: privateChatPath });
check("team connection cannot discover private chat history", publicReadPrivateChat.isError && publicReadPrivateChat.content[0].text === "not found");

const privatePublishedChat = await call("priv-token", "save_context", {
  platform: "chatgpt",
  history: "## User\nPublish this chat.\n\n## Assistant\nPublished.",
  visibility: "team",
  confirm_team_publish: true,
  completeness: "available-context",
});
const privatePublishedPath = privatePublishedChat.content[0].text.match(/saved: (\S+)/)?.[1];
check(
  "personal connection can explicitly publish a chat archive to team visibility",
  !privatePublishedChat.isError &&
    privatePublishedPath?.startsWith("4-archive/chat-history/chatgpt/") &&
    succeeded(await call("pub-token", "read_note", { path: privatePublishedPath }))
);

const publicChatArchive = await call("pub-token", "save_context", {
  platform: "claude",
  history: "## User\nTeam by default?\n\n## Assistant\nYes.",
});
const publicChatPath = publicChatArchive.content[0].text.match(/saved: (\S+)/)?.[1];
check(
  "team connection defaults chat history to team and labels partial context",
  !publicChatArchive.isError &&
    publicChatPath?.startsWith("4-archive/chat-history/claude/") &&
    storedText(publicChatPath).includes('visibility: "team"') &&
    storedText(publicChatPath).includes('completeness: "available-context"')
);

const publicPrivateChat = await call("pub-token", "save_context", {
  platform: "claude",
  history: "## User\nMake this one private.\n\n## Assistant\nQueued privately.",
  visibility: "private",
  completeness: "full-visible-transcript",
});
const privateChatProposalId = publicPrivateChat.content[0].text.match(/proposal queued: ([0-9a-f-]+)/i)?.[1];
const privateChatIntendedPath = publicPrivateChat.content[0].text.match(/intended path: (\S+)/)?.[1];
check(
  "team connection explicitly requesting private chat history creates a hidden proposal",
  !publicPrivateChat.isError &&
    privateChatProposalId &&
    privateChatIntendedPath?.startsWith("4-archive/chat-history/claude/") &&
    !objects.has(privateChatIntendedPath)
);
const approvePrivateChat = await call("priv-token", "review_proposal", {
  id: privateChatProposalId,
  action: "approve",
});
check(
  "personal reviewer can approve a team client's private chat archive",
  !approvePrivateChat.isError &&
    objects.has(privateChatIntendedPath) &&
    (await call("pub-token", "read_note", { path: privateChatIntendedPath }))?.isError
);

// archive_chat must respect the folder default the way write_note does. Make
// one platform's archive folder private and check that a team connection can no
// longer plant a team-visible note in it — while the sanctioned route into a
// private destination, a proposal for the owner to review, still works.
const notionFolderDry = await call("priv-token", "set_folder_visibility", {
  path: "4-archive/chat-history/notion",
  visibility: "private",
  dry_run: true,
});
const notionPrivacyEtag = notionFolderDry.content[0].text.match(/privacy_etag: (\S+)/)?.[1];
const notionFolderApply = await call("priv-token", "set_folder_visibility", {
  path: "4-archive/chat-history/notion",
  visibility: "private",
  expected_privacy_etag: notionPrivacyEtag,
});
check(
  "a folder default can be tightened to private for the archive_chat check",
  !notionFolderApply.isError
);
const teamArchiveIntoPrivateFolder = await call("pub-token", "save_context", {
  platform: "notion",
  history: "## User\nLand this in a private-default folder.\n\n## Assistant\nShould not.",
});
check(
  "archive_chat refuses a team connection writing into a private-default folder",
  teamArchiveIntoPrivateFolder.isError &&
    ![...objects.keys()].some(
      (key) => key.startsWith("4-archive/chat-history/notion/") && !key.startsWith(".")
    )
);
check(
  "and refuses it with the same permission error write_note uses, naming no path",
  teamArchiveIntoPrivateFolder.content[0].text.startsWith("permission denied:") &&
    !teamArchiveIntoPrivateFolder.content[0].text.includes("4-archive/chat-history") &&
    !teamArchiveIntoPrivateFolder.content[0].text.includes("notion")
);
const teamProposalIntoPrivateFolder = await call("pub-token", "save_context", {
  platform: "notion",
  history: "## User\nQueue it instead.\n\n## Assistant\nQueued.",
  visibility: "private",
});
check(
  "a team connection can still queue a private archive there for owner review",
  !teamProposalIntoPrivateFolder.isError &&
    /proposal queued: [0-9a-f-]+/i.test(teamProposalIntoPrivateFolder.content[0].text)
);
const personalArchiveIntoPrivateFolder = await call("priv-token", "save_context", {
  platform: "notion",
  history: "## User\nOwner archives here.\n\n## Assistant\nFine.",
});
check(
  "a personal connection still archives into its own private folder",
  !personalArchiveIntoPrivateFolder.isError &&
    /saved: 4-archive\/chat-history\/notion\//.test(
      personalArchiveIntoPrivateFolder.content[0].text
    )
);

// -- move note / folder
const portableRead = (await call("pub-token", "read_note", { path: "1-projects/portable/a.md" }))?.content?.[0]?.text;
const portableEtag = portableRead?.match(/etag: (\S+)/)?.[1];
const moveNote = await call("pub-token", "move_note", {
  source: "1-projects/portable/a.md",
  destination: "1-projects/portable/renamed.md",
  expected_source_etag: portableEtag,
});
check(
  "team move_note moves within team scope",
  !moveNote.isError && objects.has("1-projects/portable/renamed.md") && !objects.has("1-projects/portable/a.md")
);
const moveConflict = await call("pub-token", "move_note", {
  source: "1-projects/portable/renamed.md",
  destination: "1-projects/portable/existing.md",
});
check("move_note refuses destination overwrite", moveConflict.isError && objects.has("1-projects/portable/renamed.md"));
// A team move_folder over a tree with a private island moves what the caller
// can see and leaves the island alone. It must NOT refuse: refusing reports
// that unreadable content is in there, which is a private-note existence
// oracle a team connection can walk the whole tree with (see the dry-run
// indistinguishability check below).
const mixedMove = await call("pub-token", "move_folder", {
  source: "1-projects/mixed",
  destination: "1-projects/mixed-dest",
});
check(
  "team move_folder moves the visible half of a tree with a private island",
  !mixedMove.isError &&
    objects.has("1-projects/mixed-dest/public.md") &&
    !objects.has("1-projects/mixed/public.md")
);
check(
  "team move_folder leaves the private island where it was",
  objects.has("1-projects/mixed/private/secret.md") &&
    !objects.has("1-projects/mixed-dest/private/secret.md")
);
check(
  "the moved half stays team-readable and the island stays unreadable",
  succeeded(await call("pub-token", "read_note", { path: "1-projects/mixed-dest/public.md" })) &&
    (await call("pub-token", "read_note", { path: "1-projects/mixed/private/secret.md" }))?.isError
);

// The oracle itself. `1-projects/mixed/private` is private by folder default
// and, after the move above, is all that is left under `1-projects/mixed`. A
// team caller must not be able to tell that folder apart from one that was
// never created: both are "not found", byte for byte. dry_run makes the
// question free to ask, so any difference is walkable across the whole tree.
const onlyPrivateProbe = await call("pub-token", "move_folder", {
  source: "1-projects/mixed/private",
  destination: "1-projects/probe-dest",
  dry_run: true,
});
const neverExistedProbe = await call("pub-token", "move_folder", {
  source: "1-projects/no-such-folder-at-all",
  destination: "1-projects/probe-dest",
  dry_run: true,
});
check(
  "team move_folder dry_run cannot distinguish an all-private folder from a missing one",
  onlyPrivateProbe.isError &&
    neverExistedProbe.isError &&
    onlyPrivateProbe.content[0].text === neverExistedProbe.content[0].text
);
check(
  "the private-only probe changed nothing",
  objects.has("1-projects/mixed/private/secret.md")
);
// A personal connection still sees and moves the whole tree, islands included.
const personalIslandMove = await call("priv-token", "move_folder", {
  source: "1-projects/mixed",
  destination: "1-projects/mixed-personal",
});
check(
  "personal move_folder still moves a tree a team connection could only half-see",
  !personalIslandMove.isError &&
    objects.has("1-projects/mixed-personal/private/secret.md") &&
    !objects.has("1-projects/mixed/private/secret.md")
);
const privateFolderMove = await call("priv-token", "move_folder", {
  source: "1-projects/private-folder",
  destination: "1-projects/private-folder-renamed",
});
check(
  "personal move_folder moves a private tree without reducing privacy",
  !privateFolderMove.isError &&
    objects.has("1-projects/private-folder-renamed/a.md") &&
    !objects.has("1-projects/private-folder/a.md") &&
    (await call("team-token", "read_note", { path: "1-projects/private-folder-renamed/a.md" }))?.isError
);
check(
  "a folder move writes no history snapshot",
  ![...objects.keys()].some((key) => key.startsWith(".history/"))
);

// -- batch move plan and apply
await call("pub-token", "write_note", { path: "1-projects/portable/batch-a.md", content: "batch a" });
await call("pub-token", "write_note", { path: "1-projects/portable/batch-b.md", content: "batch b" });
const batchPlan = await call("pub-token", "move_notes", {
  dry_run: true,
  moves: [
    { source: "1-projects/portable/batch-a.md", destination: "1-projects/portable-moved/batch-a.md" },
    { source: "1-projects/portable/batch-b.md", destination: "1-projects/portable-moved/batch-b.md" },
  ],
});
const batchPlanText = batchPlan.content[0].text;
const batchEtags = [...batchPlanText.matchAll(/etag (\S+)\)/g)].map((match) => match[1]);
check(
  "batch dry-run validates without changing data",
  !batchPlan.isError && batchEtags.length === 2 &&
    objects.has("1-projects/portable/batch-a.md") && !objects.has("1-projects/portable-moved/batch-a.md")
);
// Simulate a Worker invocation that copied one identical destination before
// hitting its request limit. A retry must resume without treating it as a
// conflicting overwrite.
await contextStore.put("1-projects/portable-moved/batch-a.md", "batch a");
const batchWithoutEtags = await call("pub-token", "move_notes", {
  moves: [
    { source: "1-projects/portable/batch-a.md", destination: "1-projects/portable-moved/batch-a.md" },
    { source: "1-projects/portable/batch-b.md", destination: "1-projects/portable-moved/batch-b.md" },
  ],
});
check("batch apply requires etags", batchWithoutEtags.isError && objects.has("1-projects/portable/batch-a.md"));
const batchApply = await call("pub-token", "move_notes", {
  moves: [
    {
      source: "1-projects/portable/batch-a.md",
      destination: "1-projects/portable-moved/batch-a.md",
      expected_source_etag: batchEtags[0],
    },
    {
      source: "1-projects/portable/batch-b.md",
      destination: "1-projects/portable-moved/batch-b.md",
      expected_source_etag: batchEtags[1],
    },
  ],
});
check(
  "batch apply resumes identical partial copies and moves every note",
  !batchApply.isError &&
    !objects.has("1-projects/portable/batch-a.md") &&
    !objects.has("1-projects/portable/batch-b.md") &&
    objects.has("1-projects/portable-moved/batch-a.md") &&
    objects.has("1-projects/portable-moved/batch-b.md")
);
const folderDryRun = await call("pub-token", "move_folder", {
  source: "1-projects/portable-moved",
  destination: "1-projects/portable",
  dry_run: true,
});
check(
  "folder move dry-run makes no changes",
  !folderDryRun.isError &&
    folderDryRun.content[0].text.includes("preflight ok") &&
    objects.has("1-projects/portable-moved/batch-a.md")
);

// Archive-to-archive relocations already retain a recoverable destination, so
// they avoid creating a redundant history copy when visibility is unchanged.
await contextStore.put("4-archive/old-layout/a.md", "archived a");
const archiveRelocationPlan = await call("priv-token", "move_notes", {
  dry_run: true,
  moves: [{ source: "4-archive/old-layout/a.md", destination: "4-archive/new-layout/a.md" }],
});
const archiveRelocationEtag = archiveRelocationPlan.content[0].text.match(/etag (\S+)\)/)?.[1];
const archiveRelocation = await call("priv-token", "move_notes", {
  moves: [{
    source: "4-archive/old-layout/a.md",
    destination: "4-archive/new-layout/a.md",
    expected_source_etag: archiveRelocationEtag,
  }],
});
check(
  "archive relocation moves the note",
  !archiveRelocation.isError &&
    !objects.has("4-archive/old-layout/a.md") &&
    objects.has("4-archive/new-layout/a.md")
);

// Every write path that used to snapshot has now run in this suite: an
// overwriting write_note, archive_note, move_note, move_notes and move_folder.
// The guard is the sweep, not any one of them — a snapshot restored to a single
// path is the regression this pins, and it is cheap to check the whole bucket.
check(
  "no gateway write path snapshots to .history/",
  ![...objects.keys()].some((key) => key.startsWith(".history/"))
);

// -- immutable, scope-filtered audit log
await call("priv-token", "write_note", {
  path: "1-projects/secret-thing/private-update.md",
  content: "private audit marker",
});
const publicChanges = (await call("pub-token", "list_changes", { limit: 100 }))?.content?.[0]?.text;
const privateChanges = (await call("priv-token", "list_changes", { limit: 100 }))?.content?.[0]?.text;
check("team change log shows team move", publicChanges?.includes("move_note"));
check("team change log hides private paths", lacks(publicChanges, "secret-thing") && lacks(publicChanges, "private-folder"));
check("private change log includes private paths", privateChanges?.includes("secret-thing") && privateChanges?.includes("private-folder"));
check(
  "team audit log filters exact-note private ACL events inside team folders",
  lacks(publicChanges, "personnel-check-in") &&
    publicChanges
      .split("\n")
      .filter((line) => line.includes("set_visibility") && line.includes(teamMeetingPath)).length === 0
);
check(
  "personal audit log retains private ACL, move, and archive events",
  privateChanges?.includes("personnel-check-in") &&
    privateChanges?.includes("set_visibility") &&
    privateChanges?.includes("inherited-private")
);
const listAfterAudit = (await call("priv-token", "list_notes"))?.content?.[0]?.text;
check("audit plumbing is hidden from note listings", lacks(listAfterAudit, ".audit/"));

// -- path token + inbox
const pt = await worker.fetch(
  new Request(`https://x/t/${encodeURIComponent(accessTokenFor("pub-token"))}/mcp`, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 999, method: "ping" }),
  }),
  env,
  { waitUntil() {} }
);
check("token-in-path auth works", (await pt.json()).id === 999);
const inbox = await worker.fetch(
  new Request("https://x/inbox", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessTokenFor("inbox-token")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Idea!", text: "capture me" }),
  }),
  env,
  { waitUntil() {} }
);
const inboxBody = await inbox.json();
check("inbox capture lands in 0-inbox", inboxBody.ok && inboxBody.path.startsWith("0-inbox/") && objects.has(inboxBody.path));
const granolaPayload = {
  title: "Weekly Leadership Sync",
  text: "## Summary\nWe made a decision.",
  source: "granola",
  external_id: "granola-note-123",
  source_url: "https://app.granola.ai/notes/granola-note-123",
  source_created_at: "2026-08-21T15:00:00Z",
  attendees: ["Seyi", "Alex"],
  metadata: { calendar_event: "Weekly Leadership Sync" },
};
const granolaRequest = () =>
  new Request("https://x/inbox", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessTokenFor("inbox-token")}`, "Content-Type": "application/json" },
    body: JSON.stringify(granolaPayload),
  });
const granolaInbox = await worker.fetch(granolaRequest(), env, { waitUntil() {} });
const granolaBody = await granolaInbox.json();
const granolaNote = storedText(granolaBody.path) || "";
check(
  "structured Granola capture preserves context",
  granolaBody.ok &&
    granolaBody.path.startsWith("0-inbox/granola/") &&
    granolaNote.includes('source: "granola"') &&
    granolaNote.includes('external-id: "granola-note-123"') &&
    granolaNote.includes("Seyi") &&
    granolaNote.includes("https://app.granola.ai/notes/granola-note-123") &&
    granolaNote.includes('"calendar_event": "Weekly Leadership Sync"')
);
const granolaRetry = await worker.fetch(granolaRequest(), env, { waitUntil() {} });
const granolaRetryBody = await granolaRetry.json();
check(
  "structured inbox capture deduplicates provider retries",
  granolaRetryBody.ok && granolaRetryBody.duplicate === true && granolaRetryBody.path === granolaBody.path
);
const invalidInboxJson = await worker.fetch(
  new Request("https://x/inbox", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessTokenFor("inbox-token")}`, "Content-Type": "application/json" },
    body: "{nope",
  }),
  env,
  { waitUntil() {} }
);
check("inbox rejects malformed JSON", invalidInboxJson.status === 400);
const oversizedInbox = await worker.fetch(
  new Request("https://x/inbox", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessTokenFor("inbox-token")}`,
      "Content-Type": "text/plain",
      "Content-Length": "2000001",
    },
    body: "too large",
  }),
  env,
  { waitUntil() {} }
);
check("inbox rejects oversized captures", oversizedInbox.status === 413);
const inboxBad = await worker.fetch(
  new Request("https://x/inbox", { method: "POST", headers: { Authorization: "Bearer pub-token" }, body: "hi" }),
  env,
  { waitUntil() {} }
);
check("inbox rejects team token", inboxBad.status === 401);

// -- native Granola webhook: signed event → API fetch → private inbox
async function signedGranolaRequest(event, { timestamp = Math.floor(Date.now() / 1000), signature = null } = {}) {
  const raw = JSON.stringify(event);
  const webhookId = event.event_id;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("granola-webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${webhookId}.${timestamp}.${raw}`)
    )
  );
  const encoded = btoa(String.fromCharCode(...bytes));
  return new Request("https://x/granola-webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signature || `v1,${encoded}`,
    },
    body: raw,
  });
}

const granolaEvent = {
  event_id: "8f1c2a4e-6b3d-4e8f-9a2b-1c5d7e9f0a3b",
  event_type: "note.generated",
  note_id: "not_1d3tmYTlCICgjy",
  occurred_at: "2026-08-21T15:30:00Z",
};
let granolaAuthorization = null;
globalThis.fetch = async (url, options) => {
  if (String(url).includes("public-api.granola.ai/v1/notes/not_1d3tmYTlCICgjy")) {
    granolaAuthorization = options?.headers?.Authorization ?? null;
    return Response.json({
      id: "not_1d3tmYTlCICgjy",
      title: "Quarterly yoghurt budget review",
      created_at: "2026-08-21T15:30:00Z",
      updated_at: "2026-08-21T16:45:00Z",
      web_url: "https://notes.granola.ai/d/example",
      owner: { name: "Seyi", email: "seyi@example.com" },
      attendees: [{ name: "Raisin Patel", email: "raisin@example.com" }],
      calendar_event: { event_title: "Yoghurt review" },
      folder_membership: [{ id: "fol_123", name: "AI Brain Inbox" }],
      summary_markdown: "## Decision\n\nBuy more yoghurt.",
    });
  }
  return new Response("not found", { status: 404 });
};
const granolaWork = [];
const granolaWebhook = await worker.fetch(await signedGranolaRequest(granolaEvent), env, {
  waitUntil: (promise) => granolaWork.push(promise),
});
await Promise.all(granolaWork);
const nativeGranolaNotes = [...objects.entries()].filter(([key]) => key.startsWith("0-inbox/granola/"));
const nativeGranolaText = nativeGranolaNotes.map(([key]) => storedText(key)).join("\n");
check(
  "signed Granola webhook fetches and files the full note",
  granolaWebhook.status === 202 &&
    nativeGranolaText.includes("Buy more yoghurt") &&
    nativeGranolaText.includes("Raisin Patel <raisin@example.com>") &&
    nativeGranolaText.includes("AI Brain Inbox")
);
check(
  "Granola note fetch still carries its API credential",
  granolaAuthorization === "Bearer granola-api-key"
);
check(
  "completed Granola webhook leaves no pending event",
  ![...objects.keys()].some((key) => key.startsWith(".granola-events/pending/")) &&
    [...objects.keys()].some((key) => key.startsWith(".granola-events/completed/"))
);
const granolaDuplicate = await worker.fetch(await signedGranolaRequest(granolaEvent), env, {
  waitUntil() {},
});
check("Granola webhook deduplicates event retries", (await granolaDuplicate.json()).duplicate === true);
const badGranolaSignature = await worker.fetch(
  await signedGranolaRequest({ ...granolaEvent, event_id: "another-event-id" }, { signature: "v1,bad" }),
  env,
  { waitUntil() {} }
);
check("Granola webhook rejects invalid signatures", badGranolaSignature.status === 401);
const staleGranolaSignature = await worker.fetch(
  await signedGranolaRequest(
    { ...granolaEvent, event_id: "stale-event-id" },
    { timestamp: Math.floor(Date.now() / 1000) - 601 }
  ),
  env,
  { waitUntil() {} }
);
check("Granola webhook rejects replayed old deliveries", staleGranolaSignature.status === 401);

// -- calendar cron
env.CALENDAR_ICS_URL = "https://fake/cal.ics";
const soon = new Date(Date.now() + 3 * 24 * 3600 * 1000);
const y = soon.getUTCFullYear(), mo = String(soon.getUTCMonth() + 1).padStart(2, "0"), d = String(soon.getUTCDate()).padStart(2, "0");
globalThis.fetch = async () =>
  new Response(
    `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:${y}${mo}${d}T140000Z\r\nSUMMARY:Team\r\n  sync\r\nLOCATION:HQ\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
  );
await worker.scheduled({}, env, { waitUntil: (p) => p });
await new Promise((r) => setTimeout(r, 50));
const cal = storedText("2-areas/calendar/next-14-days.md") || "";
check("cron writes calendar note", cal.includes("Team sync") && cal.includes("@ HQ") && cal.includes("14:00"));

function icsStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function utcAt(date, hour) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour));
}
function shifted(date, { days = 0, months = 0, years = 0 } = {}) {
  const copy = new Date(date);
  if (years) copy.setUTCFullYear(copy.getUTCFullYear() + years);
  if (months) copy.setUTCMonth(copy.getUTCMonth() + months);
  if (days) copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

const targetDay = new Date(Date.now() + 3 * 24 * 3600 * 1000);
const weeklyTarget = utcAt(targetDay, 10);
const weeklyStart = shifted(weeklyTarget, { days: -21 });
const weeklyExcluded = shifted(weeklyTarget, { days: 7 });
const movedMasterStart = utcAt(shifted(targetDay, { days: -21 }), 16);
const movedOriginal = utcAt(targetDay, 16);
const movedActual = utcAt(targetDay, 17);
const cancelledMasterStart = utcAt(shifted(targetDay, { days: -21 }), 18);
const cancelledOriginal = utcAt(targetDay, 18);
const dailyStart = utcAt(targetDay, 9);

const monthlyTargetDay = new Date(targetDay);
if (monthlyTargetDay.getUTCDate() > 28) {
  monthlyTargetDay.setUTCDate(monthlyTargetDay.getUTCDate() + (32 - monthlyTargetDay.getUTCDate()));
}
const monthlyTarget = utcAt(monthlyTargetDay, 11);
const monthlyStart = shifted(monthlyTarget, { months: -3 });
const bySetPos = Math.ceil(monthlyTarget.getUTCDate() / 7);
const bySetPosWeekday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][monthlyTarget.getUTCDay()];
const bySetPosStartMonth = shifted(monthlyTarget, { months: -3 });
const firstOfStartMonth = new Date(Date.UTC(
  bySetPosStartMonth.getUTCFullYear(),
  bySetPosStartMonth.getUTCMonth(),
  1,
  13
));
const bySetPosStart = new Date(firstOfStartMonth);
bySetPosStart.setUTCDate(
  1 + ((monthlyTarget.getUTCDay() - firstOfStartMonth.getUTCDay() + 7) % 7) + (bySetPos - 1) * 7
);
const endedStart = shifted(weeklyTarget, { days: -21 });
const endedUntil = shifted(weeklyTarget, { days: -7 });

const yearlyTargetDay = new Date(targetDay);
if (yearlyTargetDay.getUTCMonth() === 1 && yearlyTargetDay.getUTCDate() === 29) {
  yearlyTargetDay.setUTCDate(28);
}
const yearlyTarget = utcAt(yearlyTargetDay, 12);
const yearlyStart = shifted(yearlyTarget, { years: -3 });

globalThis.fetch = async () =>
  new Response(
    `BEGIN:VCALENDAR\r\n` +
    `BEGIN:VEVENT\r\nUID:weekly\r\nDTSTART:${icsStamp(weeklyStart)}\r\nRRULE:FREQ=WEEKLY;COUNT=8\r\nEXDATE:${icsStamp(weeklyExcluded)}\r\nSUMMARY:Weekly review\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:moved\r\nDTSTART:${icsStamp(movedMasterStart)}\r\nRRULE:FREQ=WEEKLY;COUNT=8\r\nSUMMARY:Regular slot\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:moved\r\nRECURRENCE-ID:${icsStamp(movedOriginal)}\r\nDTSTART:${icsStamp(movedActual)}\r\nSUMMARY:Rescheduled slot\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:cancelled\r\nDTSTART:${icsStamp(cancelledMasterStart)}\r\nRRULE:FREQ=WEEKLY;COUNT=8\r\nSUMMARY:Cancelled occurrence\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:cancelled\r\nRECURRENCE-ID:${icsStamp(cancelledOriginal)}\r\nDTSTART:${icsStamp(cancelledOriginal)}\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:daily\r\nDTSTART:${icsStamp(dailyStart)}\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:Daily focus\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:monthly\r\nDTSTART:${icsStamp(monthlyStart)}\r\nRRULE:FREQ=MONTHLY;COUNT=6;BYMONTHDAY=${monthlyTarget.getUTCDate()}\r\nSUMMARY:Monthly review\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:bysetpos\r\nDTSTART:${icsStamp(bySetPosStart)}\r\nRRULE:FREQ=MONTHLY;COUNT=6;BYDAY=${bySetPosWeekday};BYSETPOS=${bySetPos}\r\nSUMMARY:Positioned monthly review\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:ended\r\nDTSTART:${icsStamp(endedStart)}\r\nRRULE:FREQ=WEEKLY;UNTIL=${icsStamp(endedUntil)}\r\nSUMMARY:Expired recurrence\r\nEND:VEVENT\r\n` +
    `BEGIN:VEVENT\r\nUID:yearly\r\nDTSTART:${icsStamp(yearlyStart)}\r\nRRULE:FREQ=YEARLY;COUNT=6;BYMONTH=${yearlyTarget.getUTCMonth() + 1};BYMONTHDAY=${yearlyTarget.getUTCDate()}\r\nSUMMARY:Yearly reminder\r\nEND:VEVENT\r\n` +
    `END:VCALENDAR\r\n`
  );
await worker.scheduled({}, env, { waitUntil: (p) => p });
await new Promise((r) => setTimeout(r, 50));
const recurringCal = storedText("2-areas/calendar/next-14-days.md") || "";
const targetSection = recurringCal
  .split(`## ${weeklyTarget.toISOString().slice(0, 10)}\n`)[1]
  ?.split("\n## ")[0] || "";
check("cron expands past-anchored weekly recurrence", recurringCal.includes("10:00 — Weekly review"));
check("cron honors recurrence EXDATE", (recurringCal.match(/Weekly review/g) || []).length === 1);
check("cron applies moved recurrence exception", targetSection.includes("17:00 — Rescheduled slot") && !targetSection.includes("16:00 — Regular slot"));
check("cron applies cancelled recurrence exception", !targetSection.includes("18:00 — Cancelled occurrence"));
check("cron honors recurrence COUNT", (recurringCal.match(/Daily focus/g) || []).length === 3);
check("cron expands monthly recurrence", recurringCal.includes("11:00 — Monthly review"));
check("cron honors recurrence BYSETPOS", recurringCal.includes("13:00 — Positioned monthly review"));
check("cron honors recurrence UNTIL", !recurringCal.includes("Expired recurrence"));
check("cron expands yearly recurrence", recurringCal.includes("12:00 — Yearly reminder"));
check("calendar note reports recurring support", recurringCal.includes("Common recurring-event rules are expanded"));

// -- images: resolve-by-reference over an opaque, unlistable store
//
// The calendar cron checks above replace globalThis.fetch to serve an ICS feed;
// these checks authenticate for real, so the control plane goes back first.
controlPlane.install();
//
// The premise of the whole feature. `.images/` is plumbing, so it is invisible
// to every listing and unreadable by every note tool — that part is free. What
// is not free is reaching an image *at all* without reopening any of it, and
// this is the only path that does: name a note you can already see, and that
// note must name the image.
//
// Every refusal below is the same three bytes. "no such image", "no such note",
// "you cannot see that note" and "that note does not reference this image" must
// be indistinguishable, or the tool becomes an existence oracle over a store
// whose entire point is that it cannot be enumerated.
const PNG_BYTES = new Uint8Array([
  // A real PNG header, then bytes that are deliberately not valid UTF-8. If the
  // pipeline mangles them the base64 comparison below fails loudly, which is
  // exactly what the old string-backed stub could not do.
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0xc0, 0x80, 0x01,
]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString("base64");
const TEAM_IMAGE = `${"a".repeat(64)}.png`;
const PRIVATE_IMAGE = `${"b".repeat(64)}.png`;
const ORPHAN_IMAGE = `${"c".repeat(64)}.png`;
const SHARED_IMAGE = `${"d".repeat(64)}.png`;
const SCRIPT_OBJECT = `${"e".repeat(64)}.sh`;

for (const leaf of [TEAM_IMAGE, PRIVATE_IMAGE, ORPHAN_IMAGE, SHARED_IMAGE, SCRIPT_OBJECT]) {
  await contextStore.put(`.images/${leaf}`, PNG_BYTES);
}
// Markdown inside the image store. Not note surface, at any scope: it must be
// unlistable and unsearchable exactly like the binaries beside it.
await contextStore.put(".images/stray.md", "# IMAGESTOREMARKER\n");
// 1-projects is a team-default folder; 1-projects/secret-thing is private.
await contextStore.put(
  "1-projects/portable/with-image.md",
  `# team note\n\n![a screenshot](.images/${TEAM_IMAGE})\n`
);
await contextStore.put(
  "1-projects/secret-thing/with-image.md",
  `# private note\n\n![a screenshot](.images/${PRIVATE_IMAGE})\n`
);
// One image, two notes, two visibilities. The consequence is asserted below
// rather than left to be discovered.
await contextStore.put(
  "1-projects/portable/shared-image.md",
  `# team half\n\n![shared](.images/${SHARED_IMAGE})\n`
);
await contextStore.put(
  "1-projects/secret-thing/shared-image.md",
  `# private half\n\n![shared](.images/${SHARED_IMAGE})\n`
);
await contextStore.put(
  "1-projects/portable/with-script.md",
  `# team note\n\n[not an image](.images/${SCRIPT_OBJECT})\n`
);
await contextStore.put("1-projects/portable/no-image.md", "# team note with no image at all\n");

const imageTools = await rpc("priv-token", "tools/list");
check(
  "read_image is discoverable and read-only",
  imageTools.result?.tools.find((tool) => tool.name === "read_image")?.annotations?.readOnlyHint === true
);
check(
  "a read-only grant may still resolve images",
  (await modernFetch({ method: "tools/list", token: "readonly-token" })).body.result?.tools.some(
    (tool) => tool.name === "read_image"
  )
);

const okImage = await call("priv-token", "read_image", {
  note: "1-projects/portable/with-image.md",
  image: `.images/${TEAM_IMAGE}`,
});
const okImageBlock = okImage.content?.find((block) => block.type === "image");
check(
  "a note the caller can see resolves the image it references",
  !okImage.isError && okImageBlock?.mimeType === "image/png"
);
check(
  "the bytes survive the round trip exactly",
  okImageBlock?.data === PNG_BASE64
);
check(
  "the leaf alone resolves as well as the full plumbing path",
  (await call("priv-token", "read_image", {
    note: "1-projects/portable/with-image.md",
    image: TEAM_IMAGE,
  })).content?.find((block) => block.type === "image")?.data === PNG_BASE64
);

// -- the refusals, all identical
const REFUSAL = "not found";
const refusalText = (result) => (result.isError ? result.content?.[0]?.text : `RESOLVED:${JSON.stringify(result)}`);
const bareHash = await call("priv-token", "read_image", { image: `.images/${TEAM_IMAGE}` });
check("an image cannot be resolved without naming a note", refusalText(bareHash) === REFUSAL);
const unreferenced = await call("priv-token", "read_image", {
  note: "1-projects/portable/no-image.md",
  image: `.images/${TEAM_IMAGE}`,
});
check(
  "a note that does not reference the image resolves nothing",
  refusalText(unreferenced) === REFUSAL
);
const orphan = await call("priv-token", "read_image", {
  note: "1-projects/portable/with-image.md",
  image: `.images/${ORPHAN_IMAGE}`,
});
check("an image no named note references resolves nothing", refusalText(orphan) === REFUSAL);

// The `.md` half of the note check, which nothing held: dropping
// `.endsWith(".md")` from `toolReadImage` passed the entire suite.
//
// It is not redundant with `canSee`. At private scope `canSee` returns true for
// *any* non-plumbing key, and at team scope it asks the folder's visibility —
// neither asks whether the key is a note. So without it `read_image` accepts a
// non-markdown object as the "note", reads it, and answers on whether its bytes
// contain the leaf.
//
// **What that is worth. Two reviews, and the second measured what the first two
// versions of this comment only asserted.** Version one called it "a one-bit
// oracle over files no note tool will open", on the strength of `read_note`
// refusing a `.csv` — it does not, `toolReadNote` is `normalizePath` + `canSee`
// with no `.md` gate. Version two corrected that into "a strict subset of what
// `read_note` already grants — one bit about something wholly readable", which
// is wrong in the other direction and by more.
//
// What the mutated tool returns is the **image's bytes**, at private and team
// scope alike, and nothing else in the gateway can return them. The image lives
// under `.images/`, a dot-prefixed segment, so `isPlumbing` refuses it and
// `read_note` of that key answers `not found` at every scope. The `note`
// argument is the *only* authorization the image store has — the neighbouring
// check above says so in its own words, an image no named note references
// resolves nothing — and the `.md` gate is what stops any object the caller can
// see from being that note. The chain needs no prior knowledge of the hash:
// read the `.csv` (ungated, as above), take the leaf out of its text, pass the
// `.csv` as the note.
//
// It is not `#116` that made this reachable, which version two also claimed.
// `writeImage` writes only under `.images/`, and a plumbing key can never be
// the `note` argument. A non-`.md` object on the *note* surface arrives the way
// the repo already documents keys arriving — Obsidian's sync, rclone, the
// provider's own console — none of which pass through our path validation.
//
// The object below is seeded to *contain* the leaf, so the reference check
// cannot be what refuses it and only the `.md` check can.
await contextStore.put(
  "1-projects/portable/notes.csv",
  `filename,key\nshot.png,.images/${TEAM_IMAGE}\n`
);
const nonMarkdownNote = await call("priv-token", "read_image", {
  note: "1-projects/portable/notes.csv",
  image: `.images/${TEAM_IMAGE}`,
});
check(
  "a non-markdown object cannot stand in for the note, even holding the leaf",
  refusalText(nonMarkdownNote) === REFUSAL
);
const teamReachingIntoPrivate = await call("team-token", "read_image", {
  note: "1-projects/secret-thing/with-image.md",
  image: `.images/${PRIVATE_IMAGE}`,
});
check(
  "a note the caller cannot see resolves nothing",
  refusalText(teamReachingIntoPrivate) === REFUSAL
);

/**
 * **The exact-note override, which every other fixture here is uniform against.**
 *
 * `teamReachingIntoPrivate` above is private by its FOLDER — `secret-thing` is
 * a `folder_defaults` entry — and so is every other private note in this
 * suite's manifest, whose `note_overrides` block is seeded empty. That
 * uniformity is the axis `toolReadImage`'s single `canSee(notePath, …)` was
 * unpinned along, and it was found by measurement rather than by reading:
 * replacing that call with a probe of the note's FOLDER left every check in
 * this file passing.
 *
 * It would not be an idle refactor to make. `visibleIndex` in
 * `src/search/query.js` calls `canSee` "the expensive thing in this function",
 * which is an invitation to cache it per folder — and
 * `effectiveVisibility(key, rules, overrides)` is
 * `overrides?.get(key) || visibilityOf(key, rules)`, keyed on the note's OWN
 * path. A folder probe therefore never sees an override, and a team connection
 * would read every image referenced by a note its owner had deliberately made
 * private inside a shared folder — the exception mechanism, which is the whole
 * point of having one.
 *
 * The note below lives in `1-projects/portable`, a team folder, and is narrowed
 * by `set_visibility` rather than by the manifest. The team read BEFORE the
 * narrowing is the positive control: without it a note that was never readable
 * would satisfy the assertion after.
 */
const OVERRIDE_IMAGE = `${"9".repeat(64)}.png`;
await contextStore.put(`.images/${OVERRIDE_IMAGE}`, PNG_BYTES);
const overridePath = "1-projects/portable/override-image.md";
await contextStore.put(
  overridePath,
  `# team note, for now\n\n![a screenshot](.images/${OVERRIDE_IMAGE})\n`
);
check(
  "the positive control: a team folder's note resolves its image for a team caller",
  (await call("team-token", "read_image", {
    note: overridePath,
    image: `.images/${OVERRIDE_IMAGE}`,
  })).content?.find((block) => block.type === "image")?.data === PNG_BASE64
);
const overrideEtag = (await call("priv-token", "read_note", { path: overridePath }))
  ?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
const narrowedByOverride = await call("priv-token", "set_visibility", {
  path: overridePath,
  visibility: "private",
  expected_etag: overrideEtag,
});
check(
  "the narrowing itself succeeded, so the assertion below is about visibility",
  !narrowedByOverride.isError &&
    (await call("team-token", "read_note", { path: overridePath }))?.isError === true
);
const teamReachingIntoOverride = await call("team-token", "read_image", {
  note: overridePath,
  image: `.images/${OVERRIDE_IMAGE}`,
});
check(
  "a note made private by exact-note override resolves no image for a team caller",
  refusalText(teamReachingIntoOverride) === REFUSAL
);
/**
 * **The same override, re-cased — because one shipped backend folds case.**
 *
 * Every privacy decision in this gateway is keyed on an exact path string.
 * `effectiveVisibility` is `overrides?.get(key) || visibilityOf(key, rules)`,
 * an exact `Map.get`; `isPlumbing` opens with `key === PRIVACY_KEY`. Both are
 * sound on a keyspace where one string is one object, which is what R2 and S3
 * are — and `DropboxStore` is not. Its own header says so, in the list of
 * things that make Dropbox not a keyspace:
 *
 *   > **Case-insensitive, Unicode-folding paths.** Dropbox treats `Foo.md` and
 *   > `foo.md` as the same file and normalises Unicode. Nothing here tries to
 *   > paper over that: the keys this product writes are already normalised …
 *
 * The keys *this product* writes are. The keys a **caller** supplies are not,
 * and `write_note`, `read_note`, `move_note` and `propose_note` all take a
 * path straight from the connected AI client. So on a Dropbox-backed context
 * two different strings name one file while the privacy engine scores them as
 * two different notes, and the score that matters is the one the attacker
 * picks:
 *
 *  - `Privacy.md` is not `privacy.md`, so `isPlumbing` does not reserve it —
 *    and Dropbox writes it to the manifest anyway. That is `write_note`
 *    rewriting the file that decides what every team connection may read,
 *    through the one path the tool answers "that path is reserved" for.
 *  - `1-projects/portable/Override-Image.md` misses the override Map, but the
 *    FOLDER rule `1-projects: team` still matches — folder matching is a
 *    prefix compare that the re-casing above leaves untouched. So the note
 *    scores `team`, and Dropbox hands back the private file.
 *
 * The direction is what makes this a hole rather than a wobble. Re-casing a
 * *folder* makes every rule miss and `visibilityOf` falls back to `private`,
 * which fails closed. Re-casing a *note* leaves the folder rule matching and
 * drops only the narrowing override, which fails open — the exception
 * mechanism, again, and the same one the fixture above exists for.
 *
 * These assertions are about the DECISION, not about Dropbox: this suite's
 * store stub is case-sensitive, so the twin below is a genuinely different
 * object here and refusing it is the fail-closed cost of the fix rather than
 * the vulnerability itself. That cost is the point. A privacy answer that
 * depends on which backend is underneath is an answer nobody can check, so the
 * engine gives the restrictive one everywhere and the adapter is left alone —
 * which is also what `DropboxStore` asks for when it says a store that
 * silently re-cased a caller's key would be worse than one that does not.
 */
const recasedManifest = await call("priv-token", "write_note", {
  path: "Privacy.md",
  content: "default_visibility: team\n",
});
check(
  "the privacy manifest is reserved under any casing",
  recasedManifest.isError === true && /reserved/.test(recasedManifest.content?.[0]?.text ?? "")
);

const recasedOverridePath = "1-projects/portable/Override-Image.md";
const recasedOverrideWrite = await call("team-token", "write_note", {
  path: recasedOverridePath,
  content: "# written past an override\n",
});
check(
  // Matched on the text, not merely on isError: "some error" is one refactor
  // away from passing because the path stopped existing.
  "a team caller cannot write past an exact-note override by re-casing it",
  recasedOverrideWrite.isError === true &&
    /permission denied: write destination/.test(recasedOverrideWrite.content?.[0]?.text ?? "")
);

await contextStore.put(recasedOverridePath, "# the same file, on a folding backend\n");
const recasedOverrideRead = await call("team-token", "read_note", {
  path: recasedOverridePath,
});
check(
  "a team caller cannot read past an exact-note override by re-casing it",
  recasedOverrideRead.isError === true &&
    (recasedOverrideRead.content?.[0]?.text ?? "") === "not found"
);

check(
  "and the note it could not publish is still refused to a team caller",
  (await call("team-token", "read_note", { path: recasedOverridePath }))?.isError === true
);

/**
 * **The tool nobody had counted.**
 *
 * Three reviews and four commits enumerated the tools that change a visibility
 * and left this one out every time. It is also the only one that fails OPEN
 * rather than closed, which is why its guard is the one piece of that work
 * kept here: without it the fold is a regression rather than a fix.
 *
 * Its compaction loop drops an override that has become redundant *for its own
 * exact path* — correct before the fold, and wrong after it, because the same
 * line is what narrows every path that folds onto it. The impact report walks
 * only `${folder}/`, so a twin living in a differently-cased sibling folder is
 * never scanned: `newly_team_visible_notes` says 0, no publication confirmation
 * is required, and a note the owner had marked private becomes team-readable
 * with nothing said. That is content, not existence — the severe direction.
 *
 * The fold created the coupling, so the fix belongs here: a `private` override
 * is never compacted away, because this loop cannot see who else is relying on
 * it. A redundant private line costs a line of manifest.
 */
const foldFolderA = "fold-folder";
const foldFolderB = "Fold-Folder";
await contextStore.put(`${foldFolderA}/note.md`, "# the note that must stay private\n");
await contextStore.put(`${foldFolderB}/Note.md`, "# its twin, in a folder that folds\n");
// `set_folder_visibility` refuses an apply with no `expected_privacy_etag`, and
// that refusal looks like any other — the first version of this fixture never
// applied at all, so the scenario it describes never existed. Drive it the way
// a real client does: dry run, take the etag, apply.
const setFolder = async (path, visibility) => {
  const preview = await call("priv-token", "set_folder_visibility", {
    path,
    visibility,
    dry_run: true,
  });
  const privacyEtag = preview?.content?.[0]?.text?.match(/privacy_etag: (\S+)/)?.[1];
  return call("priv-token", "set_folder_visibility", {
    path,
    visibility,
    expected_privacy_etag: privacyEtag,
    confirm_team_publish: true,
  });
};
const sharedA = await setFolder(foldFolderA, "team");
const sharedB = await setFolder(foldFolderB, "team");
check(
  "the fixture applied: both folders really are team before the narrowing",
  sharedA?.isError !== true &&
    sharedB?.isError !== true &&
    (await call("team-token", "read_note", { path: `${foldFolderB}/Note.md` }))?.isError !== true
);
const foldNoteEtag = (await call("priv-token", "read_note", { path: `${foldFolderA}/note.md` }))
  ?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
await call("priv-token", "set_visibility", {
  path: `${foldFolderA}/note.md`,
  visibility: "private",
  expected_etag: foldNoteEtag,
});
check(
  "the positive control: the twin is private by fold before the folder changes",
  (await call("team-token", "read_note", { path: `${foldFolderB}/Note.md` }))?.isError === true
);
// Narrowing the FIRST folder makes its own override redundant. Compacting it
// away would publish the twin in the second folder.
const narrowed = await setFolder(foldFolderA, "private");
/**
 * **And the same publish through the most ordinary call there is.**
 *
 * The first guard written for this reasoned over folder rules: a twin is only
 * widened, it said, by a `team` rule governing the folded path but not the
 * exact one — a case-variant folder rule, enumerable in the manifest. That is
 * false, and the counter-example needs no hand-edited manifest at all.
 * `visibilityOf` is longest-prefix; the guard was any-prefix. A single `team`
 * rule governing BOTH the note and its twin, out-ranked for the note by the
 * longer `private` rule *this very call adds*, widens the twin and the guard
 * cannot see it — reached by "make this folder private", which is the last call
 * an owner would audit.
 *
 * So no `private` override is compacted away, full stop. This loop cannot see
 * who is relying on one, and a redundant line costs a line of manifest. The
 * rule-shaped version of this was written, shipped, and found wrong within the
 * hour; reasoning about who a narrowing protects means simulating the write,
 * and a weaker copy of that reasoning is worth less than a redundant line of
 * manifest.
 */
const quietA = "1-projects/quiet/x.md";
const quietTwin = "1-projects/Quiet/x.md";
await contextStore.put(quietA, "# the private one\n");
await contextStore.put(quietTwin, "# a different file that folds onto it\n");
const quietEtag = (await call("priv-token", "read_note", { path: quietA }))
  ?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
await call("priv-token", "set_visibility", {
  path: quietA,
  visibility: "private",
  expected_etag: quietEtag,
});
check(
  "the positive control: the twin is private by fold, under one plain team rule",
  (await call("team-token", "read_note", { path: quietTwin }))?.isError === true
);
const quietNarrow = await setFolder("1-projects/quiet", "private");
check(
  "narrowing a folder does not publish a twin governed by the same team rule",
  quietNarrow?.isError !== true &&
    (await call("team-token", "read_note", { path: quietTwin }))?.isError === true
);
// Folder rule first, then the override — clearing an override means setting it
// to what the note now INHERITS, so doing it in the other order writes a fresh
// override instead of removing one.
await setFolder("1-projects/quiet", "inherit");
await call("priv-token", "set_visibility", {
  path: quietA,
  visibility: "team",
  confirm_team_publish: true,
});
await contextStore.delete(quietA);
await contextStore.delete(quietTwin);

check(
  "narrowing one folder does not publish a note that folds onto it in another",
  narrowed?.isError !== true &&
    (await call("team-token", "read_note", { path: `${foldFolderB}/Note.md` }))?.isError === true
);
/**
 * **The exact delete, which this change made reachable.**
 *
 * `persistExactVisibility` and `clearExactVisibility` delete an override by its
 * exact path — a fold reads across case, it never writes across it. That used
 * to be documented as unreachable defence-in-depth, because six tools refused a
 * folded twin before either could be called, and CLAUDE.md said so: "sabotaging
 * either passes the whole gateway suite". Those refusals came out with the
 * write-path apparatus, and the residual bullet came out with them — so the
 * exact delete is now the only thing standing between `set_visibility` on
 * `Notes.md` and `notes.md` losing the narrowing its owner wrote. Consent taken
 * for one file and spent on another, and it fails OPEN.
 *
 * Both directions are here because they are separate functions: the persist
 * path (a visibility change that lands on the delete branch) and the clear path
 * (the source of a move).
 */
const exactDeleteKeep = "1-projects/portable/keep-narrowing.md";
const exactDeleteTwin = "1-projects/portable/Keep-Narrowing.md";
await contextStore.put(exactDeleteKeep, "# the narrowed original\n");
await contextStore.put(exactDeleteTwin, "# a different file that folds onto it\n");
const keepEtag = (await call("priv-token", "read_note", { path: exactDeleteKeep }))
  ?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
await call("priv-token", "set_visibility", {
  path: exactDeleteKeep,
  visibility: "private",
  expected_etag: keepEtag,
});
check(
  "the positive control: the original is narrowed and its twin reads private too",
  (await call("team-token", "read_note", { path: exactDeleteKeep }))?.isError === true &&
    (await call("team-token", "read_note", { path: exactDeleteTwin }))?.isError === true
);
// persistExactVisibility's delete branch: `Keep-Narrowing.md` inherits team, so
// asking for team takes the delete. It must remove nothing.
await call("priv-token", "set_visibility", {
  path: exactDeleteTwin,
  visibility: "team",
  confirm_team_publish: true,
});
check(
  "changing a case-variant's visibility does not clear the original's narrowing",
  (await (await contextStore.get("privacy.md")).text()).includes(`${exactDeleteKeep}: private`) &&
    (await call("team-token", "read_note", { path: exactDeleteKeep }))?.isError === true
);
// clearExactVisibility, through the source of a move.
const keepMoveEtag = (await call("priv-token", "read_note", { path: exactDeleteTwin }))
  ?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
await call("priv-token", "move_note", {
  source: exactDeleteTwin,
  destination: "1-projects/portable/keep-moved.md",
  expected_source_etag: keepMoveEtag,
});
check(
  "moving a case-variant away does not clear the original's narrowing either",
  (await (await contextStore.get("privacy.md")).text()).includes(`${exactDeleteKeep}: private`) &&
    (await call("team-token", "read_note", { path: exactDeleteKeep }))?.isError === true
);
// Clear the override against what the note inherits, then drop the objects.
await call("priv-token", "set_visibility", {
  path: exactDeleteKeep,
  visibility: "team",
  confirm_team_publish: true,
});
// The move wrote a `private` override at its destination — the folded read is
// what `move_note` persists — so the object is not the only thing to clean up.
// The block's own comment above says exactly this, and this block did it wrong.
await call("priv-token", "set_visibility", {
  path: "1-projects/portable/keep-moved.md",
  visibility: "team",
  confirm_team_publish: true,
});
await contextStore.delete(exactDeleteKeep);
await contextStore.delete("1-projects/portable/keep-moved.md");

/**
 * **The fold's direction, checked in the gateway's own suite.**
 *
 * `overrideFor` folding a `team` override as well as a `private` one is the
 * hole this whole change had in its first version, and it was caught only by
 * `apps/convex/__tests__/privacyEngine.test.ts` — the gateway suite passed with
 * the widening in place. CLAUDE.md calls this suite the fast, offline one a
 * self-hoster runs, and self-hosting is a published commitment: somebody
 * running only `pnpm test` here must be able to see a widening fold in the
 * engine they deploy.
 *
 * It was deleted as collateral when the write-path refusals came out, which it
 * had nothing to do with — it pins the narrowing rule, not a refusal.
 *
 * `2-areas/private` is a private folder. Publishing one note by exact override
 * must not publish its case-variant, which on R2 and S3 is a different file the
 * owner never named.
 */
const widenFoldPath = "2-areas/private/fold-widen.md";
const widenFoldTwin = "2-areas/private/Fold-Widen.md";
await contextStore.put(widenFoldPath, "# deliberately published\n");
await contextStore.put(widenFoldTwin, "# a different file, never named\n");
const widenFoldEtag = (await call("priv-token", "read_note", { path: widenFoldPath }))
  ?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
const widenFoldPublish = await call("priv-token", "set_visibility", {
  path: widenFoldPath,
  visibility: "team",
  expected_etag: widenFoldEtag,
  confirm_team_publish: true,
});
check(
  "the positive control: the note the owner named IS readable by a team caller",
  widenFoldPublish?.isError !== true &&
    (await call("team-token", "read_note", { path: widenFoldPath }))?.isError !== true
);
check(
  "a team override does not travel by re-casing, in the gateway's own suite",
  (await call("team-token", "read_note", { path: widenFoldTwin }))?.isError === true
);
await call("priv-token", "set_visibility", { path: widenFoldPath, visibility: "private" });
await contextStore.delete(widenFoldPath);
await contextStore.delete(widenFoldTwin);

// Put the manifest back too, not just the objects. The first version of this
// block deleted the two notes and left `fold-folder: private`,
// `Fold-Folder: team` and the note override standing in the shared bucket for
// every check after it — eight lines below its own comment saying to clear the
// override before the object.
// An override is cleared by setting the note to what it INHERITS — and
// `set_visibility` short-circuits when the value already matches, so asking for
// `private` while the note already reads private removes nothing. Put the
// folder back to `team` for one call, clear the override against it, then drop
// the rule.
await setFolder(foldFolderB, "inherit");
await setFolder(foldFolderA, "team");
await call("priv-token", "set_visibility", {
  path: `${foldFolderA}/note.md`,
  visibility: "team",
  confirm_team_publish: true,
});
await setFolder(foldFolderA, "inherit");
for (const key of [`${foldFolderA}/note.md`, `${foldFolderB}/Note.md`]) {
  await contextStore.delete(key);
}
await contextStore.delete(recasedOverridePath);

/**
 * **And the other direction, because the fixture above only narrows.**
 *
 * A folder probe that honoured a *narrowing* override and ignored a *widening*
 * one would pass every check to this point — measured, 805 of 805. The axis
 * this file's own new fixture holds constant is the override's direction, and
 * the law it was written to demonstrate applies to it as much as to anything
 * else.
 *
 * `2-areas/private/meetings/inherited-private.md` is already published to
 * `team` by exact override inside a private folder, further up this file, so
 * the case costs an image and a read rather than a new scenario. It fails
 * closed rather than open — a probe that missed it would refuse a read the
 * owner deliberately published — which is why it is a second check here and not
 * the first.
 */
const WIDENED_IMAGE = `${"8".repeat(64)}.png`;
await contextStore.put(`.images/${WIDENED_IMAGE}`, PNG_BYTES);
const widenedPath = "2-areas/private/meetings/widened-image.md";
await contextStore.put(
  widenedPath,
  `# published inside a private folder\n\n![a screenshot](.images/${WIDENED_IMAGE})\n`
);
const widenedEtag = (await call("priv-token", "read_note", { path: widenedPath }))
  ?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
const widenedByOverride = await call("priv-token", "set_visibility", {
  path: widenedPath,
  visibility: "team",
  expected_etag: widenedEtag,
  confirm_team_publish: true,
});
check(
  "the widening itself succeeded, so the assertion below is about visibility",
  !widenedByOverride.isError &&
    !(await call("team-token", "read_note", { path: widenedPath }))?.isError
);
check(
  "a note published by exact-note override inside a private folder resolves its image",
  (await call("team-token", "read_image", {
    note: widenedPath,
    image: `.images/${WIDENED_IMAGE}`,
  })).content?.find((block) => block.type === "image")?.data === PNG_BASE64
);
const missingNote = await call("priv-token", "read_image", {
  note: "1-projects/portable/does-not-exist.md",
  image: `.images/${TEAM_IMAGE}`,
});
check("a note that does not exist resolves nothing", refusalText(missingNote) === REFUSAL);
const missingImage = await call("priv-token", "read_image", {
  note: "1-projects/portable/with-image.md",
  image: `.images/${"f".repeat(64)}.png`,
});
check("an image that does not exist resolves nothing", refusalText(missingImage) === REFUSAL);
check(
  "every image refusal is byte-identical, so nothing can be distinguished",
  new Set([
    refusalText(bareHash),
    refusalText(unreferenced),
    refusalText(orphan),
    refusalText(teamReachingIntoPrivate),
    refusalText(teamReachingIntoOverride),
    refusalText(missingNote),
    refusalText(missingImage),
  ]).size === 1
);

// -- read_image is not a general object reader
//
// The sharpest way this tool could go wrong: it reads bytes by key, and every
// other read path in this gateway is gated on `.md` + canSee. If `image` were
// allowed to name anything, a note saying "privacy.md" would exfiltrate the
// manifest, and "../" would walk out of the store entirely.
//
// Each of these is asked through a note that *does* name the target, so the
// reference check cannot be what refuses them. Without that the checks pass on
// the strength of a different guard and prove nothing about this one — which is
// how they were first written, and sabotaging the key shape did not turn a
// single one red.
const HOSTILE_TARGETS = [
  ["the privacy manifest", "privacy.md"],
  ["a note", "1-projects/secret-thing/status.md"],
  ["a traversal attempt", "../../privacy.md"],
  ["other plumbing", ".history/1-projects/portable/with-image.md"],
  ["a nested path inside the image store", ".images/nested/../../privacy.md"],
];
await contextStore.put(
  "1-projects/portable/hostile-refs.md",
  `# team note\n\n${HOSTILE_TARGETS.map(([, target]) => `![x](${target})`).join("\n")}\n`
);
for (const [label, target] of HOSTILE_TARGETS) {
  const attempt = await call("priv-token", "read_image", {
    note: "1-projects/portable/hostile-refs.md",
    image: target,
  });
  check(`read_image cannot be pointed at ${label}`, refusalText(attempt) === REFUSAL);
}
const scriptObject = await call("priv-token", "read_image", {
  note: "1-projects/portable/with-script.md",
  image: `.images/${SCRIPT_OBJECT}`,
});
check(
  "an object in .images that is not an image type resolves nothing",
  refusalText(scriptObject) === REFUSAL
);

// -- SVG is an image everywhere except here
//
// The check above cannot cover this one, and that is the whole reason it needs
// its own. `.sh` is refused because nothing would call it an image; `.svg` is
// refused *although* it is one. It is a script container — an `<svg>` can carry
// `<script>` and event handlers — and this gateway hands bytes plus a MIME type
// to a client that renders what it is given. `image/svg+xml` in the type map is
// therefore a one-line XSS in whatever displays it.
//
// This was found by sabotage during review: adding `["svg", "image/svg+xml"]`
// to IMAGE_MIME_TYPES turned nothing red across the whole suite, even though
// "SVG is deliberately not storable and not servable" was written down as a
// decision. A decision nothing enforces is a comment.
const SVG_OBJECT = `${"d".repeat(64)}.svg`;
await contextStore.put(
  `.images/${SVG_OBJECT}`,
  new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
);
await contextStore.put(
  "1-projects/portable/with-svg.md",
  `# team note\n\n![a diagram](.images/${SVG_OBJECT})\n`
);
const svgObject = await call("priv-token", "read_image", {
  note: "1-projects/portable/with-svg.md",
  image: `.images/${SVG_OBJECT}`,
});
check("an SVG is never served, however it is referenced", refusalText(svgObject) === REFUSAL);
check(
  "and no response ever claims the SVG media type",
  !JSON.stringify(svgObject).includes("svg+xml")
);

// -- the chunked base64 path, and the inline ceiling
//
// `base64FromBytes` walks the image in 32KB chunks because String.fromCharCode
// cannot be handed a megabyte of arguments. A 13-byte fixture never reaches the
// second chunk, so it cannot tell a correct loop from an off-by-one one: this
// image crosses the boundary and carries every byte value, so a truncating or
// overlapping chunk changes the base64 and the check goes red.
const BIG_IMAGE = `${"1".repeat(64)}.jpg`;
const BIG_BYTES = new Uint8Array(70_000);
for (let i = 0; i < BIG_BYTES.length; i += 1) BIG_BYTES[i] = (i * 31 + 7) % 256;
await contextStore.put(`.images/${BIG_IMAGE}`, BIG_BYTES);
await contextStore.put(
  "1-projects/portable/big-image.md",
  `# team note\n\n![big](.images/${BIG_IMAGE})\n`
);
const bigImage = await call("priv-token", "read_image", {
  note: "1-projects/portable/big-image.md",
  image: `.images/${BIG_IMAGE}`,
});
check(
  "an image larger than one base64 chunk round-trips byte for byte",
  bigImage.content?.find((block) => block.type === "image")?.data ===
    Buffer.from(BIG_BYTES).toString("base64")
);
check(
  "the mime type follows the extension, not a guess",
  bigImage.content?.find((block) => block.type === "image")?.mimeType === "image/jpeg"
);

// The one refusal that is allowed to say what it is. Reaching it already proves
// the caller can see a note referencing the image, so there is nothing left to
// conceal — and a silent "not found" here would send someone hunting for a
// missing object that is present and merely too big.
const HUGE_IMAGE = `${"2".repeat(64)}.png`;
await contextStore.put(`.images/${HUGE_IMAGE}`, new Uint8Array(5_000_001));
await contextStore.put(
  "1-projects/portable/huge-image.md",
  `# team note\n\n![huge](.images/${HUGE_IMAGE})\n`
);
const hugeImage = await call("priv-token", "read_image", {
  note: "1-projects/portable/huge-image.md",
  image: `.images/${HUGE_IMAGE}`,
});
check(
  "an oversized image is refused by size, and says so rather than hiding",
  hugeImage.isError === true && hugeImage.content[0].text.includes("too large")
);
check(
  "...but a caller who cannot see the note still only gets not found",
  refusalText(
    await call("team-token", "read_image", {
      note: "1-projects/secret-thing/with-image.md",
      image: `.images/${PRIVATE_IMAGE}`,
    })
  ) === REFUSAL
);

// The image store is flat. A nested key inside it is not addressable, so the
// leaf can never be a path — the check that stops `.images/a/b.png` is the same
// one that stops `.images/../../privacy.md` once the traversal filter is gone.
await contextStore.put(`.images/nested/${TEAM_IMAGE}`, PNG_BYTES);
await contextStore.put(
  "1-projects/portable/nested-ref.md",
  `# team note\n\n![nested](.images/nested/${TEAM_IMAGE})\n`
);
check(
  "a nested key inside the image store is not addressable",
  refusalText(
    await call("priv-token", "read_image", {
      note: "1-projects/portable/nested-ref.md",
      image: `.images/nested/${TEAM_IMAGE}`,
    })
  ) === REFUSAL
);

// -- derived visibility, stated out loud
//
// An image has no visibility of its own; it borrows the visibility of whatever
// note reaches it. So one image referenced by both a private note and a team
// note is reachable by the team connection — through the team note, and only
// through it. That is correct (the team note has to display it) and it is the
// single most surprising consequence of the design, which is why it is a named
// check rather than a footnote.
const teamViaTeamNote = await call("team-token", "read_image", {
  note: "1-projects/portable/shared-image.md",
  image: `.images/${SHARED_IMAGE}`,
});
check(
  "an image referenced by both a private and a team note is team-reachable via the team note",
  !teamViaTeamNote.isError &&
    teamViaTeamNote.content?.find((block) => block.type === "image")?.data === PNG_BASE64
);
check(
  "...and still unreachable through the private note that also references it",
  refusalText(
    await call("team-token", "read_image", {
      note: "1-projects/secret-thing/shared-image.md",
      image: `.images/${SHARED_IMAGE}`,
    })
  ) === REFUSAL
);

// -- the contract with the email worker
//
// The two halves of this feature live in different packages and neither can
// import the other. The worker decides the key and writes the link; the gateway
// decides what it will resolve. If those drift, mail silently produces images
// nothing can fetch — and every test on both sides stays green, because each
// one is right about its own half.
//
// So this asserts the join: a note in exactly the shape
// `renderCaptureNote` emits, resolving through the real tool.
const CAPTURE_IMAGE = `${"9".repeat(64)}.png`;
await contextStore.put(`.images/${CAPTURE_IMAGE}`, PNG_BYTES);
await contextStore.put(
  "1-projects/portable/email-capture.md",
  [
    "---",
    'source: "email"',
    "attachments: 1",
    "---",
    "",
    "## Attachments",
    "",
    // Byte-for-byte the line infra/email-worker/src/note.ts writes.
    `- ![shot.png](.images/${CAPTURE_IMAGE}) — image/png, 1.2 KB`,
    "",
    "_Attachment files came from the same untrusted sender as the text above._",
    "",
  ].join("\n")
);
const fromCapture = await call("priv-token", "read_image", {
  note: "1-projects/portable/email-capture.md",
  image: `.images/${CAPTURE_IMAGE}`,
});
check(
  "an image the email worker stored resolves from the note it wrote",
  !fromCapture.isError &&
    fromCapture.content?.find((block) => block.type === "image")?.data === PNG_BASE64
);
check(
  "...and the capture note itself is still an ordinary readable note",
  !(await call("priv-token", "read_note", { path: "1-projects/portable/email-capture.md" })).isError
);

// -- the store stays opaque
//
// Adding a way in must not have added a way to enumerate. These are the same
// guarantees `isPlumbing` gave before this tool existed, re-asserted after it.
const listedAfterImages = await call("priv-token", "list_notes", {});
check(
  "no image appears in a listing, at any scope",
  !listedAfterImages.content[0].text.includes(".images/")
);
check(
  "an image prefix lists nothing rather than listing the store",
  !(await call("priv-token", "list_notes", { prefix: ".images" })).content[0].text.includes(TEAM_IMAGE)
);
// Searching for the hash *does* match the note that references it, which is
// right. The guarantee is about the store itself: markdown sitting inside
// `.images/` is not note surface and must never be searchable. (Seeded at the
// top of this section, so the listing checks above cover it as well.)
check(
  "search never reaches inside the image store",
  !(await call("priv-token", "search_notes", { query: "IMAGESTOREMARKER" })).content[0].text.includes(
    "IMAGESTOREMARKER"
  )
);
check(
  "read_note still cannot read an image",
  (await call("priv-token", "read_note", { path: `.images/${TEAM_IMAGE}` })).isError === true
);


// -- storage adapters: signing, listing, rootPrefix, capability probe
// The cron checks above replaced globalThis.fetch wholesale to serve an ICS
// feed. Everything below authenticates through the control plane again.
controlPlane.install();
await runStoreChecks(check, {
  // The hostile-backend checks need a real way in; there is only one.
  env,
  ownerToken: accessTokenFor("priv-token"),
});

// -- the binding → store table, and every way it refuses
// Synchronous and network-free: it builds adapters and inspects them, so it
// neither needs nor touches the control plane the checks above installed.
runStoreFactoryChecks(check);

// -- multi-tenancy, OAuth, and the ways both are supposed to fail
//
// Last, and with its own control plane and object store: it swaps
// globalThis.fetch and restores it, so it must not run while the calendar cron
// checks above still own that global.
// Orientation's budgeted walk and fail-soft handshake, against a bucket that
// paginates and delimits honestly. Its own control plane, so it runs beside the
// tenancy suite rather than against the shared fixture.
await runOrientationChecks(check);

// The search index. The two format halves are pure functions over their own
// fixtures and touch no store or control plane, so they run anywhere; the
// integration checks stand up their own instrumented bucket, like orientation,
// because the properties that matter there are store-call counts.
await runSearchIndexerChecks(check);
await runSearchQueryChecks(check);
await runSearchIntegrationChecks(check);
// The sharded index (v2), in the same three layers: the storage half against
// its own instrumented bucket, the query half as pure functions over fixtures,
// and the gateway wired to both through the worker.
await runSearchShardsChecks(check);
await runSearchShardQueryChecks(check);
await runSearchFilterChecks(check);
await runSearchV2IntegrationChecks(check);
// What a search *costs*: the ops it reserves for its own answer, the share of
// the backfill it does while somebody waits, and the round trips it no longer
// serializes.
await runSearchPacingChecks(check);

// The Obsidian plugin compatibility check: the scan as pure functions, the
// inventory against its own bucket stubs, and the phrasing of the report. No
// control plane and no shared fixture, so it runs anywhere in this file.
await runPluginChecks(check);

// Links between notes, and the rewrite that keeps them pointing at what they
// name after a move. Pure rules first, then the four move tools against a
// worker of its own — see the file header for why it does not share this
// fixture.
await runLinkChecks(check);

await runTenancyChecks(check);
await runCrossContextChecks(check);
await runUsageReportingChecks(check);
await runSearchD1Checks(check);
// The copy itself: notes reaching the database fast search provisions. Its own
// control plane, S3 backend and Cloudflare stub, so — like the tenancy suite —
// it swaps globalThis.fetch and restores it, and must not run while anything
// above still owns that global.
await runSearchProjectionChecks(check);

// Meeting ingestion: the routes a phone and a desktop app send a meeting to,
// the one note it becomes, and the neighbour who knows its session id. Its own
// control plane, its own S3 backend and its own fetch layer for failing a
// single write, so — like the tenancy suite — it swaps globalThis.fetch and
// restores it, and must not run while anything above still owns that global.
await runMeetingChecks(check);

console.log(failures ? `\n${failures} FAILURES` : "\nALL PASS");
process.exit(failures ? 1 : 0);
