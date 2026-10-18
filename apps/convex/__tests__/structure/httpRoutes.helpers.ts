import { expect } from "vitest";

/** Moved out of `httpRoutes.test.ts`, which reads them for its unauthenticated routes. */

/**
 * Every response an unauthenticated route can produce, as its field names.
 *
 * A handler has more than one `return` — the success path and an early answer
 * for a malformed body — and a field added to the quiet one reaches the same
 * anonymous crawler on every bad request. Pinning the last literal, or the
 * first, is pinning half a route: measured, `owner: "seyi", notes: 42` on
 * either handler's early return passed all 39 checks here and the whole 1543
 * convex suite.
 *
 * It also asserts that **every** `return` is one of those literals. Without
 * that, the loop is satisfied by a handler that keeps its two `json({…})`
 * calls and adds a third branch returning a bare `new Response` — which was
 * also measured green.
 */
/**
 * A route's implementation, wherever `http.ts` keeps it.
 *
 * Most are written inline. Some are delegated to a module, the arrangement
 * `gatewayRoutes/` uses and which `publicRoutes/` now uses too, and a
 * delegated handler must not fall out of these checks just because it moved:
 * a guard that follows the declaration rather than the code is decor. So the
 * inline form is tried first and the delegated one second, and a name that
 * matches neither fails loudly rather than yielding an empty body — which is
 * the failure mode that would make every assertion below vacuous.
 */
export function routeImplementation(source: string, handlerName: string): string {
  const inline = source.indexOf(`export const ${handlerName} = httpAction(async`);
  if (inline > -1) return source.slice(inline, source.indexOf("\n});", inline));

  const delegated = source.indexOf(`export async function ${handlerName}Handler(`);
  expect(
    delegated,
    `${handlerName} is enumerated but defined neither inline nor as a delegated handler`,
  ).toBeGreaterThan(-1);
  return source.slice(delegated, source.indexOf("\n}\n", delegated));
}

export function unauthenticatedRouteResponses(
  source: string,
  handlerName: string,
): string[][] {
  const body = routeImplementation(source, handlerName);

  const returns = [...body.matchAll(/\breturn\s+([\s\S]{0,20}?)[({]/g)].map(
    (m) => m[0].replace(/\s+/g, " "),
  );
  for (const statement of returns) {
    expect(
      statement,
      `${handlerName} answers with something other than json(...): ${statement}`,
    ).toMatch(/return json\(/);
  }

  const literals = [...body.matchAll(/json\(\{([^{}]*)\}\)/g)];
  expect(
    literals.length,
    `${handlerName} should answer with flat object literals only`,
  ).toBe(returns.length);

  return literals.map(([, literal]) =>
    [...literal.matchAll(/([a-zA-Z_$][\w$]*)\s*:/g)].map((m) => m[1]!).sort(),
  );
}
