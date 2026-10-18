/**
 * Section 3, live half: the workspaces and grants every later section uses,
 * then the census held against `tools/list` — every dispatched tool advertised,
 * every schema closed — and the validator on the one path to a tool.
 *
 * Split out of toolArguments.test.mjs; see fixtures.mjs for the shared helpers.
 */

import { fullToolList, V2_LIST_NAMES } from "../fullToolList.mjs";
import {
  PRIVACY_MANIFEST,
  rpc,
  s3Binding,
  TOKEN_OWNER,
  TOKEN_TEAM,
  unsupportedKeywords,
  validateArguments,
  WORKSPACE_MINE,
  WORKSPACE_OTHER,
  WORKSPACE_SHARED,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runToolArgumentCensusChecks(check, harness) {
  const { GATEWAY, SESSION, functionBody, dispatched, aliases, unlisted, env, s3, controlPlane } = harness;
  controlPlane.addWorkspace(WORKSPACE_MINE, "mine", s3Binding("args-mine", "AA"));
  controlPlane.addWorkspace(WORKSPACE_OTHER, "other", s3Binding("args-other", "BB"));
  // A context this person really is a member of, so a cross-context call can
  // get past routing and reach the validator. Without one, every `context`
  // argument in this file would be answered by the routing refusal and the
  // schema would never be asked.
  controlPlane.addWorkspace(WORKSPACE_SHARED, "shared", s3Binding("args-shared", "CC"));
  await controlPlane.addGrant({
    accessToken: TOKEN_OWNER,
    workspaceId: WORKSPACE_MINE,
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_args_owner",
    userId: "user_args_owner",
    alsoMemberOf: [{ workspaceId: WORKSPACE_SHARED, role: "member" }],
  });
  // A connection at team tier that can still write: `editor`, not `member`.
  // A `member` holds no write anywhere, and the unknown-tool path treats an
  // unrecognised name as writing, so a member would be refused for its scope
  // before the masking question could be asked at all.
  await controlPlane.addGrant({
    accessToken: TOKEN_TEAM,
    workspaceId: WORKSPACE_MINE,
    role: "editor",
    scopes: ["context:read", "context:write"],
    clientId: "mcp_client_args_team",
    userId: "user_args_team",
  });

  const mine = s3.bucketFor("args-mine");
  const other = s3.bucketFor("args-other");
  mine.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "m0" });
  mine.set("index.md", { body: "MINE-INDEX-MARKER", etag: "mi" });
  mine.set("1-projects/probe.md", { body: "MINE-MARKER", etag: "m1" });
  other.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "o0" });
  other.set("index.md", { body: "OTHER-INDEX-MARKER", etag: "oi" });
  other.set("1-projects/probe.md", { body: "OTHER-MARKER", etag: "o1" });
  const shared = s3.bucketFor("args-shared");
  shared.set("privacy.md", { body: PRIVACY_MANIFEST, etag: "c0" });
  shared.set("index.md", { body: "SHARED-INDEX-MARKER", etag: "ci" });
  shared.set("1-projects/probe.md", { body: "SHARED-MARKER", etag: "c1" });

  /*
    Two lists, for two questions. `tools/list` now answers the six v2 tools
    (docs/decisions/gateway-protocol/six-tools.md), so what a client is offered
    is checked against those six. Every older tool is still dispatched and
    still validated, and the census of schemas below is over that FULL list
    (`fullToolList.mjs`), since that is the set the validator must enforce.
  */
  const v2Advertised = (await rpc(env, TOKEN_OWNER, "tools/list", {}))?.result?.tools || [];
  check(
    "the owner's connection is offered exactly the six v2 tools",
    JSON.stringify(v2Advertised.map((tool) => tool.name).sort()) === JSON.stringify(V2_LIST_NAMES)
  );
  const advertised = await fullToolList(env, TOKEN_OWNER);
  check("the owner's connection is offered the whole tool list", advertised.length >= 25);

  const schemas = new Map(advertised.map((tool) => [tool.name, tool.inputSchema]));

  /* ---- every dispatch case is advertised, and every schema is closed ---- */

  const uncovered = dispatched.filter(
    (name) => !schemas.has(aliases.get(name) ?? name) && !unlisted.has(name)
  );
  check(
    "every tool in the dispatch table has an advertised inputSchema",
    uncovered.length === 0
  );

  /*
    And an unlisted one is unlisted, rather than quietly still offered.

    Without this the exemption above would hide the thing it exempts: a name
    in `UNLISTED_TOOLS` that `toolsForSession` forgot to filter would pass
    the census either way, and nobody would learn that the set stopped doing
    anything.
  */
  const stillOffered = [...unlisted].filter((name) => schemas.has(name));
  check(
    `a tool in UNLISTED_TOOLS is absent from tools/list (${stillOffered.join(", ")})`,
    stillOffered.length === 0
  );
  const open = advertised.filter(
    (tool) =>
      tool.inputSchema?.type !== "object" || tool.inputSchema?.additionalProperties !== false
  );
  check(
    "every advertised schema is a closed object, so there is something to enforce",
    open.length === 0
  );
  const unsupported = [...advertised, ...v2Advertised].flatMap((tool) => unsupportedKeywords(tool.inputSchema));
  check(
    "no advertised schema uses a keyword the validator would silently ignore",
    unsupported.length === 0
  );

  /*
    Closedness is checked at every object node, not only at the root.

    The root check above is the one that would have caught the finding this
    file exists for, and it is not the whole of the property: this validator
    enforces exactly what a schema says and nothing more, so an object node
    *below* the root that forgets `additionalProperties: false`, or that says
    `type: "object"` and never says which properties, accepts anything at all
    at that position — silently, and with `tools/list` still reading as
    though it were closed. `move_notes` already has such a node one level
    down; a second array-of-objects tool is the obvious next one, and the
    root check would say nothing about it. The two checks under this comment
    pin that the hole is real, so that nobody deletes the walk as belt and
    braces.
  */
  function walkNodes(schema, where, out = { open: [], bare: [] }) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return out;
    if (schema.type === "object") {
      if (schema.additionalProperties !== false) out.open.push(where);
      if (!schema.properties) out.bare.push(where);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      walkNodes(child, `${where}.${key}`, out);
    }
    if (schema.items) walkNodes(schema.items, `${where}[]`, out);
    return out;
  }
  const walked = advertised.map((tool) => walkNodes(tool.inputSchema, tool.name));
  /* The open `args` every v2 action carries, which is exempt here and checked below. */
  const V2_ARGS = /^(?:search|fetch|write|manage|send)\.args$/;
  const openNodes = walked.flatMap((entry) => entry.open).filter((where) => !V2_ARGS.test(where));
  const barePropertyNodes = walked.flatMap((entry) => entry.bare).filter((where) => !V2_ARGS.test(where));
  check(
    `every object node in every advertised schema is closed, not only the root (${openNodes.join(", ")})`,
    openNodes.length === 0
  );
  check(
    `...and says which properties it takes, so there is something to close over (${barePropertyNodes.join(", ")})`,
    barePropertyNodes.length === 0
  );
  /*
    The six v2 tools are the one place a closed object is not the rule, and
    only at their `args`: an open object an action's own arguments travel in,
    because a capability added next year is a new action, not a new property
    a frozen client copy would strip (`v2/schemas.js`). It is not a hole: the
    translated call is validated against the closed schema of the tool it
    becomes (`toolArgumentRefusal` in `routeToolCall`), so every node below
    `args` is still enforced. Any other open node in a v2 schema fails here.
  */
  const v2Walked = v2Advertised.map((tool) => walkNodes(tool.inputSchema, tool.name));
  const v2Open = v2Walked.flatMap((entry) => [...entry.open, ...entry.bare]);
  check(
    `the six v2 tools are closed everywhere except the open args each action carries (${v2Open.filter((where) => !V2_ARGS.test(where)).join(", ") || "none other"})`,
    v2Open.every((where) => V2_ARGS.test(where))
  );
  check(
    "an object node that forgot `additionalProperties: false` really would take anything",
    validateArguments(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          moves: {
            type: "array",
            items: { type: "object", properties: { source: { type: "string" } } },
          },
        },
      },
      { moves: [{ source: "a.md", workspaceId: "ws_x" }] }
    ) === null
  );
  check(
    "...and one that never said which properties it takes is not walked into at all",
    validateArguments(
      { type: "object", additionalProperties: false, properties: { opts: { type: "object" } } },
      { opts: { workspaceId: "ws_x" } }
    ) === null
  );

  /* ------------ and the validator is on the one path to a tool ---------- */

  /*
    The dispatch lives in `routeToolCall`, which `callToolForSession` runs
    inside `measuredCall` to measure usage around it. The wrapper is checked to be its only caller, so
    the one path is still one path.
  */
  const sessionBody = functionBody(
    SESSION.text,
    "async function routeToolCall(params, store, session, routed)"
  );
  const wrapperBody = functionBody(
    SESSION.text,
    "export async function callToolForSession(params, store, session)"
  );
  check(
    "callToolForSession is the only way into routeToolCall",
    (SESSION.text.match(/routeToolCall\(/g) || []).length === 2 &&
      /measuredCall\(store, session, (params|call), \(routed\) => routeToolCall\(\1, store, session, routed\)\)/.test(wrapperBody)
  );
  /*
    Counted over every module that can reach the dispatcher — the one that
    declares `callTool` and every one that imports it — not over one file,
    so a second dispatch site cannot hide by living in a module of its own.
    `agent/turn.js` has a `callTool` too, and it is not this one: it is the
    callback `handleAgent` hands in, which is `callToolForSession` itself.
  */
  const dispatchSites = GATEWAY.filter(
    (file) =>
      /^(?:export )?async function callTool\(/m.test(file.text) ||
      /import\s*{[^}]*\bcallTool\b[^}]*}\s*from/.test(file.text)
  ).reduce((sum, file) => sum + (file.text.match(/await callTool\(/g) || []).length, 0);
  check(
    "there is exactly one place a tool is dispatched from",
    dispatchSites === 1 && /await callTool\(/.test(sessionBody)
  );
  check(
    "...and the validator runs before it, on that path",
    sessionBody.indexOf("toolArgumentRefusal(") > -1 &&
      sessionBody.indexOf("toolArgumentRefusal(") < sessionBody.indexOf("await callTool(")
  );
  check(
    "...refusing the call rather than annotating it",
    /const badArguments = toolArgumentRefusal\([^)]*\);\s*if \(badArguments\) return toolError\(badArguments\);/.test(
      sessionBody
    )
  );

  Object.assign(harness, { mine, other, advertised, schemas });
}
