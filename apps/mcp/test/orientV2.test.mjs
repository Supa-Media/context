/**
 * `orient` v2: the overview names every workspace the person reaches, each
 * with its own two-level map and first paragraph, read at that workspace's
 * own clearance; and `orient about` gives the rest of the manual on request.
 *
 * What is pinned here, and why:
 *  - a private note in another workspace never reaches a caller who cannot
 *    see it there, by path or by count (the tier is that workspace's, not ours);
 *  - a workspace that will not open is still named, with the honest reason;
 *  - the default answer for four workspaces stays under 12,000 characters.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { surveyOtherContexts, toolOrient } from "../src/orient/tool.js";
import { parsePrivacyManifest } from "../src/privacy/engine.js";
import { withPrivacyAuthority } from "../src/store/privacyAuthority.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "./controlPlaneStub.mjs";
import { createBucket } from "./orientation/fixtures.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { ORIENT_RECENT_LIMIT } from "../src/orient/render.js";

const HOME_TOKEN = `cat_orient_v2_home_${"0".repeat(18)}`;
const MEMBER_TOKEN = `cat_orient_v2_member_${"0".repeat(15)}`;
const EDITOR_TOKEN = `cat_orient_v2_editor_${"0".repeat(15)}`;
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

/** A privacy manifest with the given folder defaults and note overrides. */
function manifest(folders, overrides = {}) {
  const lines = [
    "default_visibility: private",
    "",
    "folder_defaults:",
    ...Object.entries(folders).map(([key, tier]) => `  ${key}: ${tier}`),
    "",
    "note_overrides:",
    ...(Object.keys(overrides).length
      ? Object.entries(overrides).map(([key, tier]) => `  ${key}: ${tier}`)
      : ["  # none"]),
  ];
  return (
    "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
    "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\n" +
    lines.join("\n") +
    "\n```\n\n<!-- END BRAIN PRIVACY RULES -->\n"
  );
}

const HOME_MANIFEST = manifest({ "index.md": "team", "todo.md": "team", "1-projects": "team", "2-areas": "team", "4-archive": "team" });
const STUDIO_MANIFEST = manifest(
  { "index.md": "team", "1-projects": "team", "2-areas": "team", "4-archive": "team" },
  { "1-projects/studio-private.md": "private" }
);
const PARTNERS_MANIFEST = manifest({ "index.md": "team", "1-projects": "team" });

const home = createBucket();
const studio = createBucket();
const partners = createBucket();

const bindingFor = (bindingName) => ({
  provider: "r2-binding",
  bindingName,
  capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
  status: "active",
});

const env = {
  CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  NATIVE_BINDINGS: "V2_HOME_BUCKET,V2_STUDIO_BUCKET,V2_PARTNERS_BUCKET",
  V2_HOME_BUCKET: home,
  V2_STUDIO_BUCKET: studio,
  V2_PARTNERS_BUCKET: partners,
};

let restore;
let controlPlane;

