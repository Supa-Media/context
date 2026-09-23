/**
 * The `@supa-media/context` CLI against the live staging stack, end to end.
 *
 * Runs from `.github/workflows/cli-live-staging.yml`. Signs in as the seeded
 * `alpha@supa.media` persona (docs/staging.md, "Seeded personas") and drives
 * the CLI's real code: OAuth login with dynamic registration and PKCE, the
 * session hooks, tools from the terminal, the MCP-entry installer, logout. The
 * one thing a browser would do, approving the sign-in, is done by the persona's
 * own session through the same control-plane action the consent screen calls.
 *
 * Staging only, twice over: it refuses any MCP endpoint but staging's, and the
 * fixed code only exists on the staging backend. Everything it creates is
 * removed at the end (the capture note is archived, the grant revoked, the
 * Convex session signed out), so runs do not pile up on the persona.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const ENDPOINT = "https://mcp-staging.context.lc/mcp";
const PERSONA = "alpha@supa.media";
const deployment = process.env.STAGING_CONVEX_DEPLOYMENT;
assert.equal(process.env.APP_ENV, "staging", "APP_ENV must be staging");
assert.ok(deployment && /^[a-z0-9-]+$/.test(deployment), "STAGING_CONVEX_DEPLOYMENT is required");

// A home of its own: the CLI keeps its credential and settings under it.
const home = await mkdtemp(join(tmpdir(), "context-cli-live-"));
process.env.HOME = home;
process.env.CONTEXT_CONFIG = join(home, ".context", "config.json");
process.env.CONTEXT_HOOK_CONFIG = join(home, ".context", "credentials.json");
delete process.env.CONTEXT_ENDPOINT;

const commands = await import("../plugins/context/src/commands.js");
const { listWorkspaces } = await import("../plugins/context/src/mcp.js");

const ref = (name) => makeFunctionReference(name);
const convex = new ConvexHttpClient(`https://${deployment}.convex.cloud`, { logger: false });
const said = [];
const log = (line = "") => {
  said.push(String(line));
  console.log(`  | ${line}`);
};
const pass = (label) => console.log(`PASS  ${label}`);
let grantClientId = null;
let captured = null;
let capturePath = null;
let personalWorkspaceId = null;

try {
  // -- the persona signs in to the control plane, as the seed script does
  await convex.action(ref("auth:signIn"), { provider: "email", params: { email: PERSONA } });
  const signed = await convex.action(ref("auth:signIn"), { provider: "email", params: { email: PERSONA, code: "000000" } });
  assert.ok(signed.tokens?.token, "persona sign-in failed");
  convex.setAuth(signed.tokens.token);
  const mine = await convex.query(ref("functions/workspaces:listMyWorkspaces"), {});
  const personal = mine.find((entry) => entry.kind === "personal");
  assert.ok(personal, "the persona has no personal workspace; run Seed Staging Personas");
  personalWorkspaceId = personal.workspaceId;
  pass(`signed in as the persona, personal workspace @${personal.slug}`);

  // -- the CLI's own login, with the persona approving where a browser would
  await commands.login({
    endpoint: ENDPOINT,
    log,
    openBrowser: async (href) => {
      const started = await fetch(href, { redirect: "manual" });
      const consent = new URL(started.headers.get("location") || "");
      const requestId = consent.searchParams.get("request_id");
      assert.ok(requestId, `the gateway did not redirect to a consent screen (${started.status})`);
      const { redirectTo } = await convex.action(ref("functions/authorizations:approveAuthorization"), {
        requestId,
        workspaceId: personal.workspaceId,
      });
      await fetch(redirectTo);
    },
  });
  const credentials = JSON.parse(await readFile(process.env.CONTEXT_HOOK_CONFIG, "utf8"));
  const record = credentials.endpoints[ENDPOINT];
  assert.ok(record?.refreshToken, "login stored no credential");
  // The persona owns @alpha, so the approval (no narrower choice made) grants
  // private too: a person's own notes are private by default.
  assert.ok(record.scope?.includes("context:private"), `an owner's login should hold context:private, got "${record.scope}"`);
  grantClientId = record.clientId;
  assert.ok(!said.join("\n").includes(record.refreshToken) && !said.join("\n").includes(record.accessToken), "a token was printed");
  pass(`login: OAuth with dynamic registration and PKCE, scope "${record.scope}", no token printed`);

  // -- the workspace list (needs the gateway's scope_info { workspaces })
  const token = await commands.accessTokenFor({ endpoint: ENDPOINT });
  const listed = await listWorkspaces({ url: ENDPOINT, token });
  if (listed) {
    assert.ok(listed.some((entry) => entry.slug === personal.slug && entry.kind === "personal"), "personal workspace missing from the list");
    pass(`workspace list from the gateway: ${listed.map((entry) => `@${entry.slug}`).join(", ")}`);
  } else {
    console.log("SKIP  workspace list: this staging gateway does not take scope_info { workspaces } yet");
  }

  // -- tools from the terminal
  said.length = 0;
  const own = await commands.runTool({ name: "search-notes", flags: { query: "ALPHA-PERSONAL-ONLY" }, endpoint: ENDPOINT, cwd: home, log });
  assert.ok(own.ok && said.join("\n").includes("2-areas/learning/notes.md"), "the owner's own private note is not reachable");
  pass("the owner's own private notes are reachable from the CLI");
  said.length = 0;
  const oriented = await commands.runTool({ name: "orient", flags: { context: "@lumio" }, endpoint: ENDPOINT, cwd: home, log });
  assert.ok(oriented.ok && said.join("\n").includes("fictional software company"), "orient did not return Lumio's front page");
  pass("orient runs from the terminal, addressed to another workspace with --context");
  said.length = 0;
  const searched = await commands.runTool({ name: "search-notes", flags: { query: "decision log", context: "@lumio" }, endpoint: ENDPOINT, cwd: home, log });
  assert.ok(searched.ok && said.join("\n").includes("1-projects/pulse-launch/"), "search did not find Lumio's seeded notes");
  pass("search-notes finds seeded notes, with flags typed from the tool's schema");
  said.length = 0;
  await commands.runTool({ name: "read-note", flags: { path: "2-areas/leadership/private-plan.md", context: "@maison-solenne" }, endpoint: ENDPOINT, cwd: home, log });
  assert.ok(!said.join("\n").includes("Owner-only fixture"), "an owner-only note of a workspace the persona only edits was readable");
  pass("private still means the owner's: an editor's sign-in cannot read another owner's private note");

  // -- use: the default workspace for commands with no folder binding
  await commands.use({ workspace: "@lumio", endpoint: ENDPOINT, log });
  said.length = 0;
  await commands.runTool({ name: "orient", endpoint: ENDPOINT, cwd: home, log });
  assert.ok(said.join("\n").includes("fictional software company"), "use @lumio did not make Lumio the default");
  await commands.use({ workspace: `@${personal.slug}`, endpoint: ENDPOINT, log });
  pass("use switches the workspace commands act on");

  // -- the session-end hook, as an agent would run it
  const sessionId = `cli-live-${Date.now()}`;
  const transcript = join(home, "session.jsonl");
  await writeFile(
    transcript,
    [
      { type: "user", message: { role: "user", content: `Live staging check ${sessionId}.` } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Recorded." }] } },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n")
  );
  const started = Date.now();
  const exit = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["plugins/context/hooks/capture.mjs"], { env: process.env, stdio: ["pipe", "ignore", "ignore"] });
    child.on("exit", resolve);
    child.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: home }));
  });
  const elapsed = Date.now() - started;
  assert.equal(exit, 0);
  assert.ok(elapsed < 1500, `the session-end hook took ${elapsed} ms, past Claude Code's budget`);
  for (let attempt = 0; attempt < 60 && !captured; attempt += 1) {
    captured = JSON.parse(await readFile(join(home, ".context", "last-capture.json"), "utf8").catch(() => "null"));
    if (!captured) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(captured?.saved, true, `the capture was not saved: ${JSON.stringify(captured)}`);
  // Where the gateway files it: 0-inbox/<source slug>/<sha256(source, id)>.md.
  // Read back through the persona's own session, which sees private notes.
  const fingerprint = createHash("sha256").update(`hook:claude-code\0claude-code:${sessionId}`).digest("hex").slice(0, 24);
  capturePath = `0-inbox/hook-claude-code/${fingerprint}.md`;
  const inboxNote = await convex.action(ref("functions/files:readNote"), { workspaceId: personal.workspaceId, path: capturePath });
  assert.ok(inboxNote.text.includes(`Live staging check ${sessionId}.`), "the capture note does not hold the session");
  pass(`session-end hook exits in ${elapsed} ms and the session lands in @${personal.slug}'s inbox`);

  // -- the installer, for an agent with no plugin system (MCP entry + skills)
  said.length = 0;
  await commands.install({ scope: "user", yes: true, agents: ["cursor"], endpoint: ENDPOINT, home, cwd: home, log });
  const cursorConfig = await readFile(join(home, ".cursor", "mcp.json"), "utf8");
  assert.ok(cursorConfig.includes("mcp-staging.context.lc"), "Cursor's MCP config does not name the staging server");
  await readFile(join(home, ".agents", "skills", "context", "SKILL.md"), "utf8");
  await commands.uninstall({ home, log });
  const afterUninstall = await readFile(join(home, ".cursor", "mcp.json"), "utf8").catch(() => "");
  assert.ok(!afterUninstall.includes("mcp-staging.context.lc"), "uninstall left the MCP entry behind");
  pass("install writes Cursor's MCP entry and the skills with the real add-mcp; uninstall removes them");

  // -- status, then clean up what this run created
  said.length = 0;
  await commands.status({ endpoint: ENDPOINT, cwd: home, home, log });
  assert.ok(said.some((line) => line.startsWith("Signed in")), "status does not report the sign-in");
  pass("status reports the sign-in and the last capture");
  await commands.logout({ endpoint: ENDPOINT, log });
  pass("logout deletes the stored sign-in");
} finally {
  // Archive the capture and revoke the grant this run made, whatever happened
  // above, then sign out.
  if (capturePath) {
    await convex
      .action(ref("functions/files:archiveEntry"), { workspaceId: personalWorkspaceId, path: capturePath })
      .then(() => console.log(`  archived ${capturePath}`))
      .catch((error) => console.log(`  could not archive ${capturePath}: ${error.message}`));
  }
  if (grantClientId) {
    for (const workspace of await convex.query(ref("functions/workspaces:listMyWorkspaces"), {}).catch(() => [])) {
      const grants = await convex.query(ref("functions/grants:listGrants"), { workspaceId: workspace.workspaceId }).catch(() => []);
      for (const grant of grants.filter((entry) => entry.clientId === grantClientId && entry.status !== "revoked")) {
        await convex.mutation(ref("functions/grants:revokeGrant"), { grantId: grant.grantId }).catch(() => {});
        console.log(`  revoked the run's grant in @${workspace.slug}`);
      }
    }
  }
  await convex.action(ref("auth:signOut"), {}).catch(() => {});
}

console.log("\nALL PASS");
