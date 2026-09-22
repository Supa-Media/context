import test from "node:test";
import assert from "node:assert/strict";
import { withLogicalDelete, LOGICAL_DELETE_CONTENT_TYPE } from "../src/store/logicalDelete.js";
import { encryptNote } from "../src/encryption.js";

class RawStore {
  constructor() {
    this.objects = new Map();
    this.capabilities = { conditionalWrite: true, conditionalCreate: true, conditionalDelete: false };
    this.counter = 0;
    this.oneUse = false;
    this.afterPut = null;
  }

  seed(key, text, contentType = "text/markdown; charset=utf-8") {
    this.objects.set(key, { body: new TextEncoder().encode(text), etag: `e${++this.counter}`, contentType });
  }

  async get(key) {
    const item = this.objects.get(key);
    if (!item) return null;
    let reads = 0;
    const body = item.body.slice();
    const read = () => {
      reads += 1;
      if (this.oneUse && reads > 1) throw new Error("body consumed twice");
      return body.slice().buffer;
    };
    return {
      etag: item.etag,
      contentType: item.contentType,
      arrayBuffer: read,
      text: async () => new TextDecoder().decode(read()),
    };
  }

  async head(key) {
    const item = this.objects.get(key);
    return item
      ? { etag: item.etag, size: item.body.byteLength, contentType: item.contentType }
      : null;
  }

  async put(key, value, options = {}) {
    const current = this.objects.get(key);
    if (options.onlyIf?.absent === true && current) return null;
    if (options.onlyIf?.etagMatches !== undefined && (!current || current.etag !== options.onlyIf.etagMatches)) return null;
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    const item = { body: bytes.slice(), etag: `e${++this.counter}`, contentType: options.contentType || "text/markdown; charset=utf-8" };
    this.objects.set(key, item);
    if (this.afterPut) {
      const hook = this.afterPut;
      this.afterPut = null;
      await hook(item);
    }
    return { etag: item.etag };
  }

  async delete(key, options = {}) {
    const current = this.objects.get(key);
    if (!current) return null;
    if (options.onlyIf?.etagMatches !== undefined && current.etag !== options.onlyIf.etagMatches) return null;
    this.objects.delete(key);
  }

  async list({ prefix = "", delimiter, cursor, limit } = {}) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    if (delimiter) {
      const objects = [];
      const prefixes = new Set();
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf(delimiter);
        if (slash < 0) objects.push(this.listed(key));
        else prefixes.add(`${prefix}${rest.slice(0, slash + 1)}`);
      }
      return { objects, delimitedPrefixes: [...prefixes], truncated: false };
    }
    const start = cursor === undefined ? 0 : Number(cursor);
    const pageSize = limit || keys.length || 1;
    const pageKeys = keys.slice(start, start + pageSize);
    const truncated = start + pageKeys.length < keys.length;
    return {
      objects: pageKeys.map((key) => this.listed(key)),
      truncated,
      ...(truncated ? { cursor: String(start + pageKeys.length) } : {}),
    };
  }

  listed(key) {
    const item = this.objects.get(key);
    return { key, etag: item.etag, size: item.body.byteLength };
  }
}

