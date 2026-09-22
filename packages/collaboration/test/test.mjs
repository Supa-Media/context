import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { encryptNote, decryptNote, generateWorkspaceKey } from "../../../apps/mcp/src/encryption.js";
import {
  CollaborationError,
  commitUpdate,
  eligible,
  readDocument,
  replaceText,
  moveDocument,
  restoreDocument,
  sealDocument,
  supported,
  tombstoneDocument,
} from "../src/index.js";

class MemoryStore {
  constructor({ conditionalWrite = true, conditionalCreate = true, conditionalDelete = true } = {}) {
    this.capabilities = { conditionalWrite, conditionalCreate, conditionalDelete };
    this.objects = new Map();
    this.sequence = 0;
    this.failAt = new Set();
    this.putCount = 0;
  }

  async get(key) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      etag: object.etag,
      text: async () => object.text,
    };
  }

  async put(key, value, options = {}) {
    this.putCount += 1;
    if (this.failAt.has(this.putCount)) throw new Error(`injected put failure ${this.putCount}`);
    const expected = options.onlyIf?.etagMatches;
    const absent = options.onlyIf?.absent;
    const current = this.objects.get(key);
    if (expected !== undefined && (!current || current.etag !== expected)) return null;
    if (absent && current) return null;
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    const etag = `e${++this.sequence}`;
    this.objects.set(key, { etag, text });
    return { etag };
  }

  async delete(key, options = {}) {
    const current = this.objects.get(key);
    if (!current) return;
    if (options.onlyIf?.etagMatches !== undefined && current.etag !== options.onlyIf.etagMatches) return null;
    this.putCount += 1;
    if (this.failAt.has(this.putCount)) throw new Error(`injected delete failure ${this.putCount}`);
    this.objects.delete(key);
  }

  async list({ prefix = "" } = {}) {
    return {
      objects: [...this.objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, object]) => ({ key, etag: object.etag })),
      truncated: false,
    };
  }

  seed(key, text) {
    const etag = `e${++this.sequence}`;
    this.objects.set(key, { etag, text });
    return etag;
  }

  change(key, text) {
    return this.seed(key, text);
  }
}

function encodedTextUpdate(text) {
  const doc = new Y.Doc();
  doc.getText("note").insert(0, text);
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

function encryptedEnvelope(label = "ciphertext") {
  return [
    "---",
    "context_encryption: v1",
    "---",
    "",
    "> [!NOTE] This note is encrypted.",
    "",
    "```context-encrypted",
    JSON.stringify({ v: 1, ct: label }),
    "```",
    "",
  ].join("\n");
}

test("empty and pre-existing notes initialize exactly once", async () => {
  const store = new MemoryStore();
  const emptyEtag = store.seed("empty.md", "");
  const first = await readDocument(store, "empty.md");
  const second = await readDocument(store, "empty.md");
  assert.equal(first.text, "");
  assert.match(first.etag, /^c2\.doc-/);
  assert.notEqual(first.etag, emptyEtag);
  assert.equal(second.documentId, first.documentId);
  assert.equal(second.update, first.update);

  store.seed("existing.md", "Hello\nworld\n");
  const existing = await readDocument(store, "existing.md");
  assert.equal(existing.text, "Hello\nworld\n");
  assert.notEqual(existing.documentId, first.documentId);
});

test("concurrent initialization adopts one canonical seed snapshot", async () => {
  const store = new MemoryStore();
  store.seed("race-init.md", "same seed\n");
  const [left, right] = await Promise.all([
    readDocument(store, "race-init.md"),
    readDocument(store, "race-init.md"),
  ]);
  assert.equal(left.documentId, right.documentId);
  assert.equal(left.update, right.update);
  assert.equal(left.text, "same seed\n");
});

test("an offline create ACK remains the exact base after a peer edits the new note", async () => {
  const store = new MemoryStore();
  const rawCreateEtag = store.seed("created-offline.md", "Created offline\n");
  const firstRead = await readDocument(store, "created-offline.md");
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Buffer.from(firstRead.update, "base64"));
  peer.getText("note").insert(peer.getText("note").length, "Peer sentence\n");
  await commitUpdate(store, "created-offline.md", {
    documentId: firstRead.documentId,
    update: Buffer.from(Y.encodeStateAsUpdate(peer)).toString("base64"),
  });
  const reread = await readDocument(store, "created-offline.md");
  assert.notEqual(reread.etag, firstRead.etag);
  const pending = { expectedEtag: rawCreateEtag, text: "Created offline\nMore local typing\n" };
  const merged = await replaceText(store, "created-offline.md", pending);
  for (const sentence of ["Created offline", "Peer sentence", "More local typing"]) {
    assert.equal(merged.text.split(sentence).length - 1, 1);
  }
  const retried = await replaceText(store, "created-offline.md", pending);
  assert.equal(retried.text, merged.text);
  assert.equal(await (await store.get("created-offline.md")).text(), merged.text);
  peer.destroy();
});

