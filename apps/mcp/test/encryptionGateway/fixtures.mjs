/**
 * Shared fixtures for `test/encryptionGateway/*.test.mjs`, split out of the
 * original encryptionGateway.test.mjs — see encryptionGateway.test.mjs for
 * the module overview and the sabotage-testing record.
 */

import worker from "../../src/index.js";
import { R2Store } from "../../src/store/r2.js";
import { withLogicalDelete } from "../../src/store/logicalDelete.js";
import {
  FENCE_LANGUAGE,
  indexableText,
  isEncryptedNote,
  parseEncryptedNote,
} from "../../src/encryption.js";
import { parseLinks } from "../../src/links.js";
import { CONTROL_PLANE_ORIGIN, GATEWAY_SECRET, createControlPlaneStub } from "../controlPlaneStub.mjs";
import { createWorkerCtx } from "../workerCtx.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The pinned passphrase-locked note, shared with `encryptionPassphrase.test.mjs`.
 *
 * One fixture, two suites: that file proves the bytes open with the right key,
 * this one proves the gateway cannot open them and cannot destroy them either.
 */
export const PASSPHRASE_VECTOR = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../encryptionPassphraseVector.fixtures.json", import.meta.url)),
    "utf8",
  ),
);

/** A bucket stub with the same shape `test.mjs`'s has, and no more. */
export function makeBucket() {
  const objects = new Map();
  const controls = { crashAfterEncryptedWrite: null };
  let etagCounter = 0;
  const encoder = new TextEncoder();
  return {
    objects,
    bucket: {
      async get(key) {
        if (!objects.has(key)) return null;
        const { bytes, etag } = objects.get(key);
        return {
          etag,
          text: async () => new TextDecoder().decode(bytes),
          arrayBuffer: async () => bytes.slice().buffer,
        };
      },
      async put(key, value, options = {}) {
        const expected = options?.onlyIf?.etagMatches;
        if (expected && objects.get(key)?.etag !== expected) return null;
        const bytes =
          typeof value === "string"
            ? encoder.encode(value)
            : value instanceof Uint8Array
              ? new Uint8Array(value)
              : new Uint8Array(value);
        const etag = `e${++etagCounter}`;
        objects.set(key, { bytes, etag });
        if (controls.crashAfterEncryptedWrite === key &&
            isEncryptedNote(new TextDecoder().decode(bytes))) {
          controls.crashAfterEncryptedWrite = null;
          throw new Error("injected crash after ciphertext write");
        }
        return { etag };
      },
      async delete(key) {
        objects.delete(key);
      },
      async list({ prefix = "", delimiter, cursor, limit = 1000 } = {}) {
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
        const start = cursor ? keys.findIndex((key) => key > cursor) : 0;
        if (start === -1) return { objects: [], delimitedPrefixes: [], truncated: false };
        const listed = [];
        const prefixes = new Set();
        let index = start;
        for (let spent = 0; index < keys.length && spent < limit; index += 1, spent += 1) {
          const key = keys[index];
          const remainder = key.slice(prefix.length);
          const slash = delimiter ? remainder.indexOf(delimiter) : -1;
          if (slash !== -1) {
            prefixes.add(`${prefix}${remainder.slice(0, slash + 1)}`);
            continue;
          }
          listed.push({
            key,
            size: objects.get(key).bytes.length,
            uploaded: new Date(),
            etag: objects.get(key).etag,
          });
        }
        const truncated = index < keys.length;
        return {
          objects: listed,
          delimitedPrefixes: [...prefixes],
          truncated,
          cursor: truncated ? keys[index - 1] : undefined,
        };
      },
    },
    controls,
  };
}

export const PRIVACY = [
  "---",
  "role: privacy-manifest",
  "version: 1",
  "---",
  "",
  "<!-- BEGIN BRAIN PRIVACY RULES -->",
  "",
  "```yaml",
  "default_visibility: private",
  "",
  "folder_defaults:",
  "  index.md: team",
  "  1-projects: team",
  "  1-projects/vault: private",
  "",
  "note_overrides:",
  "```",
  "",
  "<!-- END BRAIN PRIVACY RULES -->",
  "",
].join("\n");

/**
 * Two obviously fake AES-256 keys, base64.
 *
 * They are literals rather than generated so that "A's key does not open B's
 * note" is a claim about *these two* keys on every run, and so that a failure
 * is reproducible rather than a coin flip.
 */
export const KEY_A = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=";
export const KEY_B = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";

export const SECRET_BODY = [
  "---",
  "updated: 2026-09-07",
  "tags: [payroll]",
  "---",
  "",
  "# Compensation review",
  "",
  "The number is forty-two, and it links to [[1-projects/alpha]].",
  "",
].join("\n");


export {
  worker,
  R2Store,
  withLogicalDelete,
  FENCE_LANGUAGE,
  indexableText,
  isEncryptedNote,
  parseEncryptedNote,
  parseLinks,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createWorkerCtx,
};

/**
 * The arrange phase shared by every section: two in-memory buckets, two
 * workspaces holding two different keys (plus a third, keyless one), their
 * grants, the env that wires them together, the `call`/`textOf`/`readA`/
 * `readB` helpers every section uses to talk to the worker, and the two
 * `withLogicalDelete` stores seeded with the notes every section after
 * section (1) finds already there.
 */
