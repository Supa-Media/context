/**
 * WHAT THE GATEWAY TELLS THE CONTROL PLANE ABOUT ITS OWN TRAFFIC.
 *
 * The admin console needs to know how much the product is being used. The
 * gateway is the only thing that sees an MCP tool call, so it is the only
 * thing that can say. What it must not do is say *what the call was*: the
 * record of that already exists, in the customer's own bucket under
 * `.audit/`, and a second copy on our side built for our dashboards is the
 * first non-negotiable being spent on a chart.
 *
 * So the checks here are two questions, and neither is "does the counter
 * work":
 *
 * 1. **What crosses the wire?** A metric name from a fixed table and a
 *    workspace id this request already resolved a grant to. Not the tool's
 *    own name, not an argument, not a path, not a query string — asserted
 *    over the serialized request body, so a field added later is caught by
 *    the shape rather than by somebody remembering to look.
 *
 * 2. **Can it break a tool call?** No, by any route: a control plane that is
 *    down, that 500s, that hangs, or that refuses the report entirely must
 *    leave the answer exactly as it was. A search that worked but was not
 *    counted is a good outcome. A search that failed because a counter was
 *    down is not, and it is the failure mode a reporting hook invites.
 *
 * And one that is easy to get wrong and impossible to see: a **cross-context**
 * call is counted against the context it was routed to, not the one the client
 * happens to be connected to. Otherwise one tenant's figures silently include
 * another tenant's work.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, with the counts as measured
 * rather than as expected — including the two that measured zero, because a
 * sabotage record that only lists the satisfying numbers is decoration.
 *
 *   `reportToolUsage` sending `toolName` instead of the mapped metric   4
 *   the tool name attached to the event as an extra field               2
 *   reporting against `session` rather than the routed `target`         1
 *   `reportUsage` awaited in the request path instead of deferred       1
 *   the `.catch()` removed from the deferred report                     0
 *   the workspace-id guard removed                                      0
 *
 * **The last two are redundant defenses this harness cannot observe**, and
 * they are kept anyway, on the same reasoning `visible.js` gives for
 * `rankedVisibleTo` being unreachable by any end-to-end test and staying.
 *
 *  - The `.catch()` matters in the Workers runtime, where an unhandled
 *    rejection is a logged exception on a completed invocation. Here,
 *    `createWorkerCtx.settle` waits with `Promise.allSettled`, which handles
 *    every rejection by construction — so the harness is *more* forgiving than
 *    production and cannot show the difference.
 *  - The workspace-id guard cannot fire through the public surface at all:
 *    `session.js` refuses to build a session whose `workspaceId` is not a
 *    non-empty string, so there is no request shape that reaches it. It stays
 *    because what it prevents is a per-workspace metric being recorded with no
 *    workspace — a wrong number in the one direction nobody would think to
 *    check — and the cost of keeping it is a branch.
 */

import worker from "../src/index.js";
import {
  CONTROL_PLANE_ORIGIN,
  GATEWAY_SECRET,
  createControlPlaneStub,
  createS3Backend,
} from "./controlPlaneStub.mjs";
import { createWorkerCtx } from "./workerCtx.mjs";

const S3_ENDPOINT = "https://s3.example-usage.test";
const TOKEN = `cat_usage_${"0".repeat(28)}`;
const WS = "ws_usage";

/** Everything readable by a team connection, so the fixtures stay short. */
const PRIVACY_MANIFEST =
  "---\nrole: privacy-manifest\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: team\n\n" +
  "folder_defaults:\n  0-inbox: team\n\nnote_overrides:\n  # none\n```\n\n" +
  "<!-- END BRAIN PRIVACY RULES -->\n";

function s3Binding(bucket, key) {
  return {
    provider: "s3",
    endpoint: S3_ENDPOINT,
    region: "auto",
    bucket,
    accessKeyId: `AKIAEXAMPLEEXAMPLE${key}`,
    secretAccessKey: `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE${key}`,
    forcePathStyle: true,
    capabilities: { conditionalWrite: true },
    status: "active",
  };
}

function env(origin = CONTROL_PLANE_ORIGIN) {
  return { CONTROL_PLANE_URL: origin, GATEWAY_SECRET };
}