test("human update and agent replacement preserve an unseen human insertion", async () => {
  const store = new MemoryStore();
  store.seed("note.md", "Heading\nBody\n");
  const agentRead = await readDocument(store, "note.md");

  const human = new Y.Doc();
  Y.applyUpdate(human, Buffer.from(agentRead.update, "base64"));
  human.getText("note").insert(human.getText("note").length, "Human sentence\n");
  await commitUpdate(store, "note.md", {
    documentId: agentRead.documentId,
    update: Buffer.from(Y.encodeStateAsUpdate(human)).toString("base64"),
  });

  const merged = await replaceText(store, "note.md", {
    documentId: agentRead.documentId,
    expectedEtag: agentRead.etag,
    text: "Title\nBody\n",
  });
  assert.equal(merged.text, "Title\nBody\nHuman sentence\n");
});

test("replacement handles multiple disjoint hunks", async () => {
  const store = new MemoryStore();
  store.seed("multi.md", "one two three four five\n");
  const base = await readDocument(store, "multi.md");
  const result = await replaceText(store, "multi.md", {
    documentId: base.documentId,
    expectedEtag: base.etag,
    text: "ONE two THREE four FIVE\n",
  });
  assert.equal(result.text, "ONE two THREE four FIVE\n");
});

test("offline updates merge after an online update and duplicate delivery is harmless", async () => {
  const store = new MemoryStore();
  store.seed("offline.md", "base\n");
  const offlineRead = await readDocument(store, "offline.md");

  const online = new Y.Doc();
  Y.applyUpdate(online, Buffer.from(offlineRead.update, "base64"));
  online.getText("note").insert(0, "online ");
  const onlineUpdate = Buffer.from(Y.encodeStateAsUpdate(online)).toString("base64");
  await commitUpdate(store, "offline.md", { documentId: offlineRead.documentId, update: onlineUpdate });

  const offline = new Y.Doc();
  Y.applyUpdate(offline, Buffer.from(offlineRead.update, "base64"));
  offline.getText("note").insert(offline.getText("note").length, "offline\n");
  const offlineUpdate = Buffer.from(Y.encodeStateAsUpdate(offline)).toString("base64");
  const once = await commitUpdate(store, "offline.md", { documentId: offlineRead.documentId, update: offlineUpdate });
  const twice = await commitUpdate(store, "offline.md", { documentId: offlineRead.documentId, update: offlineUpdate });
  assert.equal(once.text, twice.text);
  assert.match(once.text, /online/);
  assert.match(once.text, /offline/);
});

test("concurrent state writers converge through conditional state writes", async () => {
  const store = new MemoryStore();
  store.seed("race.md", "race\n");
  const base = await readDocument(store, "race.md");
  const left = new Y.Doc();
  Y.applyUpdate(left, Buffer.from(base.update, "base64"));
  left.getText("note").insert(0, "L");
  const right = new Y.Doc();
  Y.applyUpdate(right, Buffer.from(base.update, "base64"));
  right.getText("note").insert(0, "R");
  const [a, b] = await Promise.all([
    commitUpdate(store, "race.md", { documentId: base.documentId, update: Buffer.from(Y.encodeStateAsUpdate(left)).toString("base64") }),
    commitUpdate(store, "race.md", { documentId: base.documentId, update: Buffer.from(Y.encodeStateAsUpdate(right)).toString("base64") }),
  ]);
  const final = await readDocument(store, "race.md");
  assert.match(final.text, /L/);
  assert.match(final.text, /R/);
  assert.equal(a.documentId, b.documentId);
});

test("a write failure leaves durable state and recovers on retry", async () => {
  const store = new MemoryStore();
  store.seed("fault.md", "before\n");
  const base = await readDocument(store, "fault.md");
  const changed = new Y.Doc();
  Y.applyUpdate(changed, Buffer.from(base.update, "base64"));
  changed.getText("note").delete(0, changed.getText("note").length);
  changed.getText("note").insert(0, "after\n");
  const update = Buffer.from(Y.encodeStateAsUpdate(changed)).toString("base64");
  const nextPut = store.putCount + 2;
  store.failAt.add(nextPut);
  await assert.rejects(() => commitUpdate(store, "fault.md", { documentId: base.documentId, update }), CollaborationError);
  store.failAt.clear();
  const recovered = await commitUpdate(store, "fault.md", { documentId: base.documentId, update });
  assert.equal(recovered.text, "after\n");
});