export async function createEncryptionGatewayHarness() {
  const a = makeBucket();
  const b = makeBucket();
  const controlPlane = createControlPlaneStub();
  const restore = controlPlane.install();

  controlPlane.addWorkspace("ws_enc_a", "enca", {
      provider: "r2-binding",
      bindingName: "BUCKET_A",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
      encryptionKey: { current: "k1", keys: { k1: KEY_A } },
    });
    controlPlane.addWorkspace("ws_enc_b", "encb", {
      provider: "r2-binding",
      bindingName: "BUCKET_B",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
      encryptionKey: { current: "k1", keys: { k1: KEY_B } },
    });
    // The third context is the ordinary one: a workspace that has never
    // encrypted anything, so the control plane sends no key at all. Every
    // context in the product is this one today, which is why it gets its own
    // grant rather than being simulated by a flag.
    controlPlane.addWorkspace("ws_enc_none", "encnone", {
      provider: "r2-binding",
      bindingName: "BUCKET_A",
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "active",
    });

    const OWNER_A = "cat_test_enc_owner_a_000000000000000";
    const TEAM_A = "cat_test_enc_team_a_0000000000000000";
    const OWNER_B = "cat_test_enc_owner_b_000000000000000";
    const KEYLESS = "cat_test_enc_keyless_0000000000000000";
    await controlPlane.addGrant({
      accessToken: OWNER_A,
      workspaceId: "ws_enc_a",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_enc_owner_a",
      userId: "user_enc_owner_a",
    });
    await controlPlane.addGrant({
      accessToken: TEAM_A,
      workspaceId: "ws_enc_a",
      role: "editor",
      scopes: ["context:read", "context:write"],
      clientId: "mcp_client_enc_team_a",
      userId: "user_enc_team_a",
    });
    await controlPlane.addGrant({
      accessToken: OWNER_B,
      workspaceId: "ws_enc_b",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_enc_owner_b",
      userId: "user_enc_owner_b",
    });
    /*
      THE DESKTOP MACHINE GRANT, exactly as `apps/desktop/src/main/connect.ts`
      asks for it: `DESKTOP_SCOPE` is `"context:write context:private"` and
      deliberately NOT `context:read`, because — its words — "a laptop
      credential that could read every note its owner ever wrote is past what
      the feature is worth."

      It is minted with no approve screen at all: the console page answers the
      parked request with the session it already holds. So this is the widest
      credential in the product that nobody was ever shown a screen for, and
      what it may reach is worth pinning rather than assuming.
    */
    const MACHINE_A = "cat_test_enc_machine_a_000000000000000";
    await controlPlane.addGrant({
      accessToken: MACHINE_A,
      workspaceId: "ws_enc_a",
      role: "owner",
      scopes: ["context:write", "context:private"],
      clientId: "mcp_client_enc_machine_a",
      userId: "user_enc_machine_a",
    });
    await controlPlane.addGrant({
      accessToken: KEYLESS,
      workspaceId: "ws_enc_none",
      role: "owner",
      scopes: ["context:read", "context:write", "context:private"],
      clientId: "mcp_client_enc_keyless",
      userId: "user_enc_keyless",
    });

    const env = {
      CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
      GATEWAY_SECRET,
      NATIVE_BINDINGS: "BUCKET_A,BUCKET_B",
      BUCKET_A: a.bucket,
      BUCKET_B: b.bucket,
    };

    let id = 0;
    async function call(token, name, args = {}) {
      const { ctx, settle } = createWorkerCtx();
      const res = await worker.fetch(
        new Request("https://x/mcp", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++id,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
        env,
        ctx,
      );
      const result = (await res.json()).result;
      await settle();
      return result;
    }
    const textOf = (result) => result?.content?.[0]?.text ?? "";
    const readA = (key) => {
      const entry = a.objects.get(key);
      return entry ? new TextDecoder().decode(entry.bytes) : undefined;
    };
    const readB = (key) => {
      const entry = b.objects.get(key);
      return entry ? new TextDecoder().decode(entry.bytes) : undefined;
    };

    // Match the production factory: R2's physical API has no conditional
    // delete, so the effective store supplies CAS-safe logical deletion.
    const storeA = withLogicalDelete(new R2Store(a.bucket));
    const storeB = withLogicalDelete(new R2Store(b.bucket));
    for (const store of [storeA, storeB]) {
      await store.put("privacy.md", PRIVACY);
      await store.put("index.md", "# front page\n");
    }
    await storeA.put("1-projects/alpha.md", "# alpha\n\npoints at [[1-projects/team-secret]]\n");
    await storeA.put("1-projects/team-secret.md", SECRET_BODY);
    await storeA.put("1-projects/vault/private-secret.md", SECRET_BODY);

  return {
    a,
    b,
    controlPlane,
    restore,
    env,
    call,
    textOf,
    readA,
    readB,
    storeA,
    storeB,
    OWNER_A,
    TEAM_A,
    OWNER_B,
    KEYLESS,
    MACHINE_A,
  };
}
