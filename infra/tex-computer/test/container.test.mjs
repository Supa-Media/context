// The server inside Tex's computer, run against a temporary work folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await realpath(await mkdtemp(join(tmpdir(), "tex-computer-")));
process.env.TEX_WORK = root;
const { handle } = await import("../container/server.mjs");
const { workPath, realWorkPath } = await import("../container/files.mjs");

test("a path never leaves the work folder, by .., an absolute path or a symlink", async () => {
  assert.equal(workPath("../etc/passwd", root), null);
  assert.equal(workPath("/etc/passwd", root), null);
  assert.equal(workPath("a/../../x", root), null);
  assert.equal(workPath("a/b.txt", root), join(root, "a/b.txt"));
  assert.equal(workPath(`${root}/a.txt`, root), join(root, "a.txt"));
  await symlink("/etc", join(root, "out"));
  assert.equal(await realWorkPath("out/passwd", root), null);
  const read = await handle("read", { path: "out/passwd" });
  assert.equal(read.status, 400);
  const wrote = await handle("write", { path: "out/x", content: "y" });
  assert.equal(wrote.status, 400);
});

test("writes, reads back, lists and runs in the work folder", async () => {
  assert.equal((await handle("write", { path: "data/a.csv", content: "x,y\n1,2\n" })).status, 200);
  const read = await handle("read", { path: "data/a.csv" });
  assert.equal(read.value.text, "x,y\n1,2\n");
  const listed = await handle("list", { path: "data" });
  assert.deepEqual(listed.value.entries, [{ name: "a.csv", type: "file", bytes: 8 }]);
  const ran = await handle("run", { command: "wc -l < data/a.csv && pwd" });
  assert.equal(ran.value.ok, true);
  assert.equal(ran.value.stdout.trim().split("\n")[0], "2");
  assert.equal(ran.value.stdout.trim().split("\n")[1], root);
});

test("a failing command answers its exit code and its error, and a slow one is cut off at its limit", async () => {
  const failed = await handle("run", { command: "echo nope >&2; exit 3" });
  assert.equal(failed.value.ok, false);
  assert.equal(failed.value.exitCode, 3);
  assert.match(failed.value.stderr, /nope/);
  const slow = await handle("run", { command: "sleep 5", timeoutMs: 300 });
  assert.equal(slow.value.timedOut, true);
  assert.ok(slow.value.ms < 3000);
});

test("a background process left behind never holds the answer open", async () => {
  const started = Date.now();
  const ran = await handle("run", { command: "(sleep 30 &) ; echo done" });
  assert.equal(ran.value.stdout.trim(), "done");
  assert.ok(Date.now() - started < 5000);
});

test("a long output keeps its tail and says how much was dropped", async () => {
  const ran = await handle("run", { command: "head -c 100000 /dev/zero | tr '\\0' a; echo END" });
  assert.match(ran.value.stdout, /^\[\d+ earlier characters dropped\]/);
  assert.match(ran.value.stdout, /END\n$/);
});

test("refuses an empty command, a missing file and an unknown operation", async () => {
  assert.equal((await handle("run", { command: "  " })).status, 400);
  assert.equal((await handle("read", { path: "nope.txt" })).status, 404);
  assert.equal((await handle("shell", {})).status, 404);
});
