/**
 * The Lab's route summary of a run (Dev2, 2026-11-18: "per-route pass rate, router accuracy with a confusion table, the
 * fallback rate and cost per turn"). The arithmetic is `packages/tex/src/texRouteSummary.cjs`, shared with tex_dev's
 * `runs { id }`; this file is the Lab's side of it: each run row's gold route is the Training or Dev set's label on that
 * message (`labels.router.route`), and the words the Runs panel shows. Pure: no React, no Convex.
 */
import { ROUTES, PICKS, goldRouteAt, routeSummary, type RouteSummary } from "@context/tex/src/texRouteSummary.cjs";
import type { RouteRow } from "@context/tex/src/texRouteSummary.d.cts";
import type { Conversation } from "./sets";

export type { RouteSummary };
export { PICKS, ROUTES, goldRouteAt };

/** A run's summary from its rows and the sets the Lab has loaded. */
export function runRouteSummary(rows: RouteRow[], convs: Conversation[]): RouteSummary {
  return routeSummary(rows, goldRouteAt(convs));
}

/** A share as a whole percent, "0%" when there is nothing to share it over. */
export const percentOf = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "0%");

/** The router's accuracy in words: "Router: 3/5 right". */
export const routerWords = (r: { right: number; total: number }) => `Router: ${r.right}/${r.total} right`;

/** The specialist doors in words: "Specialist doors: 2 of 3 turns, 1 fell back (33%)". */
export const specialistWords = (f: { specialist: number; fellBack: number; total: number }) =>
  `Specialist doors: ${f.specialist} of ${f.total} turns, ${f.fellBack} fell back (${percentOf(f.fellBack, f.total)})`;

/** A cost in dollars to three places, as the Runs panel shows every cost. */
export const usdWords = (usd: number) => `$${usd.toFixed(3)}`;

/** Cost per turn in words: "Cost per turn $0.012". */
export const perTurnWords = (c: { perTurn: number }) => `Cost per turn ${usdWords(c.perTurn)}`;
