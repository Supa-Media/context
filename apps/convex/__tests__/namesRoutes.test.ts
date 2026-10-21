/**
 * A ROUTE IS A NAME, AND A NAME IS A MAILBOX.
 *
 * Split out of `names.test.ts` on 2026-10-20, when that file grew past the
 * architecture guard's review threshold. One responsibility: every first path
 * segment this product serves — the gateway's and the app's — must be a name
 * the namespace refuses to hand out.
 *
 * Both checks read their set out of the source that defines it rather than
 * restating it beside it, so a route added next year fails here on the day it
 * is added rather than on the day somebody claims it.
 */

import { describe, expect, test } from "vitest";
import { ROUTE_SEGMENTS } from "@context/shared";
import { GATEWAY_ROUTE_FLOOR } from "@context/shared/src/gatewayRouteSegments";

import { gatewayReservedFirstSegments } from "./gatewayRoutes.helpers";
import { routerNotPages } from "./routerPages.helpers";
import { validateName } from "../functions/lib/names";

describe("a route a name could otherwise be", () => {
  /**
   * ...AND THE LIST IS DERIVED FROM THE GATEWAY, NOT RESTATED BESIDE IT.
   *
   * The check above is five strings somebody typed. It cannot notice a route
   * the gateway adds, and it did not notice one the gateway already had:
   * `granola-webhook` is in `RESERVED_FIRST_SEGMENTS` in `apps/mcp/src/
   * workspacePath.js` and `validateName("granola-webhook")` returned `{ok: true}`,
   * so anybody could claim it as a username or a workspace slug.
   *
   * Three things were relying on that not being so. The console's
   * `endpoints.ts` keeps a third copy of the gateway's list and defends it in
   * as many words -- "no context can be called any of these --
   * `functions/lib/names.ts` reserves them" -- which was simply false. The
   * gateway reads `/@granola-webhook/mcp`'s first segment as a route, so that
   * context is unaddressable by name and the console silently drops it from
   * the endpoint list it presents as complete. And this file's own neighbour
   * sixty lines down records the same mistake being made once already, with
   * `@inbox` reserved while `@0-inbox` claimed cleanly.
   *
   * The reserved list is not cosmetic here: CLAUDE.md's "Ingestion is on the
   * apex" makes it a mail-interception control, so a product route that is
   * also a claimable handle is a product route that is also somebody's
   * mailbox.
   *
   * So the gateway's set is read out of its own source. A segment it reserves
   * that this namespace would nonetheless hand out is a failure here, and a
   * fifth route added next year fails on the day it is added rather than on
   * the day somebody claims it.
   */
  test("reserves every gateway route a name could otherwise be", () => {
    const reservedByGateway = gatewayReservedFirstSegments();
    expect(
      reservedByGateway.size,
      "the gateway's RESERVED_FIRST_SEGMENTS could not be read",
    ).toBeGreaterThanOrEqual(GATEWAY_ROUTE_FLOOR);

    const claimable = [...reservedByGateway].filter(
      (segment) => validateName(segment).ok,
    );
    expect(
      claimable,
      "these name a gateway route and can still be claimed",
    ).toEqual([]);
  });

  /**
   * The same rule, for the routes the app itself serves.
   *
   * The test above holds the gateway's first segments; the app's own routes
   * were never held to anything. They are the same hazard in the same two
   * ways: `context.lc/vault` is a product surface, and — ingestion being on
   * the apex — `vault@context.lc` is a mailbox. `tex` was reserved by name
   * (2026-10-10) for exactly that reason while `texts` beside it was not,
   * which is the drift a derived check exists to refuse.
   *
   * `ROUTE_SEGMENTS` is not restated here: the route-tree walker in
   * `feedbackReport.ts` fails on a static route missing from it, so a route
   * added next year fails here on the day it is added rather than on the day
   * somebody claims its mailbox.
   */
  test("reserves every app route a name could otherwise be", () => {
    const claimable = [...ROUTE_SEGMENTS].filter((segment) => validateName(segment).ok);
    expect(claimable, "these name an app route and can still be claimed").toEqual([]);
  });

  /**
   * And the third list: the apex paths the router serves itself.
   *
   * The two checks above hold the gateway's first segments and the app's
   * routes. The router keeps its own — `/api`, `/og`, `/ingest` — in
   * `NOT_PAGES`, and nothing held those to the namespace: `/ingest` arrived
   * on 2026-10-21 and `/og` had been there far longer, both claimable as
   * handles and so as mailboxes on the apex.
   *
   * A floor on the size, like the gateway check, so a list this cannot read
   * fails here rather than passing by checking nothing.
   */
  test("reserves every apex route the router keeps off the homepage", () => {
    const notPages = routerNotPages();
    expect(notPages.size, "the router's NOT_PAGES could not be read").toBeGreaterThanOrEqual(25);
    const claimable = [...notPages].filter((segment) => validateName(segment).ok);
    expect(claimable, "the router serves these and a name could still be one").toEqual([]);
  });
});
