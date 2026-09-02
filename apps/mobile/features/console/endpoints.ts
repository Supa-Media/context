/**
 * The MCP endpoint for one context.
 *
 * ## What it is for, which is not what it was for
 *
 * A connection reaches every context its person is a live member of, and a tool
 * call addresses one by name — so a named URL is no longer how somebody invited
 * into a brain gets at it. What it still decides is where a client *starts*:
 * the grant's own context is what an unaddressed call resolves to, and the URL
 * the client was connected at is what chose it. Somebody who works mostly in a
 * context shared with them connects at its name and never types one again.
 *
 * This file was written a day earlier, when a grant covered exactly one context
 * and the named URL was the only way to reach a second. The reason it refuses
 * rather than guesses has not changed with the feature, because the failure
 * mode has not: see below.
 *
 * ## Why it can answer `null`
 *
 * A URL that names a context the gateway will not read out of it is worse than
 * no URL at all: `splitWorkspacePath` falls back to "no slug", which is the
 * grant's *default* context — so a wrong named URL does not fail, it quietly
 * connects somewhere else, which is the exact confusion this exists to end. So
 * every rule the gateway applies to that first segment is applied here, and
 * anything that does not survive them is `null` and draws no field.
 */

/**
 * The control plane's global name namespace, as the gateway restates it:
 * 2–32 characters of lowercase `a–z`, `0–9` and `-`.
 */
const SLUG_PATTERN = /^[a-z0-9-]{2,32}$/;

/**
 * First segments the gateway reads as a route rather than as a context.
 *
 * A third copy of `session.js`'s `RESERVED_FIRST_SEGMENTS`, and deliberately so
 * for the reason that file gives for keeping its own: no context can be called
 * any of these — `functions/lib/names.ts` reserves them — but a screen that
 * assumed the two lists stayed in sync would print a URL that resolves to a
 * route. Only the four that could pass `SLUG_PATTERN` need to be here; `t` is
 * too short and `.well-known` has a dot in it, so both are already refused.
 */
const RESERVED_FIRST_SEGMENTS = new Set(["mcp", "inbox", "oauth", "granola-webhook"]);

/**
 * `https://mcp.context.lc/mcp` + `seyi` → `https://mcp.context.lc/@seyi/mcp`.
 *
 * `null` when the slug is not one the gateway would read, or when the base
 * endpoint is not the plain `/mcp` this rewrite understands — a self-hosted
 * deployment behind a path prefix cannot take a named URL at all, since the
 * gateway reads the *first* segment as the slug, and inventing one for it would
 * be this screen guessing about somebody else's routing.
 */
export function endpointForContext(endpoint: string, slug: string): string | null {
  const candidate = slug.startsWith("@") ? slug.slice(1) : slug;
  if (!SLUG_PATTERN.test(candidate)) return null;
  if (RESERVED_FIRST_SEGMENTS.has(candidate)) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.pathname !== "/mcp") return null;
  url.pathname = `/@${candidate}/mcp`;
  return url.toString();
}

/** One context, and the URL that connects a client to it. */
export interface ContextEndpoint {
  id: string;
  /** `@seyi` — how the context is named everywhere else in the console. */
  label: string;
  url: string;
}

/**
 * The named endpoint for every context a person can reach.
 *
 * A context whose URL cannot be built is left out rather than shown bare: a
 * short list is honest, and a list padded with the default endpoint would be
 * several rows all quietly pointing at the same context. Callers therefore
 * check the length against `contexts.length` before treating it as complete —
 * the rule `noteCountTruncated` already follows.
 */
export function contextEndpoints(
  endpoint: string,
  contexts: readonly { id: string; slug: string }[],
): ContextEndpoint[] {
  const rows: ContextEndpoint[] = [];
  for (const context of contexts) {
    const url = endpointForContext(endpoint, context.slug);
    if (url === null) continue;
    rows.push({ id: context.id, label: `@${context.slug.replace(/^@/, "")}`, url });
  }
  return rows;
}
