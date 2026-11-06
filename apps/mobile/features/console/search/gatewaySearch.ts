/**
 * The search bar asked through the gateway's `POST /app/search`, the same search an AI client's `search_notes` runs
 * (`apps/mcp/src/http/appSearch.js`; the search revamp, 2026-11-04: one search path for the bar and the AIs).
 *
 * Before this, the bar asked the control plane's `searchContext`, which reached each workspace's search database and
 * Vectorize over HTTP and never the workspace's own object, so the bar and an assistant answered the same words in a
 * different order and at a different speed. The control plane's search stays as the fallback: an answer that does not
 * come, or comes refused or unreadable, is `null`, and the caller asks the control plane exactly as before.
 *
 * Pure apart from `fetch`, so what is sent and what is kept are decided in one place a test can reach. Fields are read
 * by name, never spread.
 */

import type { SearchAnswer } from "../files/browser/supportingTypes";
import type { BlendedAnswer, BlendedResult } from "./results";

/** Long enough for a search across workspaces with meaning; short enough that the fallback still feels like one. */
export const GATEWAY_SEARCH_TIMEOUT_MS = 5_000;

/** `POST /app/search` on the gateway that serves `mcpEndpoint`, or `null` where that is not a web address. */
export function appSearchUrl(mcpEndpoint: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(mcpEndpoint);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${parsed.origin}/app/search`;
}

/** The body one search sends. Built field by field. */
export function appSearchBody(query: string, slug: string, prefix?: string): { query: string; workspaces: string[]; prefix?: string } {
  return { query, workspaces: [`@${slug}`], ...(prefix ? { prefix } : {}) };
}

/**
 * The gateway's answer as the console's `SearchAnswer`, keeping only hits in `@slug`, or `null` for a body this build
 * cannot read: an answer the bar cannot trust is not shown as one.
 */
export function readAppSearch(body: unknown, slug: string): SearchAnswer | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { hits?: unknown }).hits;
  if (!Array.isArray(raw)) return null;
  const hits: SearchAnswer["hits"] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const { workspace, path, title, snippet, meaningOnly } = entry as Record<string, unknown>;
    if (typeof path !== "string" || typeof workspace !== "string") return null;
    if (workspace !== `@${slug}`) continue;
    hits.push({
      path,
      title: typeof title === "string" ? title : "",
      snippets: typeof snippet === "string" && snippet !== "" ? [snippet] : [],
      ...(meaningOnly === true ? { meaningOnly: true } : {}),
    });
  }
  return {
    hits,
    indexMissing: false,
    indexIncomplete: (body as { incomplete?: unknown }).incomplete === true,
    reducedRecall: false,
    reducedRecallNotes: [],
  };
}

/**
 * One search through the gateway with the console grant: refused once, re-minted once, never a loop. `null` when no
 * answer the bar can use came back, for any reason; the reason is dropped, since an error here can carry a URL.
 */
export async function searchThroughGateway(options: {
  url: string;
  token: (refresh: false | { rejected: string }) => Promise<string>;
  query: string;
  slug: string;
  prefix?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<SearchAnswer | null> {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const body = JSON.stringify(appSearchBody(options.query, options.slug, options.prefix));
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), options.timeoutMs ?? GATEWAY_SEARCH_TIMEOUT_MS);
  const send = (accessToken: string) =>
    doFetch(options.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body,
      ...(controller ? { signal: controller.signal } : {}),
    });
  try {
    const token = await options.token(false);
    let response = await send(token);
    if (response.status === 401 || response.status === 403) response = await send(await options.token({ rejected: token }));
    if (!response.ok) return null;
    return readAppSearch(await response.json(), options.slug);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A workspace the search page or ⌘K can search, as the gateway names it. */
export interface GatewayContext {
  workspaceId: string;
  slug: string;
  displayName: string;
}

/**
 * The gateway's answer as the blended search's page (`useBlendedSearch`): one list across the workspaces asked, in
 * the gateway's order, each hit named by the workspace it is in. A hit in a workspace not in `contexts` is dropped;
 * a body this build cannot read is `null`.
 */
export function readAppSearchEverywhere(body: unknown, contexts: readonly GatewayContext[]): BlendedAnswer | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { hits?: unknown }).hits;
  if (!Array.isArray(raw)) return null;
  const bySlug = new Map(contexts.map((context) => [`@${context.slug}`, context]));
  const results: BlendedResult[] = [];
  const counts = new Map<string, number>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const { workspace, path, title, snippet, meaningOnly, loose } = entry as Record<string, unknown>;
    if (typeof path !== "string" || typeof workspace !== "string") return null;
    const context = bySlug.get(workspace);
    if (context === undefined) continue;
    counts.set(context.workspaceId, (counts.get(context.workspaceId) ?? 0) + 1);
    results.push({
      workspaceId: context.workspaceId,
      slug: context.slug,
      displayName: context.displayName,
      path,
      title: typeof title === "string" ? title : "",
      snippet: typeof snippet === "string" ? snippet : "",
      ...(meaningOnly === true ? { meaningOnly: true } : {}),
      ...(loose === true ? { loose: true } : {}),
    });
  }
  const matchCount = Number((body as { matchCount?: unknown }).matchCount);
  return {
    results,
    matchCount: Number.isFinite(matchCount) && matchCount >= results.length ? matchCount : results.length,
    matchCountIsFloor: (body as { matchCountIsFloor?: unknown }).matchCountIsFloor === true,
    cursor: null,
    sources: contexts.map((context) => ({
      workspaceId: context.workspaceId,
      slug: context.slug,
      displayName: context.displayName,
      state: "ok" as const,
      matchCount: counts.get(context.workspaceId) ?? 0,
      matchCountIsFloor: false,
    })),
    searchableCount: contexts.length,
  };
}

/**
 * One search across `contexts` through the gateway, with the console grant of `grantWorkspaceId` (a person's grant
 * reaches every workspace they can, `contextsFor`). `null` when no usable answer came back; the caller asks the
 * control plane.
 */
export async function searchEverywhereThroughGateway(options: {
  url: string;
  token: (refresh: false | { rejected: string }) => Promise<string>;
  query: string;
  contexts: readonly GatewayContext[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<BlendedAnswer | null> {
  if (options.contexts.length === 0) return null;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const body = JSON.stringify({ query: options.query, workspaces: options.contexts.map((context) => `@${context.slug}`) });
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), options.timeoutMs ?? GATEWAY_SEARCH_TIMEOUT_MS);
  const send = (accessToken: string) =>
    doFetch(options.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body,
      ...(controller ? { signal: controller.signal } : {}),
    });
  try {
    const token = await options.token(false);
    let response = await send(token);
    if (response.status === 401 || response.status === 403) response = await send(await options.token({ rejected: token }));
    if (!response.ok) return null;
    return readAppSearchEverywhere(await response.json(), options.contexts);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