async function hashText(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Simulate S3/R2-style ETags: identical physical bytes have identical ETags. */
class HashEtagStore extends RawStore {
  constructor() {
    super();
    this.pauseBeforeFirstMarkerCheck = true;
  }

  async put(key, value, options = {}) {
    const body = typeof value === "string"
      ? value
      : new TextDecoder().decode(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
    // The provider's conditional check is deliberately after this wait: this
    // models a request delayed before the atomic If-Match operation executes.
    if (options.contentType === LOGICAL_DELETE_CONTENT_TYPE && this.pauseBeforeFirstMarkerCheck) {
      this.pauseBeforeFirstMarkerCheck = false;
      this.markerCheckReady();
      await new Promise((resolve) => { this.resumeMarkerCheck = resolve; });
    }
    const nextEtag = await hashText(body);
    const current = this.objects.get(key);
    if (options.onlyIf?.absent === true && current) return null;
    if (options.onlyIf?.etagMatches !== undefined && (!current || current.etag !== options.onlyIf.etagMatches)) return null;
    const item = {
      body: new TextEncoder().encode(body),
      etag: nextEtag,
      contentType: options.contentType || "text/markdown; charset=utf-8",
    };
    this.objects.set(key, item);
    return { etag: item.etag };
  }
}

test("logical delete hides a marker from get, list, and folder prefixes", async () => {
  const raw = new RawStore();
  raw.seed("folder/note.md", "private text");
  const store = withLogicalDelete(raw);
  const before = await store.get("folder/note.md");
  await store.delete("folder/note.md", { onlyIf: { etagMatches: before.etag } });
  assert.equal(await store.get("folder/note.md"), null);
  assert.equal(raw.objects.has("folder/note.md"), true);
  assert.deepEqual((await store.list({ prefix: "", delimiter: "/" })).delimitedPrefixes, []);
  assert.equal((await store.list({ prefix: "" })).objects.some((entry) => entry.key === "folder/note.md"), false);
});

test("same-path recreation CASes over the marker and stale delete cannot remove it", async () => {
  const raw = new RawStore();
  raw.seed("note.md", "old");
  const store = withLogicalDelete(raw);
  const before = await store.get("note.md");
  await store.delete("note.md", { onlyIf: { etagMatches: before.etag } });
  const recreated = await store.put("note.md", "new", { onlyIf: { absent: true } });
  assert.ok(recreated);
  assert.equal((await store.get("note.md")).etag, recreated.etag);
  assert.equal(await store.delete("note.md", { onlyIf: { etagMatches: before.etag } }), null);
  assert.equal(await (await store.get("note.md")).text(), "new");
});

test("stamps Markdown recreations so content-hash ETags cannot ABA-delete them", async () => {
  const raw = new HashEtagStore();
  const body = "same";
  raw.objects.set("note.md", {
    body: new TextEncoder().encode(body),
    etag: await hashText(body),
    contentType: "text/markdown; charset=utf-8",
  });
  const store = withLogicalDelete(raw);
  const oldEtag = (await store.get("note.md")).etag;
  let markerCheckReady;
  const markerReady = new Promise((resolve) => { markerCheckReady = resolve; });
  raw.markerCheckReady = markerCheckReady;

  const staleDelete = store.delete("note.md", { onlyIf: { etagMatches: oldEtag } });
  await markerReady;
  await store.delete("note.md", { onlyIf: { etagMatches: oldEtag } });
  const recreated = await store.put("note.md", body, { onlyIf: { absent: true } });
  assert.ok(recreated);
  raw.resumeMarkerCheck();
  await staleDelete;

  const afterRecreate = await store.get("note.md");
  assert.equal(await afterRecreate.text(), body);
  assert.notEqual(afterRecreate.etag, oldEtag);
  assert.match(new TextDecoder().decode(raw.objects.get("note.md").body), /<!-- context-generation:v1:[0-9a-f]{32} -->$/);

  // A wrapper restart strips the same physical footer, and an old writer is
  // rejected because the stamped ETag is a fresh generation.
  const restarted = withLogicalDelete(raw);
  assert.equal(await (await restarted.get("note.md")).text(), body);
  assert.equal(await restarted.put("note.md", "stale", { onlyIf: { etagMatches: oldEtag } }), null);

  const changed = await restarted.put("note.md", "changed", { onlyIf: { etagMatches: afterRecreate.etag } });
  const changedEtag = changed.etag;
  const restored = await restarted.put("note.md", body, { onlyIf: { etagMatches: changedEtag } });
  assert.notEqual(restored.etag, changedEtag);
  assert.equal(await (await restarted.get("note.md")).text(), body);

  await restarted.put("copy.md", "old copy");
  const copyBefore = await restarted.get("copy.md");
  await restarted.delete("copy.md", { onlyIf: { etagMatches: copyBefore.etag } });
  const copied = await restarted.copy("note.md", "copy.md", {
    onlyIf: { absent: true },
    sourceOnlyIf: { etagMatches: restored.etag },
  });
  assert.ok(copied);
  assert.equal(await (await restarted.get("copy.md")).text(), body);
});

test("internal JSON metadata recreates without a Markdown footer", async () => {
  const raw = new RawStore();
  const key = ".context/collaboration/v1/doc.json";
  const body = '{"documentId":"doc-1"}';
  raw.seed(key, body, "application/json");
  const store = withLogicalDelete(raw);
  const before = await store.get(key);
  await store.delete(key, { onlyIf: { etagMatches: before.etag } });
  await store.put(key, body, { onlyIf: { absent: true }, contentType: "application/json" });
  assert.equal(new TextDecoder().decode(raw.objects.get(key).body), body);
});

test("simultaneous stamped Markdown recreates still have one CAS winner", async () => {
  const raw = new HashEtagStore();
  const body = "old";
  raw.objects.set("note.md", {
    body: new TextEncoder().encode(body),
    etag: await hashText(body),
    contentType: "text/markdown; charset=utf-8",
  });
  raw.pauseBeforeFirstMarkerCheck = false;
  const store = withLogicalDelete(raw);
  const before = await store.get("note.md");
  await store.delete("note.md", { onlyIf: { etagMatches: before.etag } });
  const [first, second] = await Promise.all([
    store.put("note.md", "first", { onlyIf: { absent: true } }),
    store.put("note.md", "second", { onlyIf: { absent: true } }),
  ]);
  assert.equal(Boolean(first) === Boolean(second), false);
  assert.ok(["first", "second"].includes(await (await store.get("note.md")).text()));
});

test("verified physical delete stores a marker instead of relying on ABA-prone delete", async () => {
  const raw = new HashEtagStore();
  raw.capabilities.conditionalDelete = true;
  raw.pauseBeforeFirstMarkerCheck = false;
  raw.objects.set("note.md", {
    body: new TextEncoder().encode("same"),
    etag: await hashText("same"),
    contentType: "text/markdown; charset=utf-8",
  });
  const store = withLogicalDelete(raw);
  const before = await store.get("note.md");
  await store.delete("note.md", { onlyIf: { etagMatches: before.etag } });
  assert.equal(raw.objects.get("note.md").contentType, LOGICAL_DELETE_CONTENT_TYPE);
  assert.equal(await store.get("note.md"), null);
});

test("unknown head metadata falls back to the provider existence probe", async () => {
  const raw = new RawStore();
  raw.seed("ordinary.md", "text");
  raw.head = async () => undefined;
  let probed = 0;
  raw.exists = async (key) => {
    probed += 1;
    return raw.objects.has(key);
  };
  const store = withLogicalDelete(raw);
  assert.equal(await store.exists("ordinary.md"), true);
  assert.equal(probed, 1);
});

test("unsupported Markdown recreation over a marker is refused", async () => {
  const raw = new RawStore();
  raw.seed("note.md", "old");
  const store = withLogicalDelete(raw);
  const before = await store.get("note.md");
  await store.delete("note.md", { onlyIf: { etagMatches: before.etag } });
  await assert.rejects(
    store.put("note.md", new Uint8Array([0, 1, 2]), { onlyIf: { absent: true } }),
    /unsupported/,
  );
});

test("literal footer text is outer-stamped instead of being stripped", async () => {
  const raw = new RawStore();
  raw.seed("literal.md", "before");
  const store = withLogicalDelete(raw);
  const literal = "I wrote this\n<!-- context-generation:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";
  await store.put("literal.md", literal);
  assert.equal(await (await store.get("literal.md")).text(), literal);
  assert.match(new TextDecoder().decode(raw.objects.get("literal.md").body), /<!-- context-generation:v1:[0-9a-f]{32} -->$/);
});

test("user binary recreation over a marker is refused", async () => {
  const raw = new RawStore();
  raw.seed("photo.png", "old", "application/octet-stream");
  const store = withLogicalDelete(raw);
  const before = await store.get("photo.png");
  await store.delete("photo.png", { onlyIf: { etagMatches: before.etag } });
  await assert.rejects(
    store.put("photo.png", new Uint8Array([0, 1, 2]), { onlyIf: { absent: true }, contentType: "application/octet-stream" }),
    /unsupported object/,
  );
});

test("valid encrypted Markdown can cross a stamped generation, but malformed envelopes cannot", async () => {
  const raw = new RawStore();
  raw.seed("encrypted.md", "plain");
  const store = withLogicalDelete(raw);
  const before = await store.get("encrypted.md");
  await store.delete("encrypted.md", { onlyIf: { etagMatches: before.etag } });
  const encrypted = await encryptNote("secret", {
    workspaceId: "ws-generation-test",
    workspaceKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    keyId: "k1",
  });
  await store.put("encrypted.md", encrypted, { onlyIf: { absent: true } });
  assert.equal(await (await store.get("encrypted.md")).text(), encrypted);
  await assert.rejects(
    store.put("encrypted.md", "---\ncontext_encryption: v1\n---\n\n```context-encrypted\n{bad}\n```", {
      onlyIf: { etagMatches: (await store.get("encrypted.md")).etag },
    }),
    /unsupported content/,
  );
  const plaintext = await store.put("encrypted.md", "back to plain", {
    onlyIf: { etagMatches: (await store.get("encrypted.md")).etag },
  });
  assert.ok(plaintext);
  assert.equal(await (await store.get("encrypted.md")).text(), "back to plain");
});

test("marker deletion is idempotent and survives a crash before the caller returns", async () => {
  const raw = new RawStore();
  raw.seed("note.md", "old");
  const store = withLogicalDelete(raw);
  const before = await store.get("note.md");
  await store.delete("note.md", { onlyIf: { etagMatches: before.etag } });
  assert.equal(await store.delete("note.md", { onlyIf: { etagMatches: before.etag } }), undefined);
  assert.equal(await store.delete("note.md"), undefined);
});

test("concurrent absent recreates have one CAS winner", async () => {
  const raw = new RawStore();
  raw.seed("note.md", "old");
  const store = withLogicalDelete(raw);
  const before = await store.get("note.md");
  await store.delete("note.md", { onlyIf: { etagMatches: before.etag } });
  const [first, second] = await Promise.all([
    store.put("note.md", "first", { onlyIf: { absent: true } }),
    store.put("note.md", "second", { onlyIf: { absent: true } }),
  ]);
  assert.equal(Boolean(first) === Boolean(second), false);
  assert.ok(["first", "second"].includes(await (await store.get("note.md")).text()));
});

test("native one-use bodies are not consumed twice and marker type is preserved", async () => {
  const raw = new RawStore();
  raw.oneUse = true;
  raw.seed("note.md", "ordinary");
  const store = withLogicalDelete(raw);
  const object = await store.get("note.md");
  assert.equal(await object.text(), "ordinary");
  await store.delete("note.md", { onlyIf: { etagMatches: object.etag } });
  assert.equal(raw.objects.get("note.md").contentType, LOGICAL_DELETE_CONTENT_TYPE);
});

test("a delayed marker write cannot delete a same-path recreation", async () => {
  const raw = new RawStore();
  raw.seed("note.md", "old");
  const store = withLogicalDelete(raw);
  const before = await store.get("note.md");
  let markerWritten;
  const markerReady = new Promise((resolve) => { markerWritten = resolve; });
  let release;
  const resume = new Promise((resolve) => { release = resolve; });
  raw.afterPut = async () => {
    markerWritten();
    await resume;
  };
  const deleting = store.delete("note.md", { onlyIf: { etagMatches: before.etag } });
  await markerReady;
  const recreated = await store.put("note.md", "new", { onlyIf: { absent: true } });
  assert.ok(recreated);
  release();
  await deleting;
  assert.equal(await (await store.get("note.md")).text(), "new");
});

test("a marker write that loses its response is safe to retry", async () => {
  const raw = new RawStore();
  raw.seed("note.md", "old");
  const store = withLogicalDelete(raw);
  const before = await store.get("note.md");
  raw.afterPut = async () => { throw new Error("response lost"); };
  await assert.rejects(store.delete("note.md", { onlyIf: { etagMatches: before.etag } }), /response lost/);
  assert.equal(await store.delete("note.md", { onlyIf: { etagMatches: before.etag } }), undefined);
  assert.equal(await store.get("note.md"), null);
});

test("all reserved paths use the same marker hiding and malformed markers stay visible", async () => {
  const raw = new RawStore();
  raw.seed(".context/trash/note.md", "old");
  raw.seed(".context/trash/malformed", "not-a-marker", LOGICAL_DELETE_CONTENT_TYPE);
  const store = withLogicalDelete(raw);
  const before = await store.get(".context/trash/note.md");
  await store.delete(".context/trash/note.md", { onlyIf: { etagMatches: before.etag } });
  assert.equal(await store.get(".context/trash/note.md"), null);
  assert.equal(await store.exists(".context/trash/note.md"), false);
  const listed = await store.list({ prefix: ".context/" });
  assert.deepEqual(listed.objects.map(({ key }) => key), [".context/trash/malformed"]);
  assert.equal(await (await store.get(".context/trash/malformed")).text(), "not-a-marker");
});

test("capability downgrade keeps existing markers hidden and refuses unsafe recreation", async () => {
  const raw = new RawStore();
  raw.seed("note.md", "old");
  const store = withLogicalDelete(raw);
  const before = await store.get("note.md");
  await store.delete("note.md", { onlyIf: { etagMatches: before.etag } });
  raw.capabilities = { conditionalWrite: false, conditionalCreate: false, conditionalDelete: false };
  const downgraded = withLogicalDelete(raw, { logicalDelete: true });
  assert.equal(await downgraded.get("note.md"), null);
  assert.equal((await downgraded.list({ prefix: "" })).objects.length, 0);
  assert.equal(await downgraded.put("note.md", "new", { onlyIf: { absent: true } }), null);
  assert.equal(await downgraded.delete("note.md"), undefined);
});

test("listing scans past a marker-only page instead of reporting a false empty page", async () => {
  const raw = new RawStore();
  raw.seed("a.md", "old");
  raw.seed("b.md", "later");
  const store = withLogicalDelete(raw);
  const before = await store.get("a.md");
  await store.delete("a.md", { onlyIf: { etagMatches: before.etag } });
  const page = await store.list({ prefix: "", limit: 1 });
  assert.deepEqual(page.objects.map(({ key }) => key), ["b.md"]);
  assert.equal(page.truncated, false);
});

test("partially filtered pages retain their cursor without dropping later live objects", async () => {
  const raw = new RawStore();
  for (const key of ["a.md", "b.md", "c.md", "d.md"]) raw.seed(key, key);
  const store = withLogicalDelete(raw);
  const first = await store.get("a.md");
  await store.delete("a.md", { onlyIf: { etagMatches: first.etag } });
  const keys = [];
  let cursor;
  do {
    const page = await store.list({ limit: 2, cursor });
    keys.push(...page.objects.map(({ key }) => key));
    if (!page.truncated) break;
    cursor = page.cursor;
  } while (cursor);
  assert.deepEqual(keys, ["b.md", "c.md", "d.md"]);
});

test("copy refuses a source version different from the one requested", async () => {
  const raw = new RawStore();
  raw.seed("source.md", "new text");
  const store = withLogicalDelete(raw);
  assert.equal(await store.copy("source.md", "target.md", {
    sourceOnlyIf: { etagMatches: "older-version" }, onlyIf: { absent: true },
  }), null);
  assert.equal(await store.get("target.md"), null);
});

test("a provider that replaces MIME metadata cannot expose a retired object", async () => {
  const raw = new RawStore();
  raw.seed("note.md", "old text");
  const store = withLogicalDelete(raw);
  const before = await store.get("note.md");
  await store.delete("note.md", { onlyIf: { etagMatches: before.etag } });
  raw.objects.get("note.md").contentType = "text/plain;charset=UTF-8";
  assert.equal(await store.get("note.md"), null);
  assert.deepEqual((await store.list()).objects, []);
  assert.ok(await store.put("note.md", "new text", { onlyIf: { absent: true } }));
  assert.equal(await (await store.get("note.md")).text(), "new text");
});
