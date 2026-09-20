/**
 * TWO REAL BROWSERS, ONE CANVAS, THROUGH THE REAL SOCKET.
 *
 * The companion to `verify.mjs`, for the half that merges by element rather
 * than by character. Two Chromium contexts each load **the real drawing
 * editor** — the built artifact, Excalidraw and all — against `wrangler dev`
 * running the real gateway with real Durable Objects, and draw on it with real
 * mouse and keyboard.
 *
 * The shapes are made by dragging, not by injecting elements: the thing being
 * verified is that somebody drawing a rectangle in one window makes it appear
 * in another, and an element posted into the page's API would skip most of
 * what could be wrong between those two sentences.
 *
 * Not part of CI — it needs a Worker runtime, a browser, and the editor built.
 *
 *   node scripts/build-drawing-editor.mjs
 *   node apps/mcp/test/browser/verifyDrawing.mjs
 */

import { chromium } from "playwright";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { startLocalControlPlane } from "../localControlPlane.mjs";
import {
  decompressFromBase64,
  newDrawing,
  parseDrawing,
  serializeDrawing,
} from "../../../../packages/drawings/src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = join(HERE, "..", "..");
const EDITOR = join(MCP_DIR, "..", "mobile", "public", "drawing-assets");
const STATE = join(MCP_DIR, ".wrangler", "verify-drawing-state");
const GATEWAY = "http://127.0.0.1:8799";
const PAGES = 8798;
const CONTROL = 8797;
const SECRET = "local-verification-secret-not-real";
const NOTE = "1-projects/verify.excalidraw.md";
const ANA = "cat_local_verification_token_ana";
const BO = "cat_local_verification_token_bo";
const READER = "cat_local_verification_token_reader";

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

