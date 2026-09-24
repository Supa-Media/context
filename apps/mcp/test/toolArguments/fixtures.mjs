/**
 * Shared constants, stubs and request helpers for `test/toolArguments/*.test.mjs`,
 * split out of the single `toolArguments.test.mjs` this file used to be part of.
 */

import { gatewaySourceFiles, soleSource } from "../gatewaySource.mjs";
import worker, { EXISTENCE_MASKED_TOOLS } from "../../src/index.js";
import { META_PROTOCOL_VERSION, MODERN_PROTOCOLS } from "../../src/protocol.js";
import {
  describeName,
  unsupportedKeywords,
  validateArguments,
  VALIDATION_NODE_BUDGET,
} from "../../src/toolArguments.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
} from "../controlPlaneStub.mjs";
import { createWorkerCtx } from "../workerCtx.mjs";

export const S3_ENDPOINT = "https://s3.example-tool-arguments.test";

export const TOKEN_OWNER = `cat_args_owner_${"0".repeat(26)}`;
export const TOKEN_TEAM = `cat_args_team_${"0".repeat(27)}`;

/** The workspace this connection owns, and the one it has nothing to do with. */
export const WORKSPACE_MINE = "ws_args_mine";
export const WORKSPACE_OTHER = "ws_args_other";
export const WORKSPACE_SHARED = "ws_args_shared";

export const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  1-projects: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

export function s3Binding(bucket, key) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: `AKIAEXAMPLEEXAMPLE${key}`,
    secretAccessKey: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE${key}`,
    forcePathStyle: true,
    capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
    status: "active",
  };
}

export async function rpc(env, tokenValue, method, params) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenValue}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
    ctx
  );
  const text = await response.text();
  await settle();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * One tool call. `args` of `undefined` sends no `arguments` member at all,
 * which is what a client calling a tool that requires nothing actually does.
 */
export async function callTool(env, tokenValue, name, args) {
  const params = args === undefined ? { name } : { name, arguments: args };
  return (await rpc(env, tokenValue, "tools/call", params))?.result;
}

/**
 * The same call on the modern transport, which is a different function.
 *
 * `docs/decisions/gateway-protocol.md`, "authority is decided once, never per
 * protocol era": both eras reach `callToolForSession`, and the reason that
 * matters is that a control implemented on one path only is a control an
 * attacker reaches by adding a header. Every check above rides the legacy
 * path — no `MCP-Protocol-Version`, so `handleLegacyMcp` answers it — so the
 * modern one needs asking too, and it is not a copy-paste of the legacy body:
 * it requires the version in a header *and* in `params._meta`, plus the
 * method and the tool name in headers of their own (`modernHeaderMismatch`).
 */
export async function callToolModern(env, tokenValue, name, args) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MODERN_PROTOCOLS[0],
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          ...(args === undefined ? {} : { arguments: args }),
          _meta: { [META_PROTOCOL_VERSION]: MODERN_PROTOCOLS[0] },
        },
      }),
    }),
    env,
    ctx
  );
  const text = await response.text();
  await settle();
  try {
    return JSON.parse(text)?.result;
  } catch {
    return null;
  }
}

/**
 * One tool call sent as raw bytes, for the shapes `JSON.stringify` cannot make.
 *
 * A JavaScript object literal cannot hold two properties of the same name, and
 * `JSON.stringify` turns a number too large for a double into `null` and a
 * lone surrogate into a replacement character. Those are exactly the shapes a
 * hostile client sends, so they have to be written as text.
 */
export async function callToolRaw(env, tokenValue, name, argumentsJson) {
  const { ctx, settle } = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://mcp.context.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenValue}`, "Content-Type": "application/json" },
      body:
        `{"jsonrpc":"2.0","id":1,"method":"tools/call",` +
        `"params":{"name":"${name}","arguments":${argumentsJson}}}`,
    }),
    env,
    ctx
  );
  const text = await response.text();
  await settle();
  try {
    return JSON.parse(text)?.result;
  } catch {
    return null;
  }
}

export const textOf = (result) => result?.content?.[0]?.text || "";

/* -------------------------------------------------------------------------- */
/*  Building a call that is valid apart from the thing under test              */
/* -------------------------------------------------------------------------- */

/** A value that satisfies one property schema, for probing. */
export function sampleValue(name, schema) {
  if (Array.isArray(schema.enum)) return schema.enum[0];
  switch (schema.type) {
    case "string":
      return /path|source|destination|note$|^note|image|id$/.test(name)
        ? "1-projects/probe.md"
        : "probe";
    case "integer":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return true;
    case "array":
      return [sampleObject(schema.items || {})];
    case "object":
      return sampleObject(schema);
    default:
      return "probe";
  }
}

/** The required half of an object schema, filled in with sample values. */
export function sampleObject(schema) {
  const out = {};
  for (const key of schema.required || []) {
    out[key] = sampleValue(key, (schema.properties || {})[key] || { type: "string" });
  }
  return out;
}

/**
 * Another workspace's identifiers, in every name these routes could grow.
 *
 * Deliberately the same shape `encryptionGateway.test.mjs` uses for the two
 * encryption tools, applied here to every tool the gateway offers — because
 * the finding was never about those two.
 */
export const SMUGGLED = {
  workspaceId: WORKSPACE_OTHER,
  workspace_id: WORKSPACE_OTHER,
  workspace: "@other",
  slug: "other",
  bucket: "args-other",
  scope: "private",
  visibility_override: "team",
};

/** The same, naming a workspace that has never existed anywhere. */
export const SMUGGLED_AT_NOBODY = {
  workspaceId: "ws_no_such_workspace_at_all",
  workspace_id: "ws_no_such_workspace_at_all",
  workspace: "@no-such-context-anywhere",
  slug: "no-such-context-anywhere",
  bucket: "args-no-such-bucket",
  scope: "private",
  visibility_override: "team",
};

/* -------------------------------------------------------------------------- */

export {
  gatewaySourceFiles,
  soleSource,
  worker,
  EXISTENCE_MASKED_TOOLS,
  META_PROTOCOL_VERSION,
  MODERN_PROTOCOLS,
  describeName,
  unsupportedKeywords,
  validateArguments,
  VALIDATION_NODE_BUDGET,
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
  createWorkerCtx,
};