before(async () => {
  controlPlane = createControlPlaneStub();
  restore = controlPlane.install();

  controlPlane.addWorkspace("ws_v2_home", "home-base", bindingFor("V2_HOME_BUCKET"));
  controlPlane.addWorkspace("ws_v2_studio", "studio", bindingFor("V2_STUDIO_BUCKET"), { kind: "shared" });
  controlPlane.addWorkspace("ws_v2_partners", "partners", bindingFor("V2_PARTNERS_BUCKET"), { kind: "shared" });
  // Bound to a bucket this Worker was never allowed: it cannot be opened.
  controlPlane.addWorkspace("ws_v2_broken", "broken", bindingFor("V2_UNLISTED_BUCKET"), { kind: "shared" });
  controlPlane.serveTreesFrom(env);

  home.seed("privacy.md", HOME_MANIFEST, new Date(NOW - HOUR));
  home.seed("index.md", "# Home\n\nThe home base for every personal project.\n\nSECOND-HOME-PARAGRAPH.\n", new Date(NOW));
  home.seed("todo.md", "# Todo\n", new Date(NOW - 2 * HOUR));
  home.seed("1-projects/alpha/about.md", "Alpha is the house renovation.\n", new Date(NOW - 3 * HOUR));
  home.seed("1-projects/alpha/plan.md", "# plan\n", new Date(NOW - 4 * HOUR));
  home.seed("1-projects/beta.md", "# beta\n", new Date(NOW - 5 * HOUR));
  home.seed("1-projects/gamma/d/e/deep.md", "# deep\n", new Date(NOW - 6 * HOUR));
  home.seed("2-areas/people/ana.md", "# Ana\n", new Date(NOW - 7 * HOUR));
  home.seed("4-archive/2018/old.md", "# old\n", new Date(NOW - 8 * HOUR));
  home.seed("4-archive/done.md", "# done\n", new Date(NOW - 9 * HOUR));

  studio.seed("privacy.md", STUDIO_MANIFEST, new Date(NOW - HOUR));
  studio.seed(
    "index.md",
    "# Studio\n\nThe studio's shared projects live here.\n\nSECOND-STUDIO-PARAGRAPH.\n",
    new Date(NOW - HOUR)
  );
  studio.seed("1-projects/launch/about.md", "Launch plan for the spring.\n", new Date(NOW - 2 * HOUR));
  studio.seed("1-projects/launch/plan.md", "# plan\n", new Date(NOW - 2 * HOUR));
  studio.seed("1-projects/launch/sub/deep/x.md", "# x\n", new Date(NOW - 2 * HOUR));
  studio.seed("1-projects/studio-private.md", "# PRIVATE-STUDIO-BODY\n", new Date(NOW - HOUR));
  studio.seed("4-archive/2019/old.md", "# old\n", new Date(NOW - 3 * HOUR));

  partners.seed("privacy.md", PARTNERS_MANIFEST, new Date(NOW - HOUR));
  partners.seed("index.md", "# Partners\n\nPartner notes for the joint work.\n", new Date(NOW - HOUR));
  partners.seed("1-projects/acme.md", "# acme\n", new Date(NOW - HOUR));

  // The owner: private in home, and a member of each shared workspace.
  await controlPlane.addGrant({
    accessToken: HOME_TOKEN,
    workspaceId: "ws_v2_home",
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_orient_v2_home",
    userId: "user_orient_v2_home",
    alsoMemberOf: [
      { workspaceId: "ws_v2_studio", role: "member" },
      { workspaceId: "ws_v2_partners", role: "member" },
      { workspaceId: "ws_v2_broken", role: "member" },
    ],
  });
  // A team-tier caller: no private scope anywhere, an editor in one shared workspace.
  await controlPlane.addGrant({
    accessToken: MEMBER_TOKEN,
    workspaceId: "ws_v2_home",
    role: "member",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_orient_v2_member",
    userId: "user_orient_v2_member",
    alsoMemberOf: [
      { workspaceId: "ws_v2_studio", role: "member" },
      { workspaceId: "ws_v2_partners", role: "editor" },
      { workspaceId: "ws_v2_broken", role: "member" },
    ],
  });
});

// A team-tier editor of home: writes, but only inside home's team folders.
before(async () => {
  await controlPlane.addGrant({
    accessToken: EDITOR_TOKEN,
    workspaceId: "ws_v2_home",
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_orient_v2_editor",
    userId: "user_orient_v2_editor",
  });
});

after(() => {
  restore?.();
});

async function orient(token, args = {}) {
  return await call(token, "orient", args);
}

async function call(token, name, args = {}) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    ctx
  );
  const body = JSON.parse(await response.text());
  await settle();
  return { text: body?.result?.content?.[0]?.text || "", isError: Boolean(body?.result?.isError) };
}

