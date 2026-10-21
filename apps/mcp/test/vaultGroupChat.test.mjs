/**
 * A Tex group chat's turn uses only what its workspace was given as a whole
 * (`src/vault/access.js` `actorAccessOf`). The owner, 2026-10-21: "people
 * can give Tex its own email ... but not through the individual saved
 * logins, since we don't want anyone steering someone's personal
 * information", and "same for cards ... specifically shared for that
 * workspace".
 *
 * Sabotage these and a test here fails:
 *
 *  1. `actorAccessOf` reading a group's actor like any other → "a login the
 *     tagger saved, or was given, never fills from a group".
 *  2. It counting a share to the tagger's handle or group → the same test.
 *  3. It answering "see" for a workspace-wide key → "used, never seen".
 *  4. `fill.js`, `proxy.js` or `tools/vault.js` going back to `mayUse` → the
 *     test for that door.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { actorAccessOf } from "../src/vault/access.js";
import { openForFill, VaultRefused } from "../src/vault/fill.js";
import { proxyFetch, ProxyRefused } from "../src/vault/proxy.js";
import { newEntryId, writeEntry } from "../src/vault/entries.js";
import { toolVaultList, toolVaultViewLink } from "../src/tools/vault.js";

const KEYS = { current: "k1", keys: { k1: Buffer.from(new Uint8Array(32).fill(9)).toString("base64") } };
const WORKSPACE = "ws_band";
const TAGGER = "user_cy";
const GROUP_ACTOR = { workspaceId: WORKSPACE, workspaceKind: "shared", userId: TAGGER, clientId: "context_texts_group", groups: ["@cy", "@crew"] };
const TEXTS_ACTOR = { ...GROUP_ACTOR, clientId: "context_texts" };

function memoryStore() {
  const objects = new Map();
  return {
    async get(key) {
      return objects.has(key) ? { text: async () => objects.get(key) } : null;
    },
    async put(key, value) {
      objects.set(key, String(value));
    },
    async delete(key) {
      objects.delete(key);
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

/** One vault in the band's shared workspace: Cy's own login, one given to Cy's handle, one to a group, and the workspace's. */
async function bandVault() {
  const store = memoryStore();
  Object.defineProperty(store, "encryptionKey", { value: KEYS, enumerable: false });
  const entries = {};
  const add = async (label, meta) => {
    const id = newEntryId();
    entries[label] = id;
    await writeEntry(store, KEYS, WORKSPACE, {
      id,
      meta: { name: label, sites: ["example.com"], createdAt: 1, updatedAt: 1, ...meta },
      secret: { username: `${label}@example.test`, password: `pw-${label}` },
    });
  };
  await add("cys-own", { people: [TAGGER], createdBy: TAGGER });
  await add("to-cy", { people: ["user_ada"], createdBy: "user_ada", shares: [{ to: TAGGER, level: "see" }, { to: "@cy", level: "see" }] });
  await add("to-crew", { people: ["user_ada"], createdBy: "user_ada", shares: [{ to: "@crew", level: "use" }] });
  await add("workspace", { people: ["user_ada"], createdBy: "user_ada", shares: [{ to: "*", level: "see" }] });
  return { store, entries };
}

const as = (store, actor) => Object.assign(store, { actor });
const fill = (store, entryId) => openForFill(store, undefined, { entryId, origin: "https://example.com" });

test("a login the tagger saved, or was given, never fills from a group; the workspace's does", async () => {
  const { store, entries } = await bandVault();
  as(store, GROUP_ACTOR);
  for (const label of ["cys-own", "to-cy", "to-crew"]) {
    await assert.rejects(fill(store, entries[label]), (error) => error instanceof VaultRefused && error.code === "not_yours", label);
  }
  assert.equal((await fill(store, entries.workspace)).password, "pw-workspace");

  // The same person's own texts reach all four, as before.
  as(store, TEXTS_ACTOR);
  for (const label of ["cys-own", "to-cy", "to-crew", "workspace"]) assert.equal((await fill(store, entries[label])).password, `pw-${label}`);
});

test("a group lists only the workspace's keys, and is never shown a value", async () => {
  const { store, entries } = await bandVault();
  as(store, GROUP_ACTOR);
  const listed = (await toolVaultList(store, {})).content[0].text;
  assert.match(listed, /1 saved entry/);
  assert.match(listed, new RegExp(entries.workspace));
  for (const label of ["cys-own", "to-cy", "to-crew"]) assert.doesNotMatch(listed, new RegExp(entries[label]), label);
  // Given to everyone at "see", it is still only used from a group.
  assert.equal(actorAccessOf({ shares: [{ to: "*", level: "see" }] }, GROUP_ACTOR), "use");
  store.vaultLinks = { request: async () => ({ url: "https://context.test/v/x" }) };
  const view = await toolVaultViewLink(store, { entry: entries.workspace });
  assert.equal(view.isError, true);
  assert.match(view.content[0].text, /to use, not to see/);
});

test("a key used through Context from a group is the workspace's too", async () => {
  const { store, entries } = await bandVault();
  as(store, GROUP_ACTOR);
  await assert.rejects(
    proxyFetch(store, { entry: entries["cys-own"], field: "API_KEY", url: "https://api.example.com/v1" }, { allowed: async () => true }),
    (error) => error instanceof ProxyRefused && error.code === "not_found",
  );
  // The workspace's key gets past whose it is, to the next check (it was never pinned for requests).
  await assert.rejects(
    proxyFetch(store, { entry: entries.workspace, field: "API_KEY", url: "https://api.example.com/v1" }, { allowed: async () => true }),
    (error) => error instanceof ProxyRefused && error.code === "not_pinned",
  );
});
