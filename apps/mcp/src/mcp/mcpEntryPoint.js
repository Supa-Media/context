/**
 * THE MCP ENTRY POINT: every step an MCP request takes, timed by name (Dev2,
 * 2026-11-02: "make an mcp entrypoint similar to our tex entrypoint ... only
 * high level functions all timed, and I want to see where the bottleneck
 * is"). The Tex entry point (`agent/texTiming.js`) is the model.
 *
 * `serveMcp` (`http/mcpRoute.js`) runs between the `MCP ENTRY POINT: begin`
 * and `end` markers, and every `await` in there is `mcp.step(name, run)`.
 * `scripts/tex-entry-check.mjs` fails CI (and the Claude Code hook) on a bare
 * `await` between the markers, so nothing joins the path untimed.
 *
 * Below the steps, every call that leaves the Worker is timed too:
 *
 * - `cp:<route>`: each control-plane request, by route (`/gateway/session`,
 *   `/gateway/binding`, ...), through the control plane's `fetchImpl`.
 * - `store:<op>:<kind>`: each call the request's stores make (get, head, put,
 *   delete, list), by the kind of key (`keyClass`), for the default
 *   workspace and every other one a call opens (`open_other_context`).
 * - `obj:<op>`: each call to a workspace object (`ws.open`, `ws.rows.lookup`,
 *   a body's `get`, ...), through the request's `WORKSPACE_STORE` (`watchObjects`),
 *   so a read the object serves shows its own hop beside the control plane's.
 * - `inside:<name>`: a time a workspace object measured on its own clock and
 *   handed back (`ws.collab.replace`'s `took`), so the hop's trip and its work
 *   inside can be told apart.
 *
 * Points are held until the request's workspace is known and written when the
 * response is handed back (`done`), so each is indexed by workspace and one
 * person's calls and everyone's both add up. Dataset `mcp_entry` (binding
 * `MCP_ENTRY`): blobs = "mcp", the call (`tools/call:orient`, `initialize`,
 * `notifications/initialized`, ...), the step, its state (ok, failed), the
 * client's name; doubles = its milliseconds, when it first started (from the
 * request's start) and how many times it ran: one point per step and state,
 * summed over the request (`totals`). A `to_response` point is the whole request. Names, routes
 * and times only, never a path, a query or a word anyone wrote. Without the
 * binding nothing is written.
 */

import { ACTIONS } from "../tools/v2/actions.js";

/** Analytics Engine takes 250 points a request. */
const MAX_POINTS = 240;
/** The least uncovered time worth its own point. */
const UNCOVERED_FLOOR_MS = 5;
/** A store's own calls, timed by `watch`. */
const STORE_OPS = ["get", "head", "put", "delete", "list"];
/** A Cloudflare data center's code. */
const COLO = /^[A-Z]{3}$/;

/**
 * @param {{ MCP_ENTRY?: { writeDataPoint(point: object): void } }} env
 * @param {{ now?: () => number, surface?: string }} [options] `surface` is blob1: "mcp", or "door" for the
 *   control plane's calls through the workspace object's door (`workspaceStore/door.js`), timed the same way.
 */
