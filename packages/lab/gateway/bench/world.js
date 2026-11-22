/**
 * A bench world's shapes, shared by the standing bench objects (`store.js`, `route.js`) and the local object world
 * (`apps/mcp/bench/evals/objectWorld.mjs`), so a note has the same id and the same tree row in both. Workers-safe: Web
 * Crypto only.
 */

import { sha256Hex } from "../../../../apps/mcp/src/controlPlane/client.js";

/** A stable note id from a workspace and a path: the same note gets the same id on every run. */
export async function noteIdOf(workspace, path) {
  const hex = (await sha256Hex(`${workspace}/${path}`)).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The tree rows for `files` (paths), each note under its id in `ids`, and every folder above them. */
export function rowsOf(files, ids) {
  const folders = new Set();
  for (const path of files) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
  }
  const at = 1;
  return [
    ...[...folders].sort().map((path) => ({ id: `d-${path}`, path, kind: "folder", at })),
    ...files.map((path) => ({ id: `f-${ids.get(path)}`, noteId: ids.get(path), path, kind: "file", storageKey: `notes/${ids.get(path)}.md`, etag: `e-${ids.get(path).slice(0, 8)}`, at })),
  ];
}

/** A bench person's user id. */
export const benchUserOf = (person) => `user_bench_${String(person).toLowerCase().replace(/[^a-z0-9]/g, "")}`;

/**
 * The binding a bench workspace's object keeps sealed: a bucket that does not exist, because a bench workspace's
 * notes live in its object only (`notesHome: "object"`), and the rules it is read under.
 */
export function benchBindingAnswer({ workspaceId, name, kind, rules }) {
  return {
    binding: { workspaceId, provider: "r2", endpoint: "https://s3.bench-objects.invalid", bucket: `bench-objects-${name}`.slice(0, 63), accessKeyId: `AKIABENCHOBJ${String(name.length).padStart(4, "0")}`, secretAccessKey: "benchObjectSecretNotReal", capabilities: { conditionalWrite: true }, notesHome: "object", status: "active" },
    searchIndex: null,
    meaningIndex: null,
    encryptionKey: null,
    rotation: null,
    noteCap: null,
    managedEncryption: null,
    privacy: rules,
    idLayout: "keys",
    features: {},
    keyed: true,
    kind,
  };
}

/** A world's key: 32 hex characters (`remoteBench.mjs` `remoteWorldKey`). */
export const WORLD_KEY = /^[0-9a-f]{32}$/;
/** Most copies of one world. */
export const MAX_COPIES = 64;

/** The prefix every workspace id of one copy of one world starts with. */
export const benchIdPrefix = (world, copy) => `wb${copy}_${world.slice(0, 12)}_`;

/** One bench workspace's id in one copy of one world: at most 64 characters, as a workspace object's id is. */
export const benchWorkspaceId = (world, copy, name) => `${benchIdPrefix(world, copy)}${String(name).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}`;
