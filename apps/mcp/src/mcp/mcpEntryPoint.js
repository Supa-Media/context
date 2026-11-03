/**
 * THE MCP ENTRY POINT: every step an MCP request takes, timed by name (Dev2,
 * 2026-11-02: "make an mcp entrypoint similar to our tex entrypoint ... only
 * high level functions all timed, and I want to see where the bottleneck
 * is"). The Tex entry point (`agent/texEntryPoint.js`) is the model.
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
 * - `store:<op>`: each call the request's stores make (get, head, put,
 *   delete, list), for the default
 *   workspace and every other one a call opens (`open_other_context`).
 * - `obj:<op>`: each call to a workspace object (`ws.open`, `ws.rows.lookup`,
 *   a body's `get`, ...), through the request's `WORKSPACE_STORE` (`watchObjects`),
 *   so a read the object serves shows its own hop beside the control plane's.
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

/** Analytics Engine takes 250 points a request. */
const MAX_POINTS = 240;
/** A store's own calls, timed by `watch`. */
const STORE_OPS = ["get", "head", "put", "delete", "list"];

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
  let written = false;

  const record = (name, at, state) => {
    const entry = { name, ms: Math.max(0, now() - at), at: at - start, state };
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
    /** Run a step and wait for it. */
    step(name, run) {
      return timed(name, run);
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
          return timed(`store:${op}`, () => inner.apply(this, args));
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
      record("to_response", start, response instanceof Response && response.status >= 500 ? "failed" : "ok");
      if (!written) {
        written = true;
        write(env, points, { surface, call, workspace, client });
      }
      return response;
    },
    /** Every point so far, in the order they finished (tests). */
    points,
  };
  return mcp;
}

/** Which call a JSON-RPC body is: `tools/call:<tool>` for a tool, the method otherwise, `batch` for an array. */
export function callOf(body) {
  if (Array.isArray(body)) return body.length === 1 ? callOf(body[0]) : "batch";
  if (!body || typeof body !== "object" || typeof body.method !== "string") return "unparsed";
  const method = body.method.replace(/[^A-Za-z0-9_/.-]/g, "").slice(0, 48);
  if (method !== "tools/call") return method || "unparsed";
  const tool = typeof body.params?.name === "string" ? body.params.name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40) : "";
  return `tools/call:${tool || "unnamed"}`;
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

function write(env, points, { surface, call, workspace, client }) {
  const dataset = env?.MCP_ENTRY;
  if (!dataset || typeof dataset.writeDataPoint !== "function") return;
  const summed = totals(points);
  for (const entry of summed.slice(0, MAX_POINTS - 1).concat(summed.length >= MAX_POINTS ? [summed[summed.length - 1]] : [])) {
    try {
      dataset.writeDataPoint({ blobs: [surface, call, entry.name, entry.state, client], doubles: [entry.ms, entry.at, entry.count], indexes: [workspace] });
    } catch {
      // Diagnostics never fail a request.
    }
  }
}