function mcpRequest(body) {
  return new Request("https://gateway.test/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** Every `/gateway/usage` body the gateway sent, in order. */
function usageBodies(controlPlane) {
  return controlPlane.calls
    .filter((call) => call.path === "/gateway/usage")
    .map((call) => call.body);
}

/** Flattened `{metric, workspaceId}` pairs across every report. */
function reportedEvents(controlPlane) {
  return usageBodies(controlPlane).flatMap((body) => body.events ?? []);
}

export async function runUsageReportingChecks(check) {
  const s3 = createS3Backend(S3_ENDPOINT);
  const restoreS3 = s3.install();
  const controlPlane = createControlPlaneStub();
  const restoreControlPlane = controlPlane.install();

  controlPlane.addWorkspace(WS, "usage", s3Binding("usage-bucket", "AA"));
  controlPlane.addWorkspace("ws_other", "other", s3Binding("usage-other", "BB"));
  await controlPlane.addGrant({
    accessToken: TOKEN,
    workspaceId: WS,
    role: "owner",
    scopes: ["context:read", "context:write", "context:private"],
    clientId: "mcp_client_usage",
    userId: "user_usage",
    alsoMemberOf: [{ workspaceId: "ws_other", role: "editor" }],
  });

  const bucket = s3.bucketFor("usage-bucket");
  bucket.set("index.md", "# Usage\n\nA note about quokkas.\n");
  bucket.set("privacy.md", PRIVACY_MANIFEST);
  const other = s3.bucketFor("usage-other");
  other.set("index.md", "# Other\n");
  other.set("privacy.md", PRIVACY_MANIFEST);

  async function call(name, args = {}, harness = createWorkerCtx()) {
    const response = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      env(),
      harness.ctx,
    );
    await harness.settle();
    return response;
  }

  // -- what crosses the wire ---------------------------------------------

  controlPlane.calls.length = 0;
  {
    const response = await call("list_notes", {});
    check("a tool call is answered", response.status === 200);
    const events = reportedEvents(controlPlane);
    check(
      "and reported as one mcp.tool_call",
      events.length === 1 && events[0].metric === "mcp.tool_call",
    );
    check("against the context it ran in", events[0].workspaceId === WS);
  }

  controlPlane.calls.length = 0;
  {
    await call("search_notes", { query: "quokkas" });
    const metrics = reportedEvents(controlPlane).map((event) => event.metric);
    check(
      "a search reports both the call and the search",
      metrics.includes("mcp.tool_call") && metrics.includes("search.query"),
    );
  }

  controlPlane.calls.length = 0;
  {
    await call("write_note", {
      path: "0-inbox/usage-check.md",
      content: "# Usage check\n\nbody\n",
    });
    const metrics = reportedEvents(controlPlane).map((event) => event.metric);
    check(
      "a write reports both the call and the write",
      metrics.includes("mcp.tool_call") && metrics.includes("note.write"),
    );
  }

  // THE ONE THAT MATTERS. The report is built from a lookup table, so the
  // tool's own name and its arguments have no route into the request body.
  controlPlane.calls.length = 0;
  {
    await call("search_notes", {
      query: "my private diagnosis and the password hunter2",
      prefix: "2-areas/health",
    });
    const serialized = JSON.stringify(usageBodies(controlPlane));
    check(
      "the query text never leaves the gateway",
      !serialized.includes("diagnosis") && !serialized.includes("hunter2"),
    );
    check("nor does a path the caller named", !serialized.includes("2-areas/health"));
    check("nor the tool's own name", !serialized.includes("search_notes"));

    // Asserted as an exact key set rather than a denylist, because the failure
    // mode is a *new* field arriving and a denylist cannot see one.
    const keys = new Set(reportedEvents(controlPlane).flatMap((e) => Object.keys(e)));
    check(
      "an event carries a metric and a workspace, and nothing else",
      [...keys].sort().join(",") === "metric,workspaceId",
    );
  }

  // -- cross-context attribution ------------------------------------------

  controlPlane.calls.length = 0;
  {
    await call("list_notes", { context: "@other" });
    const events = reportedEvents(controlPlane);
    // Reported against the context the call was ROUTED to. Attributing it to
    // the connection's default would fold one tenant's work into another's
    // figures, invisibly and permanently.
    check(
      "a cross-context call is counted against the context it reached",
      events.length === 1 && events[0].workspaceId === "ws_other",
    );
  }

  // -- a counter cannot break a call --------------------------------------

  controlPlane.calls.length = 0;
  {
    // The control plane answers 404 to this path — the shape a deployment
    // running an older build has. The tool call must be unaffected.
    const restore = controlPlane.install();
    const originalHandle = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/gateway/usage")) {
        return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
      }
      return originalHandle(input, init);
    };
    const response = await call("list_notes", {});
    globalThis.fetch = originalHandle;
    restore();
    check("a 500 from the counter leaves the answer alone", response.status === 200);
    const body = await response.json();
    check("and the answer is a real one", typeof body.result === "object");
  }

  controlPlane.calls.length = 0;
  {
    // A control plane that is simply not there.
    const originalHandle = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/gateway/usage")) throw new Error("network down");
      return originalHandle(input, init);
    };
    const response = await call("list_notes", {});
    globalThis.fetch = originalHandle;
    check("a thrown report leaves the answer alone", response.status === 200);
  }

  {
    // A host with no `waitUntil` — a self-host shim, or this suite's own
    // direct `worker.fetch(request, env)` calls. The report is dropped rather
    // than paid for in latency, and nothing throws.
    controlPlane.calls.length = 0;
    const response = await worker.fetch(
      mcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_notes", arguments: {} },
      }),
      env(),
    );
    check("a host that cannot defer still answers", response.status === 200);
    check(
      "and reports nothing rather than blocking",
      usageBodies(controlPlane).length === 0,
    );
  }

  {
    // A host whose `waitUntil` refuses the work outright.
    controlPlane.calls.length = 0;
    const hostile = {
      ctx: {
        waitUntil() {
          throw new Error("waitUntil refused");
        },
      },
      settle: async () => {},
    };
    const response = await call("list_notes", {}, hostile);
    check("a host that refuses deferral still answers", response.status === 200);
  }

  restoreControlPlane();
  restoreS3();
}
