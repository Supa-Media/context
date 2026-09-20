/**
 * TWO REAL BROWSERS, ONE NOTE, THROUGH THE REAL SOCKET.
 *
 * Every other test in this feature stops short of the thing that has broken
 * three times: the gap between "the suite is green" and "somebody typed". This
 * drives two Chromium contexts against `wrangler dev` running the actual
 * gateway with actual Durable Objects, over actual WebSockets, with the actual
 * sync protocol.
 *
 * It is not part of CI — it needs a local Worker runtime and a browser — so it
 * is run by hand and its results are reported as what they are: a live
 * demonstration, distinct from the unit suites.
 *
 *   node apps/mcp/test/browser/verify.mjs
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { startLocalControlPlane } from "../localControlPlane.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATEWAY = "http://127.0.0.1:8799";
const PAGES = 8798;
const CONTROL = 8797;
const SECRET = "local-verification-secret-not-real";
const NOTE = "1-projects/verify.md";
const ANA = "cat_local_verification_token_ana";
const BO = "cat_local_verification_token_bo";
const READER = "cat_local_verification_token_reader";
const MCP_DIR = join(HERE, "..", "..");
// A bucket of this run's own, thrown away first, so a second run is not a
// different test from the first one.
const STATE = join(MCP_DIR, ".wrangler", "verify-state");

/**
 * The privacy manifest every real context already has.
 *
 * It cannot be written through the gateway — `privacy.md` is a reserved path,
 * deliberately, so no MCP client can rewrite the rules that govern it — and it
 * is created when the workspace is, which is a control-plane step this
 * verification does not run. So it is put into the bucket directly, exactly as
 * onboarding would leave it: default private, and **no folder rule**, so that
 * the rule this verification needs is the one `set_folder_visibility` writes
 * through the product's own path a moment later.
 */
const PRIVACY_MANIFEST = [
  "---",
  "role: privacy-manifest",
  "version: 1",
  "---",
  "",
  "# Privacy Map",
  "",
  "<!-- BEGIN BRAIN PRIVACY RULES -->",
  "",
  "```yaml",
  "default_visibility: private",
  "",
  "folder_defaults:",
  "  # No folder defaults. All content is private.",
  "",
  "note_overrides:",
  "  # No exact-note overrides.",
  "```",
  "",
  "<!-- END BRAIN PRIVACY RULES -->",
  "",
].join("\n");