/** The block of one workspace: from its heading to the next `### ` or `## ` heading. */
function blockOf(text, name) {
  const start = text.indexOf(`### ${name} — `);
  if (start === -1) return "";
  const rest = text.slice(start + 4);
  const end = rest.search(/\n##+ /);
  return end === -1 ? rest : rest.slice(0, end);
}

test("no-argument orient names every reachable workspace, the connected one first", async () => {
  const { text, isError } = await orient(HOME_TOKEN);
  assert.equal(isError, false);
  assert.ok(text.startsWith("# Context"));
  const order = ["@home-base", "@studio", "@partners", "@broken"].map((name) => text.indexOf(`### ${name} — `));
  for (const at of order) assert.ok(at > 0, "every workspace has a heading");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in order: connected first, then the rest");
  assert.ok(text.includes("(the one this connection opens by default)"));
});

test("each workspace shows two levels of folders, with counts and the about line, and no deeper", async () => {
  const { text } = await orient(HOME_TOKEN);
  const studioBlock = blockOf(text, "@studio");
  assert.match(studioBlock, /^- 1-projects\/ \(\d+ notes?\)$/m, "the top-level folder with its count");
  assert.match(studioBlock, /^ {2}- 1-projects\/launch\/ \(\d+ notes?\) — Launch plan for the spring\.$/m, "its child, with the about line");
  assert.ok(!studioBlock.includes("1-projects/launch/sub/"), "a third level is not drawn");
  assert.ok(!studioBlock.includes("sub/deep"), "nor anything beneath it");
  assert.match(blockOf(text, "@home-base"), /^ {2}- 1-projects\/gamma\/ \(/m, "a second-level folder in home");
  assert.ok(!blockOf(text, "@home-base").includes("1-projects/gamma/d/"), "home's third level is not drawn");
});

test("archive folders are left out: one line with the count, and no archive folder listed", async () => {
  const { text } = await orient(HOME_TOKEN);
  const homeBlock = blockOf(text, "@home-base");
  assert.ok(homeBlock.includes("Archive: 2 notes"), "home's archive is counted in one line");
  assert.ok(!/^- 4-archive\//m.test(homeBlock) && !/^ {2}- 4-archive\//m.test(homeBlock), "and not drawn");
  assert.ok(!homeBlock.includes("2018"), "nor its subfolders");
  assert.ok(blockOf(text, "@studio").includes("Archive: 1 note"), "every workspace's archive gets the line");
});

test("each workspace's front page is its first paragraph only", async () => {
  const { text } = await orient(HOME_TOKEN);
  assert.ok(text.includes("The home base for every personal project."));
  assert.ok(!text.includes("SECOND-HOME-PARAGRAPH"), "the rest of the front page is not in the overview");
  assert.ok(text.includes("The studio's shared projects live here."));
  assert.ok(!text.includes("SECOND-STUDIO-PARAGRAPH"));
  assert.ok(blockOf(text, "@partners").includes("Partner notes for the joint work."));
});

test("a private note in another workspace is never named to a caller who cannot see it there", async () => {
  // The member reads studio at team: the private note, and its body, are absent.
  const member = await orient(MEMBER_TOKEN);
  assert.ok(!member.text.includes("studio-private"), "neither its path");
  assert.ok(!member.text.includes("PRIVATE-STUDIO-BODY"), "nor its text");
  assert.match(blockOf(member.text, "@studio"), /^\d+ notes visible to this connection\.$/m, "the count is what they can see");
  // The owner's tier in studio is also team: the owner of home is not an owner of studio.
  const owner = await orient(HOME_TOKEN);
  assert.ok(!owner.text.includes("studio-private"));
  assert.ok(!owner.text.includes("PRIVATE-STUDIO-BODY"));
});

test("a workspace that will not open is still named, with the reason", async () => {
  const { text, isError } = await orient(HOME_TOKEN);
  assert.equal(isError, false, "the call succeeds");
  assert.match(text, /### @broken — [^\n]+\nCould not be opened just now; its storage may be disconnected\./);
  assert.ok(text.includes("### @partners"), "and the workspaces after it are not dropped");
});

test("recent activity is the newest notes of the connected workspace, up to the orient limit", async () => {
  const { text } = await orient(HOME_TOKEN);
  const recent = text.split("## Recently updated\n")[1]?.split("\n\n")[0] ?? "";
  const lines = recent.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(lines.length, ORIENT_RECENT_LIMIT, "one line per note, up to the limit");
  assert.ok(lines[0].startsWith("- index.md — "), "newest first");
  assert.ok(!text.includes("## Recently updated\n- 1-projects/gamma"), "the oldest notes are not in it");
});

test("the workspace's own work and its rules are in the answer, and the rules stay last", async () => {
  const { text } = await orient(HOME_TOKEN);
  assert.ok(text.includes("## How to work here"));
  assert.ok(text.indexOf("## Workspaces") < text.indexOf("## How to work here"));
  assert.ok(text.includes('Pass context: "@name" on any call to work in another workspace.'));
  assert.ok(text.includes('orient about: "tools"'), "the tool notice points at the manual");
});

test("about: tools lists the six tools, every action of write, manage and send, and the fetch ids", async () => {
  const { text, isError } = await orient(HOME_TOKEN, { about: "tools" });
  assert.equal(isError, false);
  for (const tool of ["orient", "search", "fetch", "write", "manage", "send"]) {
    assert.ok(text.includes(`- ${tool} — `), `${tool} is listed`);
  }
  assert.ok(text.includes("### write") && text.includes("### manage") && text.includes("### send"));
  for (const action of ["save", "comment", "remember", "propose", "save_session", "move", "move_many", "share_link", "api"]) {
    assert.ok(text.includes(`  - ${action} — `), `${action} is listed`);
  }
  assert.ok(text.includes("## Fetch ids") && text.includes("`meetings:`") && text.includes("`proposals:<id>`"));
  assert.ok(text.includes("`write` takes a note's `path`, `content` and `expected_etag` at the top level"));
});

test("the legacy tools flag reads as about: tools", async () => {
  const legacy = await orient(HOME_TOKEN, { tools: true });
  assert.ok(legacy.text.includes("## Actions"));
});

test("about: an action name gives that action, its carrying tool, and how to call it", async () => {
  const { text, isError } = await orient(HOME_TOKEN, { about: "move" });
  assert.equal(isError, false);
  assert.ok(text.startsWith("# move"));
  assert.ok(text.includes("manage → `move_note`"));
  assert.ok(text.includes('`manage { action: "move", args: {...} }`'));
  assert.ok(text.includes("## `move_note`, whole description"));
});

test("about: a nested action names its own arguments and the note it is about", async () => {
  const { text } = await orient(HOME_TOKEN, { about: "comment" });
  assert.ok(text.includes("write → `write_note`"));
  assert.ok(text.includes('`write { action: "comment", path: "<note>", args: {...} }`'));
  assert.ok(text.includes("Top level: path."));
});

test("about: access says what this connection may write, in full", async () => {
  const owner = await orient(HOME_TOKEN, { about: "access" });
  assert.ok(owner.text.includes("## Write surface"));
  const member = await orient(MEMBER_TOKEN, { about: "access" });
  assert.ok(member.text.includes("## Write surface"));
});

test("about: access names only calls a v2 app can make", async () => {
  for (const token of [HOME_TOKEN, MEMBER_TOKEN]) {
    const { text } = await orient(token, { about: "access" });
    assert.doesNotMatch(text, /\b(write_note|propose_note|scope_info)\b/, text);
  }
  const { text } = await orient(MEMBER_TOKEN, { about: "access" });
  assert.ok(text.includes("use write with action propose"), text);
});

test("a v2 write the gate refuses is told what to call in the six tools' names", async () => {
  const refused = await call(EDITOR_TOKEN, "write", { path: "3-resources/x.md", content: "# x\n" });
  assert.equal(refused.isError, true, refused.text);
  assert.match(refused.text, /^permission denied: /);
  assert.doesNotMatch(refused.text, /\b(propose_note|scope_info)\b/, refused.text);
  assert.ok(refused.text.includes('orient with about: "access"'), refused.text);
  // A note that quotes the older names reads back as written.
  const quoted = "# Old manual\n\nCall scope_info for the authorized write surface or use propose_note for the correct destination.\n";
  home.seed("1-projects/old-manual.md", quoted, new Date(NOW));
  const read = await call(HOME_TOKEN, "fetch", { id: "1-projects/old-manual.md" });
  assert.ok(read.text.includes("Call scope_info for the authorized"), read.text);
  // The same refusal reached by its older name keeps the older names.
  const older = await call(EDITOR_TOKEN, "write_note", { path: "3-resources/x.md", content: "# x\n" });
  assert.ok(older.text.includes("Call scope_info"), older.text);
});

test("about: website gives the guide, and says so where the context has no website folder", async () => {
  const { text } = await orient(HOME_TOKEN, { about: "website" });
  assert.ok(text.includes("## Building this context's website"));
  assert.ok(text.includes("has no website/ folder yet"));
});

test("about: health gives the tidiness score and the search coverage section", async () => {
  const { text, isError } = await orient(HOME_TOKEN, { about: "health" });
  assert.equal(isError, false);
  assert.ok(text.includes("## Chaos score") || text.includes("No score for this workspace yet."));
  assert.ok(!text.includes("## Recently updated"), "health is not the overview");
});

test("an unknown about is an error that lists the values", async () => {
  const { text, isError } = await orient(HOME_TOKEN, { about: "everything" });
  assert.equal(isError, true);
  assert.match(text, /no "about" value "everything"/);
  assert.match(text, /tools, access, website, pages, health, or an action name: save, comment/);
});

test("the default answer for four workspaces stays under 12,000 characters", async () => {
  const { text } = await orient(HOME_TOKEN);
  console.log(`orient default answer, four workspaces: ${text.length} characters`);
  assert.ok(text.length < 12_000, `${text.length} characters`);
});

/* -------------------------------------------------------------------------- */
/* Other workspaces, below the worker.                                         */
/* -------------------------------------------------------------------------- */

/**
 * A workspace's access rows as `openContext` serves them for a store it builds: the rows
 * `PARTNERS_MANIFEST` describes (index.md and 1-projects are team, the rest private).
 */
const PARTNERS_ROWS = {
  etag: "rows-partners-v1",
  accessVersion: 1,
  folders: [
    { prefix: "index.md", visibility: "team" },
    { prefix: "1-projects", visibility: "team" },
  ],
  notes: [],
};

/** A store for one workspace, with its tree answering through `treeManifest`. */
function memoryWorkspace(files) {
  const keys = Object.keys(files).sort();
  const uploaded = new Date("2026-08-01T10:00:00.000Z");
  return {
    get: async (key) => (key in files ? { etag: `e-${key}`, text: async () => files[key] } : null),
    treeManifest: async ({ folder } = {}) => ({
      served: true,
      entries: keys
        .filter((key) => folder === undefined || key.startsWith(`${folder}/`))
        .map((path) => ({ path, etag: `e-${path}`, updatedAt: uploaded.valueOf() })),
      cursor: null,
    }),
    treeEntries: async () => keys.map((key) => ({ key, uploaded })),
  };
}

test("every other workspace is rendered or named, the one that will not open with its reason", async () => {
  const rules = parsePrivacyManifest(HOME_MANIFEST);
  const here = memoryWorkspace({
    "privacy.md": HOME_MANIFEST,
    "index.md": "# Here\n\nThe connected front page.\n",
    "1-projects/x.md": "# x\n",
  });
  const sibling = (workspaceId, files) => ({
    session: { scope: "team", workspaceId },
    store: withPrivacyAuthority(memoryWorkspace(files), { rules: PARTNERS_ROWS }),
  });
  const store = {
    ...here,
    contexts: [
      { name: "@here", current: true, role: "owner", canWrite: true, grantWrites: true, tier: "private" },
      { name: "@one", role: "member", canWrite: true, grantWrites: true, tier: "team" },
      { name: "@two", role: "member", canWrite: false, grantWrites: false, tier: "team" },
      { name: "@shut", role: "member", canWrite: false, grantWrites: false, tier: "team" },
      { name: "@empty", role: "member", canWrite: false, grantWrites: false, tier: "team" },
    ],
    openContext: async (name) => {
      if (name === "@one") return sibling("ws_one", { "index.md": "# One\n\nA paragraph of One.\n" });
      if (name === "@two") return sibling("ws_two", { "1-projects/two.md": "# two\n" });
      if (name === "@empty") return { session: { scope: "team", workspaceId: "ws_empty" }, store: withPrivacyAuthority(memoryWorkspace({}), { rules: PARTNERS_ROWS }) };
      throw new Error("storage disconnected");
    },
  };

  // Team scope: the private-only parts (proposals, the owner's index) are not what this checks.
  const result = await toolOrient(store, "team", rules.rules, rules.overrides);
  const text = result.content[0].text;
  assert.ok(text.includes("A paragraph of One."), "@one's text is in the answer");
  assert.ok(text.includes("two.md") || text.includes("1-projects/"), "@two's structure is in the answer");
  assert.ok(text.includes("Could not be opened just now"), "@shut is named");
});

test("surveyOtherContexts renders what opens and names what does not", async () => {
  const store = {
    contexts: [
      { name: "@here", current: true },
      { name: "@one", role: "member", canWrite: true, grantWrites: true, tier: "team" },
      { name: "@shut", role: "member", canWrite: false, grantWrites: false, tier: "team" },
    ],
  };
  const openContext = async (name) => {
    if (name === "@one") {
      return { session: { scope: "team", workspaceId: "ws_one" }, store: withPrivacyAuthority(memoryWorkspace({ "index.md": "# One\n" }), { rules: PARTNERS_ROWS }) };
    }
    throw new Error("storage disconnected");
  };
  const { section } = await surveyOtherContexts(store, openContext);
  assert.ok(section.includes("### @one"));
  assert.ok(section.includes("Could not be opened just now"));
});

test("the manual names a manage action's path among its args, and upload's files", async () => {
  const { toolsManual } = await import("../src/orient/manual.js");
  const manual = await toolsManual({}, "private");
  const line = (name) => manual.split("\n").find((l, i, all) => all[i - 1]?.includes(`- ${name} —`));
  assert.match(line("archive"), /args: path\*: string/);
  assert.match(line("visibility"), /path\*: string/);
  assert.match(line("encrypt"), /path\*: string/);
  assert.match(line("upload"), /files\*: \{name\*, sha256\*, bytes\*\}\[\]/);
  // An action that does not take content says nothing of content.
  assert.doesNotMatch(line("answer"), /content/);
});