export function mcpEntry(env, { now = Date.now, surface = "mcp" } = {}) {
  const start = now();
  const points = [];
  let call = "unknown";
  let workspace = "";
  let client = "";
  let colo = "";
  let written = false;

  const record = (name, at, state) => {
    const entry = { name, ms: Math.max(0, now() - at), at: at - start, state, span: true };
    points.push(entry);
    return entry;
  };
  const timed = (name, run) => {
    const at = now();
    let result;
    try {
      result = typeof run === "function" ? run() : run;
    } catch (error) {
      record(name, at, "failed");
      throw error;
    }
    return Promise.resolve(result).then(
      (value) => (record(name, at, "ok"), value),
      (error) => {
        record(name, at, "failed");
        throw error;
      },
    );
  };

  const mcp = {
    /** Which call this request is (`callOf`), once its body is read. */
    set call(value) {
      call = typeof value === "string" && value ? value.slice(0, 96) : "unknown";
    },
    get call() {
      return call;
    },
    /** The workspace every point is indexed by, once the session says. */
    set workspace(value) {
      workspace = typeof value === "string" ? value.slice(0, 96) : "";
    },
    /** The connection's app (Claude, ChatGPT, ...), as the grant names it. */
    set client(value) {
      client = typeof value === "string" ? value.slice(0, 64) : "";
    },
    /**
     * The Cloudflare data center this request ran in (`request.cf.colo`, three capital letters), so a workspace
     * object's round trip can be told apart by how far the gateway ran from it. Anything else is left blank.
     */
    set colo(value) {
      colo = typeof value === "string" && COLO.test(value) ? value : "";
    },
    /** Run a step and wait for it. */
    step(name, run) {
      return timed(name, run);
    },
    /** A time measured elsewhere (a workspace object's own clock), recorded as a point ending now. */
    point(name, ms) {
      if (typeof name !== "string" || !Number.isFinite(ms) || ms < 0) return;
      points.push({ name, ms, at: Math.max(0, now() - start - ms), state: "ok" });
    },
    /** A `fetch` that times each request by its route, never its query: the control plane's `fetchImpl`. */
    fetchFor(prefix, inner = (...args) => globalThis.fetch(...args)) {
      return (input, init) => timed(`${prefix}:${routeOf(input)}`, () => inner(input, init));
    },
    /** Time every call `store` makes from now on, by operation; returns the store. */
    watch(store) {
      if (!store || typeof store !== "object") return store;
      for (const op of STORE_OPS) {
        const inner = store[op];
        if (typeof inner !== "function") continue;
        store[op] = function (...args) {
          return timed(`store:${op}:${keyClass(args[0])}`, () => inner.apply(this, args));
        };
      }
      return store;
    },
    /**
     * `env` with its workspace objects timed: each stub's `fetch` is an `obj:<op>` point, the op from the call's
     * path. A copy, never `env` itself, which other requests share; `env` unchanged without the binding.
     */
    watchObjects(env) {
      const namespace = env?.WORKSPACE_STORE;
      if (!namespace || typeof namespace.idFromName !== "function" || typeof namespace.get !== "function") return env;
      // Ids are made, and placed, by the callers as before (`objectPlace.js`): only the stub `get` hands back is wrapped,
      // with every argument (the location hint among them) passed through unchanged.
      const watched = new Proxy(namespace, {
        get(target, prop) {
          const value = target[prop];
          if (prop !== "get") return typeof value === "function" ? value.bind(target) : value;
          return (...args) => {
            const stub = value.apply(target, args);
            return { fetch: (input, init) => timed(`obj:${opOf(input)}`, () => stub.fetch(input, init)) };
          };
        },
      });
      return { ...env, WORKSPACE_STORE: watched };
    },
    /** The answer is handed back now: write every point, once, and return `response`. */
    done(response) {
      // What no step covered (2026-11-03: archive's steps summed to 180 ms of a 227 ms request): its own point, so the
      // gap is measured in the same request as the whole, not guessed from medians of different samples.
      const uncovered = Math.max(0, now() - start) - coveredMs(points);
      // Under 5 ms is a clock's grain and the work between two awaits, not a gap worth a point.
      if (uncovered >= UNCOVERED_FLOOR_MS) points.push({ name: "uncovered", ms: uncovered, at: 0, state: "ok" });
      record("to_response", start, response instanceof Response && response.status >= 500 ? "failed" : "ok");
      if (!written) {
        written = true;
        write(env, points, { surface, call, workspace, client, colo });
      }
      return response;
    },
    /** Every point so far, in the order they finished (tests). */
    points,
  };
  return mcp;
}

/**
 * Which call a JSON-RPC body is: `tools/call:<tool>` for a tool, the method otherwise, `batch` for an array. A
 * `write`, `manage` or `send` call names its action too (`tools/call:manage:archive`), so one action's time is not
 * averaged with the others' (2026-11-03: archive could not be told from a save). Only a name `ACTIONS` lists is
 * kept, never what a caller wrote.
 */
