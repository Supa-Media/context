// A change's audit entry and activity line are written behind the response (`keepBookkeeping`, `activity/record.js`):
// on a store with `defer` the change answers before either lands, both still land inside the same invocation,
// and a failure there is said in a log line rather than swallowed.
//
// Sabotage: dropping the console.warn from `keepBookkeeping`'s catch fails the "said in a log line" case.
import { test } from "node:test";
import assert from "node:assert/strict";

import { recordChange } from "../src/activity/record.js";

const AUDIT = ".context/audit/";

/** An in-memory store whose puts can be held, and whose `defer` collects work the way `ctx.waitUntil` does. */
function storeWith({ defer = true, failAudit = false } = {}) {
  const objects = new Map();
  const writes = [];
  const pending = [];
  let release = () => {};
  const held = new Promise((resolve) => (release = resolve));
  let version = 0;
  const store = {
    capabilities: {},
    async get(key) {
      if (!objects.has(key)) return null;
      const text = objects.get(key);
      return { etag: `e${version}`, text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
    },
    async head(key) {
      return objects.has(key) ? { etag: `e${version}` } : null;
    },
    async put(key, body) {
      if (key.startsWith(AUDIT)) {
        await held;
        // The first note's entry is the slower one, so entries that raced would land out of order.
        if (String(body).includes("notes/a.md")) await new Promise((resolve) => setTimeout(resolve, 20));
        if (failAudit) throw new Error("audit store down");
      }
      objects.set(key, String(body));
      writes.push(key);
      version += 1;
      return { etag: `e${version}` };
    },
    async list() {
      return { objects: [], truncated: false };
    },
    defer: defer ? (work) => pending.push(Promise.resolve(work)) : null,
  };
  return {
    store,
    objects,
    writes,
    release,
    async settle() {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
  };
}

const audits = (objects) => [...objects.keys()].filter((key) => key.startsWith(AUDIT));

test("with defer, a change answers before its audit entry lands, and the entry lands once the invocation settles", async () => {
  const host = storeWith();
  // The audit put is held: an awaited one would never let recordChange return.
  await recordChange(host.store, "update_note", "private", ["notes/a.md"], {});
  assert.equal(audits(host.objects).length, 0, "the audit entry was written in front of the answer");
  host.release();
  await host.settle();
  const [key] = audits(host.objects);
  assert.ok(key, "the deferred audit entry never landed");
  const entry = JSON.parse(host.objects.get(key));
  assert.equal(entry.action, "update_note");
  assert.deepEqual(entry.paths, ["notes/a.md"]);
});

test("two changes in one request keep their bookkeeping in order, one after the other", async () => {
  const host = storeWith();
  await recordChange(host.store, "update_note", "private", ["notes/a.md"], {});
  await recordChange(host.store, "update_note", "private", ["notes/b.md"], {});
  host.release();
  await host.settle();
  const order = host.writes.filter((key) => key.startsWith(AUDIT)).map((key) => JSON.parse(host.objects.get(key)).paths[0]);
  assert.deepEqual(order, ["notes/a.md", "notes/b.md"]);
});

test("a deferred audit failure never fails the change it follows", async () => {
  const host = storeWith({ failAudit: true });
  await recordChange(host.store, "update_note", "private", ["notes/a.md"], {});
  host.release();
  await host.settle();
  assert.equal(audits(host.objects).length, 0);
});

test("a deferred audit failure is said in a log line, with no note path in it", async () => {
  const host = storeWith({ failAudit: true });
  host.store.actor = { workspaceId: "ws_test", clientId: "c", name: "n", client: "cl" };
  const lines = [];
  const warn = console.warn;
  console.warn = (line) => lines.push(String(line));
  try {
    await recordChange(host.store, "update_note", "private", ["notes/a.md"], {});
    host.release();
    await host.settle();
  } finally {
    console.warn = warn;
  }
  // The change is never failed by its bookkeeping, but a trail with a hole in it must not be a silent one: the
  // audit entry is the workspace's own record of who changed what.
  const said = lines.map((line) => JSON.parse(line)).filter((line) => line.event === "bookkeeping_behind_failed");
  assert.equal(said.length, 1, "a deferred audit failure said nothing");
  assert.equal(said[0].action, "update_note");
  assert.equal(said[0].workspace, "ws_test");
  assert.ok(!lines.join("\n").includes("notes/a.md"), "the log line named a note path");
});

test("with no defer, the audit entry is awaited as before, and its failure still fails the change", async () => {
  const host = storeWith({ defer: false });
  host.release();
  await recordChange(host.store, "update_note", "private", ["notes/a.md"], {});
  assert.equal(audits(host.objects).length, 1);
  const failing = storeWith({ defer: false, failAudit: true });
  failing.release();
  await assert.rejects(recordChange(failing.store, "update_note", "private", ["notes/a.md"], {}), /audit store down/);
});

test("a routing suggestion's audit entry lands before the answer even with defer, because it is the whole record", async () => {
  const host = storeWith({ failAudit: true });
  host.release();
  await assert.rejects(recordChange(host.store, "route_suggestion", "private", [], {}), /audit store down/);
});
