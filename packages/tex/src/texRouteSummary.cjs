/**
 * The route summary of a Tex run (Dev2, 2026-11-18: "Lab shows per-route pass rate, router accuracy, the fallback rate
 * and cost per turn"). One pure function shared by the Lab (`packages/lab/app/views/runs/`) and tex_dev's
 * `runs { id }` (`packages/lab/gateway/texDev/`), so the two read a run the same way.
 *
 * Rows are a Lab run's rows: `{ convId, msgIndex, node, ok, ran?, ambiguous?, usd?, route? }`, where `route` is the
 * turn's route record as the gateway keeps it (`{ pick, sure, door, fellBack }`, `scripts/tex-lab-run.mjs` routeOf) and
 * `goldOf(convId, msgIndex)` is the gold route ("quick" | "read" | "act" | "job") that the Training or Dev set labels
 * on that message (`labels.router.route`), or null. Rows that did not run, and ambiguous rows (their own gold reply
 * fails), are out of every count here, as they are out of a run's score; cost is spend, so it counts every fd row that ran.
 *
 * Plain CommonJS with no imports, so the Lab's bundle and the MCP read the same rules.
 */

/** The gold routes a set labels, in the order a table shows them. */
const ROUTES = Object.freeze(["quick", "read", "act", "job"]);

/** What the router can pick: a gold route, or "none" when it picked no door. */
const PICKS = Object.freeze([...ROUTES, "none"]);

/** The doors a specialist runs behind (`apps/mcp/src/agent/doorTools.js` DOORS). */
const SPECIALIST_DOORS = Object.freeze(["quick", "read", "act"]);

const usdOf = (sum) => Math.round(sum * 10_000) / 10_000;

/** A row's route record when it has one (an object), else null. */
function routeOf(row) {
  return row?.route && typeof row.route === "object" ? row.route : null;
}

/**
 * The route summary of a run's rows: `{ any, perRoute, router, fallback, costPerTurn }`.
 *   - `any`: whether the run has any fd row with a gold route or any route data (the Lab's "By route" block shows then).
 *   - `perRoute`: `[{ route, pass, total, usd, usdPerTurn }]` per gold route, then `untagged` (an fd row whose message has
 *     no gold route), over the fd rows that ran and are not ambiguous.
 *   - `router`: `{ right, total, confusion }`: over the router node's own rows (`route.pick`) that ran, are not
 *     ambiguous, and have a gold route. An fd row's pick is not the router's, so it is never counted here.
 *     `confusion[gold][picked]`, picked in quick | read | act | job | none.
 *   - `fallback`: `{ fellBack, specialist, total }` over the fd rows with a route: `specialist` when the door was a
 *     specialist's (quick | read | act), `fellBack` when a specialist ran first and handed over (its reason is set).
 *   - `costPerTurn`: `{ usd, turns, perTurn }`: the spend of the fd rows that ran, over how many they are.
 */
function routeSummary(rows, goldOf) {
  const all = Array.isArray(rows) ? rows : [];
  const gold = (row) => {
    const g = typeof goldOf === "function" ? goldOf(row.convId, row.msgIndex) : null;
    return ROUTES.includes(g) ? g : null;
  };
  const fd = all.filter((row) => row?.node === "fd" && row.ran !== false);
  const counted = fd.filter((row) => row.ambiguous !== true);
  const cost = fd.reduce((sum, row) => sum + (Number(row.usd) || 0), 0);

  const perRoute = [...ROUTES, null].map((route) => {
    const inBucket = counted.filter((row) => gold(row) === route);
    const usd = inBucket.reduce((sum, row) => sum + (Number(row.usd) || 0), 0);
    const bucket = { route: route ?? "untagged", pass: inBucket.filter((row) => row.ok === true).length, total: inBucket.length, usd: usdOf(usd), usdPerTurn: inBucket.length > 0 ? usdOf(usd / inBucket.length) : 0 };
    return bucket;
  });

  const confusion = Object.fromEntries(ROUTES.map((g) => [g, Object.fromEntries(PICKS.map((p) => [p, 0]))]));
  // The router's accuracy is its own node's rows only: an fd row's route pick is the front door's read of what the
  // specialists did, not the router's pick, so it never counts here (it counts in `fallback`).
  const routerRows = all
    .filter((row) => row?.node === "router" && row.ran !== false && row.ambiguous !== true)
    .filter((row) => typeof routeOf(row)?.pick === "string" && gold(row) !== null);
  for (const row of routerRows) {
    const picked = PICKS.includes(routeOf(row).pick) ? routeOf(row).pick : "none";
    confusion[gold(row)][picked] += 1;
  }
  const routerRight = routerRows.filter((row) => routeOf(row).pick === gold(row)).length;

  const withRoute = counted.filter((row) => routeOf(row));
  const fallback = {
    fellBack: withRoute.filter((row) => typeof routeOf(row).fellBack === "string" && routeOf(row).fellBack !== "").length,
    specialist: withRoute.filter((row) => SPECIALIST_DOORS.includes(routeOf(row).door)).length,
    total: withRoute.length,
  };

  const costPerTurn = { usd: usdOf(cost), turns: fd.length, perTurn: fd.length > 0 ? usdOf(cost / fd.length) : 0 };
  const any = fd.some((row) => routeOf(row) || gold(row) !== null);

  return {
    any,
    perRoute,
    router: { right: routerRight, total: routerRows.length, confusion },
    fallback,
    costPerTurn,
  };
}

/**
 * The gold route of each message a set's conversations label (`labels.router.route`), as `goldOf(convId, msgIndex)`:
 * the one lookup a run's rows use (the Lab's Runs panel and tex_dev's `byRoute`). Null for a chat, message or label
 * without a gold route, and for a route that is not one of ROUTES.
 */
function goldRouteAt(convs) {
  const byId = new Map((Array.isArray(convs) ? convs : []).map((c) => [c.id, c]));
  return (convId, msgIndex) => {
    const route = byId.get(convId)?.msgs?.[msgIndex]?.labels?.router?.route;
    return ROUTES.includes(route) ? route : null;
  };
}

module.exports = { ROUTES, PICKS, SPECIALIST_DOORS, goldRouteAt, routeSummary };
