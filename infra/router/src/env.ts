/** The bindings and variables context-router reads (wrangler.jsonc). */
export interface Env {
  /** Optional legacy upstream for self-hosted configurations without Static Assets. */
  EXPO_ORIGIN?: string;
  /** Cloudflare Static Assets binding. Staging uses it before production cuts over. */
  ASSETS?: Fetcher;
  /** Convex HTTP-actions origin, i.e. `https://<deployment>.convex.site`. */
  CONVEX_ORIGIN?: string;
  HOME_SITE_HANDLE?: string; // whose website/ is the homepage (`homeSite.ts`)
  TEXTS_SIMULATOR?: Fetcher; // staging only (`textsSimulator.ts`)
}