export function callOf(body) {
  if (Array.isArray(body)) return body.length === 1 ? callOf(body[0]) : "batch";
  if (!body || typeof body !== "object" || typeof body.method !== "string") return "unparsed";
  const method = body.method.replace(/[^A-Za-z0-9_/.-]/g, "").slice(0, 48);
  if (method !== "tools/call") return method || "unparsed";
  const tool = typeof body.params?.name === "string" ? body.params.name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40) : "";
  const action = body.params?.arguments?.action;
  const actions = Object.hasOwn(ACTIONS, tool) ? ACTIONS[tool] : null;
  if (actions !== null && typeof action === "string" && Object.hasOwn(actions, action)) return `tools/call:${tool}:${action}`;
  return `tools/call:${tool || "unnamed"}`;
}

/**
 * What kind of key a store call is about, never the key: `note` (a Markdown path), `file` (any other path), or
 * `.context/<area>` for the workspace's own records (`.context/audit`, `.context/collaboration`, ...), so a request's
 * store calls can be told apart without naming anything anyone wrote. A listing's options object is `list`.
 */
export function keyClass(key) {
  if (typeof key !== "string") return key && typeof key === "object" ? "list" : "other";
  if (key.startsWith(".context/")) {
    const area = key.slice(".context/".length).split("/")[0];
    return /^[a-z][a-z0-9-]{0,23}$/.test(area) ? `.context/${area}` : ".context/other";
  }
  return key.toLowerCase().endsWith(".md") ? "note" : "file";
}

/** A request's route: the path only, ids that look like ids folded to `#`. */
function routeOf(input) {
  try {
    const url = new URL(typeof input === "string" ? input : input?.url ?? String(input));
    return url.pathname.replace(/[0-9a-f]{16,}|[0-9a-f-]{32,}/gi, "#").slice(0, 64);
  } catch {
    return "unknown";
  }
}

/** A workspace object call's op: its path, which is the op's name (`texStore/wire.js` `callTexStore`), never a field. */
function opOf(input) {
  const route = routeOf(input);
  return /^\/[A-Za-z0-9_.-]{1,48}$/.test(route) ? route.slice(1) : "unknown";
}

/**
 * How much of the request the timed steps cover: the union of their spans, so a step inside another (an `obj:` call
 * inside `answer`) or two at once count once. A point recorded with a time from elsewhere (`point`) is not a span here.
 */
function coveredMs(points) {
  const spans = points.filter((entry) => entry.span === true).map((entry) => [entry.at, entry.at + entry.ms]).sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let reach = -Infinity;
  for (const [from, to] of spans) {
    if (to <= reach) continue;
    covered += to - Math.max(from, reach);
    reach = to;
  }
  return covered;
}

/**
 * One point per step and state: the request's total milliseconds in it, when it first started, and how many times it
 * ran. A save makes hundreds of `store:get` calls, and a request writing hundreds of points is sampled down by Analytics
 * Engine until most steps of it are gone (2026-11-03: a save's phases read as one point in eleven). In order of first
 * start, so `to_response` stays last.
 */
export function totals(points) {
  const byStep = new Map();
  for (const entry of points) {
    const key = `${entry.name}\u0000${entry.state}`;
    const held = byStep.get(key);
    if (held === undefined) byStep.set(key, { name: entry.name, state: entry.state, ms: entry.ms, at: entry.at, count: 1 });
    else {
      held.ms += entry.ms;
      held.at = Math.min(held.at, entry.at);
      held.count += 1;
    }
  }
  const all = [...byStep.values()];
  const last = all.findIndex((entry) => entry.name === "to_response");
  if (last >= 0) all.push(all.splice(last, 1)[0]);
  return all;
}

function write(env, points, { surface, call, workspace, client, colo = "" }) {
  const dataset = env?.MCP_ENTRY;
  if (!dataset || typeof dataset.writeDataPoint !== "function") return;
  const summed = totals(points);
  for (const entry of summed.slice(0, MAX_POINTS - 1).concat(summed.length >= MAX_POINTS ? [summed[summed.length - 1]] : [])) {
    try {
      dataset.writeDataPoint({ blobs: [surface, call, entry.name, entry.state, client, colo], doubles: [entry.ms, entry.at, entry.count], indexes: [workspace] });
    } catch {
      // Diagnostics never fail a request.
    }
  }
}
