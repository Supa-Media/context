/**
 * ABOUT LINES SAY WHO SAID THEM AND WHEN (`src/agent/aboutLines.js`).
 *
 * The Tex page shows each line of the person's `tex/about.md`, and of a group
 * chat's `tex/groups/<id>/about.md`, with its source and the day it was
 * written. Tex writes the source; `write_note` adds the date on save, so the
 * date is the day the line was written and never one a model guessed, and
 * rewriting the whole note does not make an old line new.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import worker from "../src/index.js";
import { isAboutNotePath, itemOf, stampAboutLines } from "../src/agent/aboutLines.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub, createS3Backend } from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";
import { texStoreNamespace } from "./texStoreFixture.mjs";

const NOV_2 = Date.UTC(2026, 10, 2, 15, 30);
const NOV_5 = Date.UTC(2026, 10, 5, 9, 0);

test("a new line with no marker is dated as Tex noticed; a line naming its source keeps it and gets the date", () => {
  const out = stampAboutLines("# About\n\n- Likes tea\n- Prefers short texts (you said so)\n", null, NOV_2);
  assert.equal(out, "# About\n\n- Likes tea (Tex noticed, 2026-11-02)\n- Prefers short texts (you said so, 2026-11-02)\n");
  assert.deepEqual(
    out.split("\n").map(itemOf).filter(Boolean).map((item) => [item.text, item.source, item.at]),
    [
      ["Likes tea", "Tex noticed", Date.UTC(2026, 10, 2)],
      ["Prefers short texts", "You said so", Date.UTC(2026, 10, 2)],
    ],
  );
});

test("a rewrite keeps each old line's marker and date, dates only what is new, and never touches a dated line", () => {
  const stored = "- Likes tea (Tex noticed, 2026-11-02)\n- Owns the budget (Sam said so, 2026-11-01)\n";
  const rewrite = "- Likes tea\n- owns  the budget (Sam said so)\n- Walks the dog at 7 (you said so)\n- Plays chess (you said so, 2026-10-20)\n";
  assert.equal(
    stampAboutLines(rewrite, stored, NOV_5),
    "- Likes tea (Tex noticed, 2026-11-02)\n- owns  the budget (Sam said so, 2026-11-01)\n- Walks the dog at 7 (you said so, 2026-11-05)\n- Plays chess (you said so, 2026-10-20)\n",
  );
});

test("an old line the stored note had with no date stays undated: the day it was written is not known", () => {
  const stored = "- Likes tea\n- Walks at 7 (you said so)\n";
  assert.equal(stampAboutLines("- Likes tea\n- Walks at 7 (you said so)\n- New\n", stored, NOV_5), "- Likes tea\n- Walks at 7 (you said so)\n- New (Tex noticed, 2026-11-05)\n");
});

test("front matter, headings, comments, rules and blank lines are left alone; a plain parenthesis is not a marker", () => {
  const note = "---\ntitle: About\n---\n## People\n<!-- kept -->\n---\n\nLikes tea (green)\r\n";
  assert.equal(
    stampAboutLines(note, null, NOV_2),
    "---\ntitle: About\n---\n## People\n<!-- kept -->\n---\n\nLikes tea (green) (Tex noticed, 2026-11-02)\r\n",
  );
});

test("stamping is idempotent", () => {
  const once = stampAboutLines("- A\n- B (you said so)\n", null, NOV_2);
  assert.equal(stampAboutLines(once, once, NOV_5), once);
});

test("only the about notes are about notes", () => {
  for (const path of ["tex/about.md", "tex/about-me.md", "tex/groups/g_1/about.md"]) assert.equal(isAboutNotePath(path), true, path);
  for (const path of ["about.md", "tex/notes.md", "tex/groups/../about.md", "tex/groups/a/b/about.md", "x/tex/about.md"]) {
    assert.equal(isAboutNotePath(path), false, path);
  }
});

// ── Through write_note ──────────────────────────────────────────────────────

const S3_ENDPOINT = "https://s3.example-about-lines.test";
const OWNER = `cat_about_lines_owner_${"0".repeat(18)}`;
const env = { CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN, TEX_STORE: texStoreNamespace().namespace, GATEWAY_SECRET };

async function call(name, args) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${OWNER}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    ctx,
  );
  const body = JSON.parse(await response.text());
  await settle();
  return { text: body?.result?.content?.[0]?.text || "", isError: body?.result?.isError === true };
}

const bodyOf = (text) => text.split("\n\n").slice(1).join("\n\n");
const etagOf = (text) => /^etag: (.+)$/m.exec(text)?.[1]?.trim();

let restore = [];
before(async () => {
  const s3 = createS3Backend(S3_ENDPOINT);
  restore.push(s3.install());
  const controlPlane = createControlPlaneStub();
  restore.push(controlPlane.install());
  controlPlane.serveTreesFrom(null, { s3 });
  controlPlane.addWorkspace("ws_about", "aboutlines", {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket: "about-lines",
    accessKeyId: "AKIAEXAMPLEEXAMPLEAL",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEAL",
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true, serverSideCopy: "same-store" },
    status: "active",
  });
  await controlPlane.addGrant({
    workspaceId: "ws_about",
    userId: "user_about",
    accessToken: OWNER,
    scopes: ["context:read", "context:write", "context:private"],
  });
});
after(() => {
  for (const undo of restore.reverse()) undo();
});

test("write_note dates the about note's lines on save, keeps old lines' dates on a rewrite, and leaves other notes alone", async () => {
  const day = new Date().toISOString().slice(0, 10);
  const first = await call("write_note", { path: "tex/about.md", content: "- Likes tea (you said so)\n- Old fact (Tex noticed, 2026-10-01)\n" });
  assert.equal(first.isError, false, first.text);
  const read = await call("read_note", { path: "tex/about.md" });
  assert.equal(bodyOf(read.text), `- Likes tea (you said so, ${day})\n- Old fact (Tex noticed, 2026-10-01)\n`);

  const rewrite = await call("write_note", {
    path: "tex/about.md",
    content: "- Old fact\n- New fact\n- Likes tea (you said so)\n",
    expected_etag: etagOf(read.text),
  });
  assert.equal(rewrite.isError, false, rewrite.text);
  assert.equal(
    bodyOf((await call("read_note", { path: "tex/about.md" })).text),
    `- Old fact (Tex noticed, 2026-10-01)\n- New fact (Tex noticed, ${day})\n- Likes tea (you said so, ${day})\n`,
  );

  const other = await call("write_note", { path: "tex/notes.md", content: "- Likes tea\n" });
  assert.equal(other.isError, false, other.text);
  assert.equal(bodyOf((await call("read_note", { path: "tex/notes.md" })).text), "- Likes tea\n");
});
