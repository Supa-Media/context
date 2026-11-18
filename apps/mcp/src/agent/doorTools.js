/**
 * THE SPECIALIST DOORS' TOOL SETS (`doorTurn.js`; the router picks one of them, `graph/nodes/router.js`).
 *
 * Today's Front door (`fd`) holds every tool and answers every text. A specialist door holds a part of them, so a
 * turn the router sends to it cannot reach past its set:
 *
 * - quick: no tools, only the reply-shaping ones (`say_nothing`, `tapback`, `text_progress`) and `need_more_tools`.
 * - read: the read-only tools (an MCP or local definition with `annotations.readOnlyHint`), the web reads (`WEB_READS`),
 *   the reply-shaping ones and `need_more_tools`.
 * - act: every tool, exactly as the Front door holds them: the yes-code confirm and the egress hold are untouched.
 *
 * Enforced in code, not in the prompt: `outsideFor` says which call leaves a door's set, and `turn.js` ends the
 * specialist's run before any call of that round runs. Pure: no imports, so the config and the turn both read it.
 */

/** The door names, in the order the router is offered them. */
export const DOORS = Object.freeze(["quick", "read", "act"]);

/** The Front door's door nodes, by door (`graph/nodes/doors.js`): on the shelf until a Lab draft wires them. */
export const DOOR_NODES = Object.freeze({ quick: "fdQuick", read: "fdRead", act: "fdAct" });

/** The local tool a specialist calls to ask for the whole front door; its call never runs (`turn.js` ends the run first). */
export const NEED_TOOLS = "need_more_tools";

/** A router's pick at or above this confidence sends the turn to its door; below it the Front door answers. */
export const ROUTE_AT = 0.6;

/** The web tools a read door may use: `steer.js` counts them as reads. Nothing else on the web is read-only. */
export const WEB_READS = new Set(["search_web", "open_page", "read_skill", "read_learned_skill", "travel_time"]);

/** Reply-shaping tools every door holds: they end or word a turn, and change nothing else. */
const REPLY_TOOLS = new Set(["say_nothing", "tapback", "text_progress"]);

/** Whether a door may be offered, or may run, a tool of this name and definition. */
export function doorAllows(door, name, definition) {
  if (door === "act") return true;
  if (REPLY_TOOLS.has(name) || name === NEED_TOOLS) return true;
  if (door === "read") return WEB_READS.has(name) || definition?.annotations?.readOnlyHint === true;
  return false;
}

/** The local tool `need_more_tools`: asked for, it hands the turn to the whole front door. */
export const needToolsLocal = {
  tool: {
    name: NEED_TOOLS,
    description: "Call this, and nothing else, when answering well needs a tool you were not given. The full front door takes the turn from there.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  call: async () => ({ content: [{ type: "text", text: "The full front door takes this turn." }] }),
};

const namesOf = (list) => (Array.isArray(list) ? list : []).map((tool) => tool?.name).filter((name) => typeof name === "string");

/**
 * The tools a door is given from a turn's: `{ tools, local, web, allowed }`, where `allowed` is the names the door may
 * dispatch. The act door is the turn's own, unchanged, and every name it carries is allowed.
 *
 * @param {"quick"|"read"|"act"} door
 * @param {{ tools?: object[], local?: Array<{tool: object, call: Function}>, web?: { tools?: object[], call?: Function } | null }} turn
 */
export function narrowForDoor(door, { tools = [], local = [], web = null } = {}) {
  if (door === "act") {
    const names = [...namesOf(tools), ...namesOf(local.map((entry) => entry.tool)), ...namesOf(web?.tools)];
    return { tools, local, web, allowed: new Set(names) };
  }
  const keptTools = tools.filter((tool) => doorAllows(door, tool?.name, tool));
  const keptLocal = [...local.filter((entry) => doorAllows(door, entry?.tool?.name, entry?.tool)), needToolsLocal];
  const keptWeb = web === null ? null : { ...web, tools: (web.tools ?? []).filter((tool) => doorAllows(door, tool?.name, tool)) };
  const names = [...namesOf(keptTools), ...namesOf(keptLocal.map((entry) => entry.tool)), ...namesOf(keptWeb?.tools), ...REPLY_TOOLS, NEED_TOOLS];
  return { tools: keptTools, local: keptLocal, web: keptWeb, allowed: new Set(names) };
}

/**
 * The check `turn.js` makes on each call a specialist's model asks for, before any call of the round runs: a reason
 * (a string) when the call leaves the door, or null. `six` is the six over the turn's full tool list (`sixTools.js`),
 * so a call the six name (`write { action: "save" }`) is judged as the tool it runs. The act door has no check.
 */
export function outsideFor(door, six, allowed) {
  if (door === "act") return () => null;
  return (name, args) => {
    if (name === NEED_TOOLS) return "asked for more tools";
    const resolved = six.resolve(name, args);
    // A call the six refuse is answered in band by the turn, as it is for the front door: not a reason to leave.
    if (resolved.error) return null;
    if (resolved.name === NEED_TOOLS) return "asked for more tools";
    return allowed.has(resolved.name) ? null : `${resolved.name} is outside the ${door} door's tools`;
  };
}

/** A router read's `{ route, sure }` as the turn sees it: `sure` is the pick's confidence, clamped, 0 when missing. */
export function routeOf(out, startedAt, now = Date.now) {
  if (!out || typeof out.route !== "string") return null;
  return { route: out.route, sure: typeof out.sure === "number" && Number.isFinite(out.sure) ? Math.max(0, Math.min(1, out.sure)) : null, ms: now() - startedAt };
}

/**
 * The router, started beside the turn: a promise of `{ route, sure, ms }`, or null when it could not run. `call` makes
 * the node's call (through a wire the config may not draw: a throw is a turn without one). Never rejects.
 */
export function startRoute(call, now = Date.now) {
  const startedAt = now();
  return Promise.resolve()
    .then(() => call())
    .then((out) => routeOf(out, startedAt, now))
    .catch(() => null);
}