async function until(fn, { timeout = 15000, every = 150 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, every));
  }
}

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function main() {
  if (!existsSync(join(EDITOR, "editor", "index.html"))) {
    console.log("FAIL  the drawing editor is not built — run `node scripts/build-drawing-editor.mjs`");
    process.exit(1);
  }

  const bundled = spawnSync(
    "npx",
    [
      "esbuild",
      join(HERE, "canvas.js"),
      "--bundle",
      `--outfile=${join(HERE, "canvasBundle.js")}`,
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

  const controlPlane = await startLocalControlPlane({
    port: CONTROL,
    gatewaySecret: SECRET,
    bindingName: "LOCAL_BUCKET",
  });

  /*
    The editor is served from the same origin as the host page, which is not an
    incidental convenience: the bridge refuses a message whose origin is not
    the page that embedded it, and serving the editor elsewhere would be
    verifying a configuration the product does not ship.
  */
  const pages = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path.startsWith("/drawing-assets/")) {
      const file = join(EDITOR, path.slice("/drawing-assets/".length));
      if (!existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
      return;
    }
    if (path === "/canvasBundle.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(readFileSync(join(HERE, "canvasBundle.js")));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>canvas</title>` +
        `<style>html,body{margin:0;height:100%}</style>` +
        `<script src="/canvasBundle.js"></script>`,
    );
  });
  await new Promise((r) => pages.listen(PAGES, "127.0.0.1", r));

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
  worker.stdout.on("data", (c) => (workerLog += c));
  worker.stderr.on("data", (c) => (workerLog += c));
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
        return (await fetch(`${GATEWAY}/.well-known/oauth-authorization-server`)).ok;
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

  let rpcId = 0;
  const callTool = async (token, name, args) => {
    const response = await fetch(`${GATEWAY}/t/${token}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await response.text();
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    const body = JSON.parse(line ? line.slice(6) : text);
    return body.result ?? body;
  };
  const textOf = (result) => (result?.content ?? []).map((part) => part.text ?? "").join("\n");

  /*
    A real `.excalidraw.md` — a scaffold with one rectangle spliced into it by
    the product's own serializer, and a fake attachment in `files` so "the
    attachments survive" is a thing this can actually check rather than assert.
  */
  const seededElements = [
    {
      id: "seed-rect",
      type: "rectangle",
      x: -260,
      y: -180,
      width: 120,
      height: 80,
      version: 1,
      versionNonce: 101,
      seed: 1,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      boundElements: [],
      updated: 1,
      link: null,
      locked: false,
      isDeleted: false,
      index: "a0",
    },
  ];
  const ATTACHMENT = {
    "file-id-kept": {
      mimeType: "image/png",
      id: "file-id-kept",
      dataURL: "data:image/png;base64,iVBORw0KGgo=",
      created: 1,
    },
  };
  const body = serializeDrawing(newDrawing(), seededElements, { files: ATTACHMENT });
  if (body === null) {
    console.log("FAIL  the fixture drawing could not be serialized");
    process.exit(1);
  }

  const seeded = await callTool(ANA, "write_note", {
    path: NOTE,
    content: body,
    summary: "seed the drawing this verification edits",
  });
  check("a drawing is created through the real MCP save path", !seeded?.isError, textOf(seeded).slice(0, 120));

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
  check("the folder is shared with the workspace", !shared?.isError, textOf(shared).slice(0, 100));

  const browser = await chromium.launch();

  const open = async (token, { seed = [], editable = true } = {}) => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => console.log(`    [browser] ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") console.log(`    [console] ${message.text().slice(0, 300)}`);
    });
    await page.goto(`http://127.0.0.1:${PAGES}/`);
    await page.evaluate(
      ([s, e]) => {
        window.__seed = s;
        window.__editable = e;
      },
      [seed, editable],
    );
    await page.evaluate(
      ([gateway, tok, note]) => window.joinCanvas({ gateway, token: tok, note }),
      [GATEWAY, token, NOTE],
    );
    const canvas = page.frameLocator("iframe").locator("canvas").first();
    await canvas.waitFor({ timeout: 30_000 });
    return {
      page,
      canvas,
      connected: () => page.evaluate(() => window.canvas.connected),
      ids: () => page.evaluate(() => window.canvas.ids()),
      live: () => page.evaluate(() => window.canvas.live()),
      elements: () => page.evaluate(() => window.canvas.elements),
      peers: () => page.evaluate(() => window.canvas.peers),
      /**
       * Draw a shape by actually dragging one.
       *
       * The click first is not a flourish: Excalidraw's tool shortcuts are
       * document-level key handlers inside the iframe, and a key pressed
       * before anything in that frame has focus selects no tool — so the drag
       * that follows is a marquee selection and nothing is drawn. That is how
       * this verification first read "nobody's shapes propagate" when what was
       * actually happening was that nobody had drawn one.
       */
      draw: async (key, from, to) => {
        const box = await canvas.boundingBox();
        // Clicked where the shape is about to be drawn: inside the canvas, and
        // never on the toolbar or the footer, which the corners are.
        await page.mouse.click(box.x + from[0], box.y + from[1]);
        await page.keyboard.press(key);
        await page.mouse.move(box.x + from[0], box.y + from[1]);
        await page.mouse.down();
        await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
        await page.mouse.up();
      },
      received: () => page.evaluate(() => window.canvas.received),
      frames: () => page.evaluate(() => window.canvas.frames),
      syncs: () => page.evaluate(() => window.canvas.syncs),
      selectAll: async () => {
        const box = await canvas.boundingBox();
        // Focus the frame first: Excalidraw's shortcuts are document-level key
        // handlers inside the iframe, and a key pressed before anything there
        // has focus reaches nothing. Escape drops whatever tool is active so
        // the select-all lands on the selection tool.
        await page.mouse.click(box.x + box.width / 2, box.y + box.height - 120);
        await page.keyboard.press("Escape");
        await page.keyboard.press("Control+a");
      },
      nudge: async (key, times) => {
        for (let i = 0; i < times; i += 1) await page.keyboard.press(key);
      },
      click: async (at) => {
        const box = await canvas.boundingBox();
        await page.mouse.click(box.x + at[0], box.y + at[1]);
      },
      dragFrom: async (from, to) => {
        const box = await canvas.boundingBox();
        await page.mouse.move(box.x + from[0], box.y + from[1]);
        await page.mouse.down();
        await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
        await page.mouse.up();
      },
      press: (key) => page.keyboard.press(key),
    };
  };

  /* ---------------------------------------------------------------- 1 ---- */
  const ana = await open(ANA, { seed: seededElements });
  await until(() => ana.connected());
  check("a browser opens the real Excalidraw editor on a shared canvas", await ana.connected());

  const bo = await open(BO);
  await until(() => bo.connected());
  const gotSeed = await until(async () => (await bo.ids()).includes("seed-rect"));
  check(
    "a second browser receives the drawing that was already there",
    gotSeed,
    gotSeed ? "" : `ids ${JSON.stringify(await bo.ids())} frames ${JSON.stringify(await bo.frames())} syncs ${await bo.syncs()} received ${await bo.received()}`,
  );

  /* ---------------------------------------------------------------- 2 ---- */
  // Different shapes, at the same time, in two windows.
  await Promise.all([ana.draw("r", [220, 240], [340, 340]), bo.draw("o", [560, 240], [680, 340])]);
  const bothShapes = await until(async () => {
    const a = await ana.ids();
    const b = await bo.ids();
    return a.length === 3 && JSON.stringify(a) === JSON.stringify(b);
  }, { timeout: 20_000 });
  check(
    "two people drawing different shapes at once keep both",
    bothShapes,
    bothShapes ? "" : `${JSON.stringify(await ana.ids())} vs ${JSON.stringify(await bo.ids())}`,
  );

  /* ---------------------------------------------------------------- 3 ---- */
  /*
    The same shapes, moved by both at the same time.

    Select-all and arrow keys rather than a drag at guessed coordinates: every
    element on the canvas is changed by both people in the same instant, which
    is the version race this is about, and neither the selection nor the
    movement depends on where anything happens to be on screen.
  */
  await Promise.all([ana.selectAll(), bo.selectAll()]);
  await Promise.all([
    ana.nudge("ArrowRight", 6),
    bo.nudge("ArrowDown", 6),
  ]);
  const agreed = await until(async () => {
    const a = (await ana.live()).map((one) => `${one.id}:${Math.round(one.x)},${Math.round(one.y)}`).sort();
    const b = (await bo.live()).map((one) => `${one.id}:${Math.round(one.x)},${Math.round(one.y)}`).sort();
    return a.length === 3 && JSON.stringify(a) === JSON.stringify(b);
  }, { timeout: 25_000 });
  check(
    "two people moving the same shapes at once end on the same canvas",
    agreed,
    agreed
      ? ""
      : `${JSON.stringify((await ana.live()).map((o) => [o.id, Math.round(o.x), Math.round(o.y)]))} vs ` +
        `${JSON.stringify((await bo.live()).map((o) => [o.id, Math.round(o.x), Math.round(o.y)]))}`,
  );

  /* ---------------------------------------------------------------- 4 ---- */
  // The save path: the merged scene spliced into the customer's file, with its
  // frontmatter and its attachment intact.
  const merged = await ana.elements();
  const nextBody = serializeDrawing(body, merged, { files: ATTACHMENT });
  const saved = await callTool(ANA, "write_note", {
    path: NOTE,
    content: nextBody ?? "",
    summary: "the elected saver flushing the merged canvas",
  });
  check("the merged canvas saves back to the bucket", nextBody !== null && !saved?.isError, textOf(saved).slice(0, 140));

  const parsed = parseDrawing(nextBody ?? "", NOTE);
  /*
    The attachment is inside the compressed payload, not in the Markdown, so
    it is checked by decompressing rather than by searching the file — an
    earlier version of this check looked for the id in the text, found nothing,
    and reported a loss that had not happened.
  */
  const fence = (nextBody ?? "").match(/```compressed-json\n([\s\S]*?)\n```/);
  const payload = fence ? decompressFromBase64(fence[1].replace(/\n/g, "")) : "";
  check(
    "the saved file is still a drawing, with every shape and its attachment",
    // Spliced, never regenerated: the frontmatter the file opened with is
    // still the first line, and the attachment nobody touched is still there.
    parsed.unreadable === null &&
      (parsed.elements ?? []).length === merged.length &&
      payload.includes("file-id-kept") &&
      (nextBody ?? "").startsWith("---"),
    parsed.unreadable === null
      ? `${(parsed.elements ?? []).length} of ${merged.length} elements, attachment ${payload.includes("file-id-kept")}`
      : String(parsed.unreadable),
  );

  /* ---------------------------------------------------------------- 5 ---- */
  const late = await open(BO);
  await until(() => late.connected());
  const converged = await until(async () => {
    const a = await ana.ids();
    const c = await late.ids();
    return c.length > 0 && JSON.stringify(a) === JSON.stringify(c);
  }, { timeout: 25_000 });
  check(
    "a browser joining afterwards is replayed onto the same canvas",
    converged,
    converged ? "" : `${JSON.stringify(await ana.ids())} vs ${JSON.stringify(await late.ids())}`,
  );

  /* ---------------------------------------------------------------- 6 ---- */
  const reader = await open(READER, { editable: false });
  await until(() => reader.connected());
  /*
    Counted rather than read off the scene: a read-only editor is in view mode
    and reports no changes, by design — the console has nothing to save for a
    reader, so there is nothing for it to hear about. What is being checked is
    that the whole canvas was sent to them.
  */
  const readerGot = await until(async () => (await reader.received()) >= 3, { timeout: 25_000 });
  check("a read-only member is sent the whole canvas", readerGot, `${await reader.received()} elements`);

  const before = await ana.ids();
  await reader.draw("r", [700, 420], [800, 520]);
  await new Promise((r) => setTimeout(r, 2500));
  check(
    "a read-only member's shape never reaches anybody else",
    JSON.stringify(await ana.ids()) === JSON.stringify(before),
    JSON.stringify(await ana.ids()),
  );

  /* ------------------------------------------------------------- 6b ---- */

  /*
    **An agent writing the drawing, while three browsers have it open.**

    A tool writes a `.excalidraw.md` as a file — the only shape `write_note`
    has — so the console parses it back into elements and hands them on like a
    peer's change. Before this the canvas adopted the version and showed none
    of it: the etag moved, the drawing did not, and the next save wrote the old
    shapes over the agent's.
  */
  const agentElements = [
    ...(await ana.live()),
    {
      ...seededElements[0],
      id: "drawn-by-an-agent",
      x: 400,
      y: 400,
      version: 2,
      versionNonce: 909,
      index: "a5",
    },
  ];
  const agentBody = serializeDrawing(nextBody ?? body, agentElements, { files: ATTACHMENT });
  const agentWrote = await callTool(BO, "write_note", {
    path: NOTE,
    content: agentBody ?? "",
    summary: "an agent drawing on a canvas three people have open",
  });
  const agentLanded = await until(
    async () => (await ana.ids()).includes("drawn-by-an-agent"),
    { timeout: 25_000 },
  );
  check(
    "a shape written by an MCP client appears on the open canvas",
    agentBody !== null && !agentWrote?.isError && agentLanded,
    agentLanded ? "" : `${textOf(agentWrote).slice(0, 100)} ids ${JSON.stringify(await ana.ids())}`,
  );

  /* ---------------------------------------------------------------- 7 ---- */
  const seenPeers = await until(async () => (await bo.peers()).length > 0, { timeout: 25_000 });
  check(
    "each browser knows where the others' pointers are",
    seenPeers,
    seenPeers ? JSON.stringify((await bo.peers()).map((p) => p.name)) : "",
  );

  /* ---------------------------------------------------------------- 8 ---- */
  // Last, because it empties the canvas. Excalidraw deletes by flag, so this
  // is an ordinary element update and the ids stay in the file.
  await ana.selectAll();
  await ana.press("Delete");
  const goneEverywhere = await until(async () => (await bo.live()).length === 0, { timeout: 25_000 });
  check(
    "shapes deleted in one window disappear in the other",
    goneEverywhere,
    goneEverywhere ? "" : JSON.stringify((await bo.live()).map((one) => one.id)),
  );

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