const results = [];
const check = (label, passed, detail = "") => {
  results.push({ label, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

/** Wait for a condition, because a socket is not synchronous. */
async function until(fn, { timeout = 8000, every = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, every));
  }
}

async function main() {
  const controlPlane = await startLocalControlPlane({
    port: CONTROL,
    gatewaySecret: SECRET,
    bindingName: "LOCAL_BUCKET",
  });

  const pages = createServer((req, res) => {
    if (req.url?.startsWith("/bundle.js")) {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(readFileSync(join(HERE, "bundle.js")));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><meta charset="utf-8"><title>room</title><script src="/bundle.js"></script>`);
  });
  await new Promise((r) => pages.listen(PAGES, "127.0.0.1", r));

  // `npx` is a shell in front of the real runtime: SIGTERM to it leaves workerd
  // holding port 8799, and the next run of this script then silently talks to
  // a stale gateway. Its own process group, killed as a group, is the fix.
  /*
    The page bundle is built here rather than committed.

    It is the product's own client modules — `sharedDoc`, `sync`, `protocol` —
    compiled for a browser, so a committed copy is a second version of code
    that already lives in this repository, and the first time it drifts is the
    first time this verification stops testing what ships.
  */
  const bundled = spawnSync(
    "npx",
    [
      "esbuild",
      join(HERE, "room.js"),
      "--bundle",
      `--outfile=${join(HERE, "bundle.js")}`,
      "--loader:.ts=ts",
      "--format=iife",
    ],
    { cwd: MCP_DIR, encoding: "utf8" },
  );
  if (bundled.status !== 0) {
    console.log("FAIL  the page bundle did not build");
    console.log((bundled.stderr || "").slice(-2000));
    process.exit(1);
  }

  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
  const manifest = join(STATE, "privacy.md");
  writeFileSync(manifest, PRIVACY_MANIFEST);
  const seededManifest = spawnSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      "local-verification/privacy.md",
      "--file",
      manifest,
      "--local",
      "--persist-to",
      STATE,
      "--config",
      "wrangler.local-verify.toml",
    ],
    { cwd: MCP_DIR, encoding: "utf8" },
  );
  if (seededManifest.status !== 0) {
    console.log("FAIL  the bucket could not be given a privacy manifest");
    console.log((seededManifest.stderr || "").slice(-2000));
    process.exit(1);
  }

  const worker = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--config",
      "wrangler.local-verify.toml",
      "--port",
      "8799",
      "--local",
      "--persist-to",
      STATE,
    ],
    { cwd: MCP_DIR, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let workerLog = "";
  const collect = (chunk) => {
    workerLog += chunk;
  };
  worker.stdout.on("data", collect);
  worker.stderr.on("data", collect);
  const stopWorker = () => {
    try {
      process.kill(-worker.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  };
  process.on("exit", stopWorker);

  const up = await until(
    async () => {
      try {
        const res = await fetch(`${GATEWAY}/.well-known/oauth-authorization-server`);
        return res.ok;
      } catch {
        return false;
      }
    },
    { timeout: 60_000 },
  );
  if (!up) {
    console.log("FAIL  the gateway did not start");
    console.log(workerLog.slice(-4000));
    process.exit(1);
  }

  // Playwright is pointed at the preinstalled browsers by PLAYWRIGHT_BROWSERS_PATH,
  // so let it resolve its own binary rather than hard-coding a path that moves
  // with the revision.
  /*
    Seed through the real MCP tools, not by writing into the bucket behind the
    gateway's back.

    Two things have to be true before a socket can open on a note: the note has
    to exist (`handlePresence` lists for it, and answers 404 for a path with
    nothing at it), and the people who are not the owner have to be able to see
    it (they connect at `team` tier, and a folder with no rule defaults to
    private). Both are set here the way a person would set them — `write_note`
    and `set_folder_visibility` over `/t/<token>/mcp` — so the fixture is the
    product's own save path rather than a bucket the test arranged to its own
    liking.
  */
  let rpcId = 0;
  const callTool = async (token, name, args) => {
    const response = await fetch(`${GATEWAY}/t/${token}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const text = await response.text();
    // The transport may answer as SSE; the payload is the same JSON either way.
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const body = JSON.parse(line ? line.slice(6) : text);
    return body.result ?? body;
  };

  const textOf = (result) =>
    (result?.content ?? []).map((part) => part.text ?? "").join("\n");

  const seeded = await callTool(ANA, "write_note", {
    path: NOTE,
    content: "# Verify\n\nfirst line\n",
    summary: "seed the note this verification edits",
  });
  check("the note is created through the real MCP save path", !seeded?.isError, textOf(seeded).slice(0, 120));

  const dryRun = await callTool(ANA, "set_folder_visibility", {
    path: "1-projects",
    visibility: "team",
    dry_run: true,
  });
  const etag = textOf(dryRun).match(/etag[^a-z0-9]*([A-Za-z0-9"._-]+)/i)?.[1]?.replace(/"/g, "");
  const shared = await callTool(ANA, "set_folder_visibility", {
    path: "1-projects",
    visibility: "team",
    expected_privacy_etag: etag,
    confirm_team_publish: true,
  });
  check(
    "the folder is shared with the workspace through the real manifest",
    !shared?.isError,
    textOf(shared).slice(0, 120),
  );

  const browser = await chromium.launch();

  const open = async (token, seedWith) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    // A room that fails to open fails silently otherwise, and the checks below
    // then all read "no". Say why instead.
    page.on("console", (message) => {
      if (message.type() === "error") console.log(`    [browser] ${message.text()}`);
    });
    page.on("pageerror", (error) => console.log(`    [browser] ${error.message}`));
    await page.goto(`http://127.0.0.1:${PAGES}/`);
    await page.evaluate(
      ([gateway, tok, seed]) =>
        window.joinRoom({ gateway, token: tok, note: "1-projects/verify.md", seedWith: seed }),
      [GATEWAY, token, seedWith ?? null],
    );
    return {
      page,
      context,
      text: () => page.evaluate(() => window.room.text()),
      members: () => page.evaluate(() => window.room.members.length),
      connected: () => page.evaluate(() => window.room.connected),
      append: (t) => page.evaluate((x) => window.room.append(x), t),
      type: (at, t) => page.evaluate(([a, x]) => window.room.type(a, x), [at, t]),
      disconnect: () => page.evaluate(() => window.room.disconnect()),
      externalEtag: () => page.evaluate(() => window.room.externalEtag),
      saver: () => page.evaluate(() => window.room.saver()),
    };
  };

  /* ---------------------------------------------------------------- 1 ---- */
  // Ana opens the note with its text already in hand, which is what the console
  // does: `read_note` fills the editor, and the editor seeds the shared
  // document. Bo opens with nothing and must be given the text by the protocol.
  const ana = await open(ANA, "# Verify\n\nfirst line\n");
  await until(() => ana.connected());
  check("a browser opens a room through the real socket", await ana.connected());

  const bo = await open(BO);
  await until(() => bo.connected());
  const gotSeed = await until(async () => (await bo.text()).includes("first line"));
  check(
    "a second browser receives the document over the sync protocol",
    gotSeed,
    JSON.stringify((await bo.text()).slice(0, 40)),
  );

  /* ---------------------------------------------------------------- 2 ---- */
  await ana.append("ana was here\n");
  await bo.append("bo was here\n");
  const converged = await until(async () => {
    const a = await ana.text();
    const b = await bo.text();
    return a === b && a.includes("ana was here") && a.includes("bo was here");
  });
  check("simultaneous edits from both browsers keep both sets of text", converged);

  /* ---------------------------------------------------------------- 3 ---- */
  const late = await open(BO);
  await until(() => late.connected());
  const lateGot = await until(async () => (await late.text()) === (await ana.text()));
  check("a late joiner converges on the same text", lateGot);

  /* ---------------------------------------------------------------- 4 ---- */
  await bo.disconnect();
  await until(async () => !(await bo.connected()));
  await ana.append("written while bo was away\n");
  const reconnected = await open(BO);
  await until(() => reconnected.connected());
  const caughtUp = await until(async () =>
    (await reconnected.text()).includes("written while bo was away"),
  );
  check("a browser that reconnects catches up on what it missed", caughtUp);

  /* ---------------------------------------------------------------- 5 ---- */
  const reader = await open(READER);
  await until(() => reader.connected());
  const readerSees = await until(async () => (await reader.text()).includes("ana was here"));
  check("a read-only member can open the room and see the document", readerSees);

  const before = await ana.text();
  await reader.append("THE READER SHOULD NOT BE ABLE TO WRITE THIS\n");
  // Give a wrong answer time to arrive, so this cannot pass by being too fast.
  await new Promise((r) => setTimeout(r, 2500));
  const after = await ana.text();
  check(
    "a read-only member's edit never reaches anybody else",
    after === before && !after.includes("SHOULD NOT"),
    after === before ? "" : "the reader's text arrived",
  );

  /* ---------------------------------------------------------------- 6 ---- */

  // An MCP client writes the note while three browsers have it open. This is
  // the case the product is for: the agent that saves what a session decided,
  // into a note somebody is reading.
  const agentText = `${await ana.text()}written by an agent, not a browser\n`;
  const agentWrote = await callTool(BO, "write_note", {
    path: NOTE,
    content: agentText,
    summary: "an agent writing a note three people have open",
  });
  const agentEtag = textOf(agentWrote).match(/etag ([a-f0-9]+)/)?.[1] ?? null;
  const sawAgent = await until(async () => {
    const a = await ana.text();
    const b = await reconnected.text();
    return a === b && a.includes("written by an agent");
  });
  check(
    "a write from an MCP client appears live in every browser",
    sawAgent,
    sawAgent ? "" : JSON.stringify((await ana.text()).slice(-60)),
  );

  const merger = await Promise.all([ana, reconnected, late, reader].map((one) => one.externalEtag()));
  check(
    "...merged by exactly one of them, who was told the version it produced",
    // Not every client: the same text applied to four copies of the shared
    // document would insert it four times. And never the read-only member,
    // whose merge the room would refuse.
    merger.filter((etag) => etag !== null).length === 1 &&
      merger[3] === null &&
      merger.some((etag) => etag === agentEtag),
  );

  /* ---------------------------------------------------------------- 7 ---- */

  // The elected saver writes the merged text back, conditionally, at the
  // version the agent left. This is the save path: if the etag had not moved
  // with the agent's write, this is exactly where it would be a conflict.
  const savers = await Promise.all([ana, reconnected, late, reader].map((one) => one.saver()));
  check(
    "exactly one browser is elected to save, and it is not the read-only one",
    savers.filter(Boolean).length === 1 && savers[3] === false,
  );

  const merged = await ana.text();
  const saved = await callTool(ANA, "write_note", {
    path: NOTE,
    content: merged,
    expected_etag: agentEtag,
    summary: "the elected saver flushing the merged document",
  });
  check(
    "the merged document saves over the agent's version without a conflict",
    !saved?.isError,
    textOf(saved).slice(0, 140),
  );

  /* ---------------------------------------------------------------- 8 ---- */

  const reread = await callTool(READER, "read_note", { path: NOTE });
  const inBucket = textOf(reread);
  check(
    "the bucket holds everybody's work: both browsers, the agent, and the seed",
    inBucket.includes("ana was here") &&
      inBucket.includes("bo was here") &&
      inBucket.includes("written while bo was away") &&
      inBucket.includes("written by an agent") &&
      inBucket.includes("first line"),
    inBucket.includes("written by an agent") ? "" : JSON.stringify(inBucket.slice(0, 200)),
  );

  // A browser that reloads is a browser that joins an existing room, so this
  // is the log replay rather than the bucket — but the two now agree, which is
  // the property that matters after a save.
  const reloaded = await open(BO);
  await until(() => reloaded.connected());
  const reloadedText = await until(async () => (await reloaded.text()) === merged);
  check("a reloaded browser lands on the same document", reloadedText);

  await browser.close();
  stopWorker();
  await controlPlane.close();
  await new Promise((r) => pages.close(r));

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} demonstrated in a real browser`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("verification crashed:", error);
  process.exit(1);
});