test("recovery succeeds when each commit bucket write fails in turn", async () => {
  for (let failedWrite = 5; failedWrite <= 8; failedWrite += 1) {
    const store = new MemoryStore();
    store.seed("each-write.md", "before\n");
    const base = await readDocument(store, "each-write.md");
    const changed = new Y.Doc();
    Y.applyUpdate(changed, Buffer.from(base.update, "base64"));
    changed.getText("note").insert(0, "after ");
    const update = Buffer.from(Y.encodeStateAsUpdate(changed)).toString("base64");
    store.failAt.add(failedWrite);
    await assert.rejects(
      () => commitUpdate(store, "each-write.md", { documentId: base.documentId, update }),
      CollaborationError,
      `write ${failedWrite} should be surfaced as pending or failed`,
    );
    store.failAt.clear();
    const recovered = await commitUpdate(store, "each-write.md", { documentId: base.documentId, update });
    assert.equal(recovered.text, "after before\n", `write ${failedWrite}`);
  }
});

test("accepted collaboration state repairs a legacy Markdown mutation with a fresh CAS", async () => {
  const store = new MemoryStore();
  store.seed("legacy.md", "old\n");
  const base = await readDocument(store, "legacy.md");
  store.change("legacy.md", "legacy edit\n");
  await replaceText(store, "legacy.md", { documentId: base.documentId, expectedEtag: base.etag, text: "agent edit\n" });
  assert.equal(await (await store.get("legacy.md")).text(), "agent edit\n");
});

test("sealing accepts the production encryption envelope and retains decryptable bytes", async () => {
  const store = new MemoryStore();
  store.seed("encrypted.md", "secret plaintext");
  const base = await readDocument(store, "encrypted.md");
  const workspaceKey = generateWorkspaceKey();
  const envelope = await encryptNote(base.text, { workspaceId: "fake-workspace", workspaceKey, keyId: "key1" });
  assert.match(envelope, /context_encryption_key: ws:key1/);
  await sealDocument(store, "encrypted.md", { expectedEtag: base.etag, text: envelope });
  const stored = await (await store.get("encrypted.md")).text();
  assert.equal(await decryptNote(stored, { workspaceId: "fake-workspace", keys: { key1: workspaceKey } }), base.text);
  assert.equal(store.objects.has(`.context/collaboration/v1/documents/${base.documentId}.json`), false);
});

test("sealing freezes the generation, retains ciphertext, and purges plaintext history", async () => {
  const store = new MemoryStore();
  store.seed("sealed.md", "secret\n");
  const before = await readDocument(store, "sealed.md");
  const changed = new Y.Doc();
  Y.applyUpdate(changed, Buffer.from(before.update, "base64"));
  changed.getText("note").insert(0, "more ");
  await commitUpdate(store, "sealed.md", {
    documentId: before.documentId,
    update: Buffer.from(Y.encodeStateAsUpdate(changed)).toString("base64"),
  });
  const current = await readDocument(store, "sealed.md");
  const envelope = encryptedEnvelope();
  const sealed = await sealDocument(store, "sealed.md", { expectedEtag: current.etag, text: envelope });
  assert.equal(sealed.documentId, current.documentId);
  assert.equal(await (await store.get("sealed.md")).text(), envelope);
  await assert.rejects(() => readDocument(store, "sealed.md"), (error) => error.code === "INELIGIBLE_DOCUMENT");
  const history = await store.list({ prefix: ".context/collaboration/" });
  assert.equal(history.objects.some(({ key }) => key.includes(`/documents/${current.documentId}`)), false);
  assert.equal(history.objects.some(({ key }) => key.includes(`/revisions/${current.documentId}/`)), false);
  await assert.rejects(
    () => commitUpdate(store, "sealed.md", { documentId: current.documentId, update: encodedTextUpdate("old offline") }),
    (error) => error.code === "INELIGIBLE_DOCUMENT",
  );

  // An authorized raw decrypt is a fresh collaboration generation.
  store.change("sealed.md", "decrypted again\n");
  const reopened = await readDocument(store, "sealed.md");
  assert.notEqual(reopened.documentId, current.documentId);
  assert.equal(reopened.text, "decrypted again\n");
  await assert.rejects(
    () => commitUpdate(store, "sealed.md", { documentId: current.documentId, update: encodedTextUpdate("old offline") }),
    (error) => error.code === "GENERATION_MISMATCH",
  );
});

