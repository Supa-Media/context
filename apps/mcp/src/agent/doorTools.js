/**
 * THE SPECIALIST DOORS' TOOL SETS (`doorTurn.js`; the router picks one of them, `graph/nodes/router.js`).
 *
 * Today's Front door (`fd`) holds every tool and answers every text. A specialist door holds a part of them, so a
 * turn the router sends to it cannot reach past its set:
 *
 * - quick: no tools, only the reply-shaping ones (`say_nothing`, `tapback`) and `need_more_tools`; no progress line, since
 *   a quick reply needs none and one sent before a hand-over would be texted twice.
 * - read: the read-only tools (an MCP or local definition with `annotations.readOnlyHint`), the web reads (`WEB_READS`),
 *   the reply-shaping ones and `need_more_tools`.
 * - act: every tool, exactly as the Front door holds them: the yes-code confirm and the egress hold are untouched.
 *
 * Enforced in code, not in the prompt: `outsideFor` says which call leaves a door's set, and `turn.js` ends the
 * specialist's run before any call of that round runs. `routeTrusted` says whether a router's read routes at all: the
 * flat cutoff, or a margin over the other classes (`probs`). Pure: no imports, so the config and the turn both read it.
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
  if (name === NEED_TOOLS) return true;
  if (REPLY_TOOLS.has(name)) return door === "read" || name !== "text_progress";
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
  // Over the turn's web object, so what it inherits (the front door's own `call`) still answers.
  const keptWeb = web === null ? null : Object.assign(Object.create(web), { tools: (web.tools ?? []).filter((tool) => doorAllows(door, tool?.name, tool)) });
  const names = [...namesOf(keptTools), ...namesOf(keptLocal.map((entry) => entry.tool)), ...namesOf(keptWeb?.tools), ...[...REPLY_TOOLS].filter((name) => doorAllows(door, name, null)), NEED_TOOLS];
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

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clamp01 = (value) => Math.max(0, Math.min(1, value));

/**
 * Whether a router's read `{ route, sure, probs }` routes the turn. With no `rule` (or one whose `margin` is not a
 * number from 0 to 1) it is the flat cutoff: `sure` at least `ROUTE_AT`. With a margin rule the pick must be the top
 * class of `probs`, not tied, and clear the next class by `margin`; `floor`, when given, also needs the pick at least that likely.
 */
export function routeTrusted(read, rule = null) {
  if (!isPlainObject(read) || typeof read.route !== "string") return false;
  const margin = rule?.margin;
  if (!isFiniteNumber(margin) || margin < 0 || margin > 1) return typeof read.sure === "number" && read.sure >= ROUTE_AT;
  const probs = read.probs;
  if (!isPlainObject(probs)) return false;
  const finite = Object.entries(probs).filter(([, value]) => isFiniteNumber(value));
  if (finite.length < 2) return false;
  const top = probs[read.route];
  if (!isFiniteNumber(top)) return false;
  const others = finite.filter(([key]) => key !== read.route).map(([, value]) => value);
  const second = Math.max(...others);
  if (top < second || top - second <= 0) return false;
  if (top - second < margin - 1e-9) return false;
  const floor = rule.floor;
  return !(isFiniteNumber(floor) && floor >= 0 && floor <= 1 && top < floor - 1e-9);
}

/** A router read's `{ route, sure, probs }` as the turn sees it: `sure` is the pick's confidence, clamped, 0 when missing; `probs` copied only when given. */
export function routeOf(out, startedAt, now = Date.now) {
  if (!out || typeof out.route !== "string") return null;
  const read = { route: out.route, sure: isFiniteNumber(out.sure) ? clamp01(out.sure) : null, ms: now() - startedAt };
  if (isPlainObject(out.probs)) read.probs = Object.fromEntries(Object.entries(out.probs).filter(([, value]) => isFiniteNumber(value)).map(([key, value]) => [key, clamp01(value)]));
  return read;
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
