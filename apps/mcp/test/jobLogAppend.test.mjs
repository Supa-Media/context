/**
 * A job's day log survives one failed read or write (production, 2026-10-19:
 * the 1:12 pm check-in texted the person and left no line in
 * `tex/heartbeat/2026-10-19.md`; `appendLogEntry` gave up on its first
 * unreadable read and said nothing about why).
 *
 * Sabotage: restore `if (current === null) return false;` in
 * `appendLogEntry` and "one unreadable read is tried again" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendLogEntry, appendLogEntryWhy } from "../src/agent/jobLog.js";
import { shortEntry } from "../src/agent/heartbeat.js";

const NOTE = "etag: c2.doc-a.r-b\npath: tex/heartbeat/2026-10-19.md\nvisibility: private\ndocument_id: doc-a\n\n# Log\n\n## 12:11 pm\n\n_Stayed quiet._\n";

function fakeDispatch({ readFailures = 0, writeFailures = 0 } = {}) {
  const writes = [];
  let reads = 0;
  let failedWrites = 0;
  const dispatch = async (name, args) => {
    if (name === "read_note") {
      reads += 1;
      if (reads <= readFailures) throw new Error("Too many subrequests.");
      return { content: [{ type: "text", text: NOTE }] };
    }
    if (failedWrites < writeFailures) {
      failedWrites += 1;
      return { isError: true, content: [{ type: "text", text: "conflict: note changed since you read it\n\nSECRET BODY" }] };
    }
    writes.push(args);
    return { content: [{ type: "text", text: `written: ${args.path} (etag c2.doc-a.r-c)` }] };
  };
  return { dispatch, writes };
}

function capturing(work) {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(" "));
  return work().finally(() => {
    console.log = original;
  }).then((value) => ({ value, lines }));
}

test("one unreadable read is tried again, and the entry lands after what the log holds", async () => {
  const { dispatch, writes } = fakeDispatch({ readFailures: 1 });
  const ok = await appendLogEntry(dispatch, "tex/heartbeat/2026-10-19.md", "## 1:12 pm\n\n**Texted:** x\n", "# Log\n");
  assert.equal(ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].expected_etag, "c2.doc-a.r-b");
  assert.match(writes[0].content, /_Stayed quiet\._\n\n## 1:12 pm/);
});

test("a log that still can't be written says why in the Worker log, never with the note's words", async () => {
  const { dispatch } = fakeDispatch({ writeFailures: 2 });
  const { value, lines } = await capturing(() => appendLogEntry(dispatch, "tex/heartbeat/2026-10-19.md", "## 1:12 pm\n", "# Log\n"));
  assert.equal(value, false);
  const line = lines.map((text) => JSON.parse(text)).find((entry) => entry.event === "job_log");
  assert.deepEqual(line, { event: "job_log", outcome: "not_written", folder: "tex/heartbeat", why: "conflict" });
  assert.ok(!lines.join("\n").includes("SECRET BODY"));
});

test("a check-in whose whole entry won't land still logs what it texted, and why the rest is missing", async () => {
  const { dispatch, writes } = fakeDispatch({ writeFailures: 2 });
  const path = "tex/heartbeat/2026-10-19.md";
  const { value: why } = await capturing(() => appendLogEntryWhy(dispatch, path, "## 1:12 pm\n\nlong\n", "# Log\n"));
  assert.equal(why, "conflict");
  const now = Date.UTC(2026, 9, 19, 17, 12);
  const short = shortEntry({ now, timeZone: "America/New_York", text: "The lane hold\nends at 5.", outcome: "speak", why });
  assert.equal(await appendLogEntryWhy(dispatch, path, short, "# Log\n"), null);
  assert.match(writes[0].content, /## 1:12 pm\n\n\*\*Texted:\*\* The lane hold ends at 5\.\n\n_The rest of this look couldn't be written to the log \(conflict\)\._\n$/);
});