test("sealing resumes after every storage mutation failure", async () => {
  const envelope = encryptedEnvelope("resume");
  for (let failedWrite = 1; failedWrite <= 28; failedWrite += 1) {
    const store = new MemoryStore();
    store.seed("resume.md", "secret\n");
    const base = await readDocument(store, "resume.md");
    const start = store.putCount + 1;
    store.failAt.add(failedWrite + start - 1);
    try {
      await sealDocument(store, "resume.md", { expectedEtag: base.etag, text: envelope });
    } catch (error) {
      assert(error instanceof Error, `mutation ${failedWrite} should surface an error`);
    }
    store.failAt.clear();
    const sealed = await sealDocument(store, "resume.md", { expectedEtag: base.etag, text: envelope });
    assert.equal(sealed.sealed, true, `mutation ${failedWrite}`);
    assert.equal(await (await store.get("resume.md")).text(), envelope, `ciphertext ${failedWrite}`);
  }
});

test("sealing validates the exact collaboration revision and refuses plaintext", async () => {
  const store = new MemoryStore();
  store.seed("validate.md", "secret\n");
  const base = await readDocument(store, "validate.md");
  await assert.rejects(
    () => sealDocument(store, "validate.md", { expectedEtag: base.etag, text: "plaintext" }),
    (error) => error.code === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    () => sealDocument(store, "validate.md", { expectedEtag: "c2-wrong-r0", text: encryptedEnvelope() }),
    (error) => error.code === "CONFLICT" || error.code === "GENERATION_MISMATCH",
  );
});

test("unsupported storage, wrong generation, missing bases, invalid updates, and ineligible paths fail closed", async () => {
  const store = new MemoryStore({ conditionalWrite: false });
  store.seed("note.md", "text");
  assert.equal(supported(store), false);
  await assert.rejects(() => readDocument(store, "note.md"), CollaborationError);

  const good = new MemoryStore();
  good.seed("note.md", "text");
  const read = await readDocument(good, "note.md");
  await assert.rejects(() => commitUpdate(good, "note.md", { documentId: "other", update: read.update }), /generation|document/i);
  await assert.rejects(() => replaceText(good, "note.md", { documentId: read.documentId, expectedEtag: "missing", text: "x" }), /base|revision|etag/i);
  await assert.rejects(() => commitUpdate(good, "note.md", { documentId: read.documentId, update: "%%%" }), /update|base64|invalid/i);
  assert.equal(eligible("privacy.md", "x"), false);
  assert.equal(eligible(".context/x.md", "x"), false);
  assert.equal(eligible("drawing.excalidraw.md", "x"), false);
  assert.equal(eligible("secret.md", "---\ncontext_encryption: v1\n---\n```context-encrypted\n{}\n```"), false);
  assert.equal(eligible("normal.md", "x"), true);
});

test("move preserves identity and history while fencing the old path", async () => {
  const store = new MemoryStore();
  store.seed("from.md", "move me\n");
  const before = await readDocument(store, "from.md");
  const moved = await moveDocument(store, "from.md", "to.md", { expectedEtag: before.etag });
  assert.equal(moved.documentId, before.documentId);
  assert.equal(moved.text, "move me\n");
  await assert.rejects(() => readDocument(store, "from.md"), /moved/i);
  await assert.rejects(() => commitUpdate(store, "from.md", { documentId: before.documentId, update: before.update }), /moved/i);
  assert.equal((await store.get("from.md")), null);
  assert.equal(await (await store.get("to.md")).text(), "move me\n");
});

test("tombstone retains history, restore keeps identity, and a recreated path gets a new generation", async () => {
  const store = new MemoryStore();
  store.seed("gone.md", "keep history\n");
  const before = await readDocument(store, "gone.md");
  await tombstoneDocument(store, "gone.md", { expectedEtag: before.etag });
  await assert.rejects(() => readDocument(store, "gone.md"), /deleted/i);
  const restored = await restoreDocument(store, "gone.md");
  assert.equal(restored.documentId, before.documentId);
  assert.equal(restored.text, before.text);

  await tombstoneDocument(store, "gone.md");
  store.seed("gone.md", "new generation\n");
  const recreated = await readDocument(store, "gone.md");
  assert.notEqual(recreated.documentId, before.documentId);
  await assert.rejects(() => commitUpdate(store, "gone.md", { documentId: before.documentId, update: before.update }), /generation|document/i);
});

test("permanent tombstone purges retained collaboration content but leaves a content-free fence", async () => {
  const store = new MemoryStore();
  store.seed("purge.md", "purge me\n");
  const before = await readDocument(store, "purge.md");
  await tombstoneDocument(store, "purge.md", { expectedEtag: before.etag, permanent: true });
  const keys = [...store.objects.keys()].filter((key) => key.includes(before.documentId));
  assert.deepEqual(keys, []);
  await assert.rejects(() => restoreDocument(store, "purge.md"), /history|retained|unavailable/i);
});
