/** Types for `texRouteSummary.cjs`; see that file for the rules and the reasons. */
export type GoldRoute = "quick" | "read" | "act" | "job";
export type Pick = GoldRoute | "none";
export interface RouteRecord { pick?: string | null; sure?: number; door?: string; fellBack?: string }
export interface RouteRow { convId: string; msgIndex: number; node: string; ok: boolean; ran?: boolean; ambiguous?: boolean; usd?: number; route?: RouteRecord }
export interface RouteBucket { route: GoldRoute | "untagged"; pass: number; total: number; usd: number; usdPerTurn: number }
export interface RouteSummary {
  any: boolean;
  perRoute: RouteBucket[];
  router: { right: number; total: number; confusion: Record<GoldRoute, Record<Pick, number>> };
  fallback: { fellBack: number; specialist: number; total: number };
  costPerTurn: { usd: number; turns: number; perTurn: number };
}
export declare const ROUTES: readonly GoldRoute[];
export declare const PICKS: readonly Pick[];
export declare const SPECIALIST_DOORS: readonly string[];
export declare function goldRouteAt(convs: readonly { id: string; msgs: readonly { labels?: Record<string, unknown> }[] }[]): (convId: string, msgIndex: number) => GoldRoute | null;
export declare function routeSummary(rows: readonly RouteRow[], goldOf: (convId: string, msgIndex: number) => string | null | undefined): RouteSummary;
