/**
 * HOW OFTEN EACH CONTEXT MODULE CHANGES, AND THE ORDER A STEP'S MODULES RUN IN BECAUSE OF IT (Dev2, 2026-11-20).
 *
 * The prompt cache reads a request from its first byte up to the first byte that changed, so a module that changes
 * often costs every module after it. A step's reads (`texConfig.json` `nodes[].ctx`) are therefore never sent in the
 * order they are listed when that order puts a module that changes more often above one that changes less: each module
 * has a change tier, and `runOrder` sorts the list by tier, keeping the listed order within a tier. The Lab shows the
 * order a step runs in and says so loudly when it differs from the order it is listed in (`runMoves`).
 *
 * Tiers, from the top of the request down:
 *  - `fixed`: the same until a deploy (prompt words, the map, the capability list, tools, Training).
 *  - `summary`: changes rarely, at most once a day (the about-me note, the day summaries, the chat's group list).
 *  - `grows`: the chat word for word, which only ever adds at its end, so its earlier part stays cached.
 *  - `text`: new with every text (the time, the ask, a draft, the turn's ledger, a step's output).
 *
 * A Lab draft may set a module's tier (`modules[key].changes`); otherwise its default is below. A module this file has
 * never heard of is `text`, the safe guess: put last, it can cost nothing it isn't already costing.
 */

const TIERS = ["fixed", "summary", "grows", "text"];

const TIER_NAMES = {
  fixed: "Same until a deploy",
  summary: "Changes rarely (at most daily)",
  grows: "Grows at its end",
  text: "Changes every text",
};

const DEFAULTS = {
  prompt: "fixed",
  map: "fixed",
  caps: "fixed",
  tools: "fixed",
  skills: "fixed",
  skillsAll: "fixed",
  own: "fixed",
  about: "summary",
  groups: "summary",
  devShare: "summary",
  groupBrief: "summary",
  brief: "summary",
  hist: "grows",
  histAll: "grows",
  threads: "text",
  recent: "text",
  date: "text",
  ask: "text",
  draft: "text",
  ledger: "text",
};

/** The default tier of one reads entry, by its key or its shape. */
function defaultChange(key) {
  if (typeof key !== "string") return "text";
  if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return DEFAULTS[key];
  if (key.startsWith("p-") || key.startsWith("train:")) return "fixed";
  if (key.startsWith("summaries:")) return "summary";
  if (key.startsWith("chat:")) return "grows";
  return "text"; // `out:<step>` and anything new
}

/** A reads entry's tier: the draft's own setting when it names a known tier, else the default. */
function changeOf(key, modules) {
  const set = modules && typeof modules === "object" ? modules[key]?.changes : undefined;
  return TIERS.includes(set) ? set : defaultChange(key);
}

/** The reads as they run: sorted by tier, the listed order kept within a tier. Never changes the list it is given. */
function runOrder(ctx, modules) {
  const list = Array.isArray(ctx) ? ctx.filter((entry) => typeof entry === "string") : [];
  return list
    .map((key, at) => ({ key, at, tier: TIERS.indexOf(changeOf(key, modules)) }))
    .sort((a, b) => a.tier - b.tier || a.at - b.at)
    .map((entry) => entry.key);
}

/**
 * Each entry that runs somewhere other than where it is listed: `{ key, listed, runs, changes }`, positions counted
 * from 1, in the order they run. Empty when the list is already in run order.
 */
function runMoves(ctx, modules) {
  const list = Array.isArray(ctx) ? ctx.filter((entry) => typeof entry === "string") : [];
  const ran = runOrder(list, modules);
  const moves = [];
  ran.forEach((key, i) => {
    const listed = list.indexOf(key);
    if (listed !== i) moves.push({ key, listed: listed + 1, runs: i + 1, changes: changeOf(key, modules) });
  });
  return moves;
}

module.exports = { TIERS, TIER_NAMES, defaultChange, changeOf, runOrder, runMoves };
