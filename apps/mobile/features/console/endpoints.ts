/**
 * The MCP endpoint for one context.
 *
 * ## Why this exists at all
 *
 * A grant covers exactly one context — `http.ts`'s gateway session hands the
 * worker a `workspaces` *set* with one member in it, and `selectWorkspace`
 * refuses any slug outside that set with a 403 that says nothing. So a person
 * invited into somebody else's brain, whose client is connected on the bare
 * `/mcp`, cannot reach it: their agent is authorized for their own context and
 * asking for another one is refused. That is correct, and it read as broken,
 * because nothing anywhere told them the other half — the gateway has taken
 * `/@<slug>/mcp` since it was written, `session.js` says in as many words that
 * "people see this URL in their MCP client settings", and the console showed
 * one bare URL and called it "one URL for every AI tool, across everything you
 * can reach". Connecting a second time at the named URL is the step, and it was
 * unguessable.
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
