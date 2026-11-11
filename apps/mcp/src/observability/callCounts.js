/**
 * One Analytics Engine point per call, on both sides of a workspace object, so a busy minute names who made it
 * (docs/decisions/observability/call-counts.md). On 2026-11-06 one workspace object took 18,624 requests in a
 * minute against a usual 300 to 500, and nothing could say which client sent them.
 *
 * - The gateway writes `in` for every request it answers: the route as a fixed name, the client's kind and the status
 *   class. Never a path, a slug, an id or a token: a route this file does not name is `page` (a workspace's own path)
 *   or `other`.
 * - A workspace object writes `object` for every call it answers: the op, and who asked (`gateway`, `convex` through
 *   the door, `socket` for an upgrade, `tex` for a person's Tex), indexed by the object's own id, the one Cloudflare's
 *   Durable Object analytics name.
 *
 * - A workspace object writes `note` for every note whose text it saved: `created` for a new note, `edited` for a
 *   changed one (a save of the same bytes is not counted), and the note's id (`notes/<id>.md`, never its name or
 *   path), so the staff dashboard counts notes created and edited (tex.lc/admin, `apps/convex/.../texStats.ts`).
 *
 * - The door writes `door` for every control-plane call it lets through: the op and the caller's own fixed label
 *   (`x-door-caller`: `file:<operation>`, `tree`, `facts`, or the calling module's name), indexed by workspace.
 *
 * Writing a point never throws and never waits: a missing binding (tests, self-hosting) writes nothing.
 */

/** Route names, first match wins. Each is a fixed string, so nothing a client sends reaches the dataset. */
const ROUTES = [
  ["/agent/machine/run", "agent/machine/run"],
  ["/agent/machine/", "agent/machine"],
  ["/agent/", "agent"],
  ["/agent", "agent"],
  ["/internal/workspace-store", "internal/workspace-store"],
  ["/internal/", "internal"],
  ["/machines/socket", "machines/socket"],
  ["/machines/", "machines"],
  ["/mcp", "mcp"],
  ["/collaboration", "collaboration"],
  ["/presence/tree", "presence/tree"],
  ["/presence/access", "presence/access"],
  ["/presence/ticket", "presence/ticket"],
  ["/presence", "presence"],
  ["/approvals", "approvals"],
  ["/agent-activity", "agent-activity"],
  ["/gateway/", "gateway"],
  ["/oauth", "oauth"],
  ["/.well-known/", "well-known"],
  ["/note/", "note"],
  // The app's file operations and search bar (2026-11-09: a 404 on every delete hid under `other`).
  ["/files/", "files"],
  ["/app/", "app"],
];

/** The route a request's path falls under, as a fixed name. */
export function routeName(pathname) {
  if (typeof pathname !== "string") return "other";
  for (const [prefix, name] of ROUTES) {
    const matches = prefix.endsWith("/") ? pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(`${prefix}/`);
    if (matches) return name;
  }
  if (pathname.startsWith("/@")) {
    // A route addressed to a workspace (`/@name/files/trash`) counts as that route; anything else there is a page.
    const rest = pathname.indexOf("/", 2);
    const routed = rest > 0 ? routeName(pathname.slice(rest)) : "other";
    return routed === "other" || routed === "page" ? "page" : routed;
  }
  return "other";
}

/** The kind of client from its user agent, coarse on purpose: a browser, a script, or none. */
export function clientKind(userAgent) {
  if (typeof userAgent !== "string" || userAgent === "") return "none";
  const ua = userAgent.toLowerCase();
  if (ua.startsWith("mozilla/")) return "browser";
  if (ua.includes("claude-code") || ua.includes("claude code")) return "claude-code";
  if (ua.startsWith("node") || ua.includes("undici")) return "node";
  if (ua.startsWith("python")) return "python";
  if (ua.startsWith("curl")) return "curl";
  if (ua.includes("convex")) return "convex";
  return "other";
}

const statusClass = (status) => (Number.isInteger(status) && status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : "none");

/** The gateway's point for one request it answered. */
export function countInbound(env, request, status, ms) {
  try {
    const dataset = env?.CALL_COUNTS;
    if (!dataset || typeof dataset.writeDataPoint !== "function") return;
    const route = routeName(new URL(request.url).pathname);
    dataset.writeDataPoint({
      indexes: [route],
      blobs: ["in", route, clientKind(request.headers.get("user-agent")), statusClass(status)],
      doubles: [1, Number.isFinite(ms) ? ms : 0],
    });
  } catch {
    // Counting never fails a request.
  }
}

/** Who asked a workspace object, from where the call came in. */
export function objectCaller(request, { tex = false } = {}) {
  if (tex) return "tex";
  if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") return "socket";
  try {
    const url = new URL(request.url);
    if (url.hostname === "workspace-store.internal" && url.pathname === "/door") return "convex";
  } catch {
    return "other";
  }
  return "gateway";
}

const OP = /^[a-z][a-z0-9._-]{0,63}$/i;

/** A workspace object's point for one call it answered; `op` is kept only when it is a plain op name. */
export function countObjectCall(env, objectId, op, caller) {
  try {
    const dataset = env?.CALL_COUNTS;
    if (!dataset || typeof dataset.writeDataPoint !== "function") return;
    dataset.writeDataPoint({
      indexes: [typeof objectId === "string" ? objectId.slice(0, 96) : "unknown"],
      blobs: ["object", typeof op === "string" && OP.test(op) ? op : "other", caller],
      doubles: [1],
    });
  } catch {
    // Counting never fails a call.
  }
}

const LABEL = /^[a-z][a-zA-Z0-9:._-]{0,47}$/;

/** The door's point for one control-plane call: the op and the caller's own label (`file:<operation>`, `tree`, ...). */
export function countDoorCall(env, workspaceId, op, caller) {
  try {
    const dataset = env?.CALL_COUNTS;
    if (!dataset || typeof dataset.writeDataPoint !== "function") return;
    dataset.writeDataPoint({
      indexes: [typeof workspaceId === "string" ? workspaceId.slice(0, 96) : "unknown"],
      blobs: ["door", typeof op === "string" && OP.test(op) ? op : "other", typeof caller === "string" && LABEL.test(caller) ? caller : "unlabelled"],
      doubles: [1],
    });
  } catch {
    // Counting never fails a call.
  }
}

const NOTE_KEY = /^notes\/([A-Za-z0-9-]{1,128})\.md$/;

/** A workspace object's point for one note saved: created or edited, by the note's id alone. A non-note key is skipped. */
export function countNoteWrite(env, objectId, key, { created, changed }) {
  try {
    const dataset = env?.CALL_COUNTS;
    if (!dataset || typeof dataset.writeDataPoint !== "function") return;
    const note = typeof key === "string" ? NOTE_KEY.exec(key) : null;
    if (note === null || changed !== true) return;
    dataset.writeDataPoint({
      indexes: [typeof objectId === "string" ? objectId.slice(0, 96) : "unknown"],
      blobs: ["note", created === true ? "created" : "edited", note[1]],
      doubles: [1],
    });
  } catch {
    // Counting never fails a write.
  }
}
