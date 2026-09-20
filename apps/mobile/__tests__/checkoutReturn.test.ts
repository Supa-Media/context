/**
 * THE PATH THE CONTROL PLANE SENDS SOMEBODY BACK TO IS A ROUTE THIS APP HAS.
 *
 * This is the app's half of a guard whose other half is in
 * `apps/convex/__tests__/billing.test.ts`. Neither side can do the job alone,
 * and that is exactly why the bug shipped:
 *
 *  - The control plane knew what string it sent to Stripe and had no way to
 *    ask whether the app routes it.
 *  - The app knew its routes and never saw the string.
 *
 * So `billingStripe.ts` sent a completed payment to
 * `/settings?settings=premium&checkout=done` for as long as that file has
 * existed. **`/settings` is not a route here.** Settings stopped being a route
 * and became an overlay drawn over a context's own page, addressed as
 * `?settings=<section>` — so somebody who had just been charged $5 landed on
 * `+not-found`, and the `checkout=done` the URL carried was read by nobody.
 *
 * The path is built in `@context/shared` now. This file asserts three things
 * about what it builds: the route file exists, the query resolves to the
 * Premium section, and the segment names the context it was built for. And it
 * asserts the negative that documents the defect — that the path which shipped
 * is not a route — because a guard that only checks the new answer would pass
 * again the day somebody "simplifies" the URL back.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `checkoutReturnPath` back to the literal `/settings?...`            1
 *   `checkoutReturnPath` dropping the `@` from the context segment      1
 *   `contextSegment` in `shared` diverging from the console's           1
 */

import { describe, expect, test } from "@jest/globals";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  CHECKOUT_PARAM,
  checkoutOutcomeFrom,
  checkoutReturnPath,
  portalReturnPath,
} from "@context/shared";
import { routeFromFile } from "../features/app/reachability";
import { contextSegment, settingsFromQuery, settingsHref, slugFromSegment } from "../features/console/nav";

const APP = join(__dirname, "..", "app");

/** Every route this app has, as the paths a URL can name. */
function routes(directory: string = APP): string[] {
  const out: string[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (name.startsWith("_") || name.startsWith("+")) continue;
    const full = join(directory, name);
    if (statSync(full).isDirectory()) {
      out.push(...routes(full));
      continue;
    }
    if (!/\.[jt]sx?$/.test(name)) continue;
    out.push(routeFromFile(relative(APP, full)));
  }
  return out;
}

/** `/console/@seyi?settings=premium&checkout=done` → its two halves. */
function split(url: string): { pathname: string; query: URLSearchParams } {
  const [pathname, search] = url.split("?");
  return { pathname: pathname ?? "", query: new URLSearchParams(search ?? "") };
}

/**
 * Does this app route that path?
 *
 * A dynamic segment (`[slug]`) matches one segment of anything, which is what
 * makes `/console/@seyi` a route rather than a literal nobody declared.
 */
function isRoute(pathname: string): boolean {
  const asked = pathname.split("/").filter((segment) => segment !== "");
  return routes().some((route) => {
    const declared = route.split("/").filter((segment) => segment !== "");
    if (declared.length !== asked.length) return false;
    return declared.every(
      (segment, index) =>
        segment === asked[index] || (segment.startsWith("[") && segment.endsWith("]")),
    );
  });
}

describe("where Stripe sends somebody back to", () => {
  test("a settings checkout returns to a route this app has", () => {
    const { pathname, query } = split(checkoutReturnPath("settings", "seyi", "done"));
    expect(isRoute(pathname)).toBe(true);
    expect(settingsFromQuery(query.get("settings") ?? undefined)).toBe("premium");
    expect(checkoutOutcomeFrom(query.get(CHECKOUT_PARAM))).toBe("done");
  });

  test("and it names the context it was built for", () => {
    const { pathname } = split(checkoutReturnPath("settings", "seyi", "done"));
    const segment = pathname.split("/").pop() ?? "";
    expect(segment).toBe(contextSegment("seyi"));
    expect(slugFromSegment(segment)).toBe("seyi");
  });

  test("it is the same address the console itself builds for that section", () => {
    /*
      The drift this whole guard exists to prevent, stated as an equality: if
      the console ever changes how it addresses a settings section, this fails
      here rather than at a customer's return from a payment.
    */
    const url = checkoutReturnPath("settings", "seyi", "done");
    expect(url.startsWith(settingsHref("seyi", "premium"))).toBe(true);
  });

  test("a cancelled checkout returns to the same place, saying so", () => {
    const { pathname, query } = split(checkoutReturnPath("settings", "seyi", "cancelled"));
    expect(isRoute(pathname)).toBe(true);
    expect(checkoutOutcomeFrom(query.get(CHECKOUT_PARAM))).toBe("cancelled");
  });

  test("a first-run checkout returns into first run", () => {
    const { pathname, query } = split(checkoutReturnPath("onboarding", "seyi", "done"));
    expect(pathname).toBe("/welcome");
    expect(isRoute(pathname)).toBe(true);
    expect(checkoutOutcomeFrom(query.get(CHECKOUT_PARAM))).toBe("done");
  });

  test("the billing portal returns to a route this app has", () => {
    const { pathname, query } = split(portalReturnPath("seyi"));
    expect(isRoute(pathname)).toBe(true);
    expect(settingsFromQuery(query.get("settings") ?? undefined)).toBe("premium");
  });

  test("and the path that shipped is not a route, which is why any of this exists", () => {
    expect(isRoute("/settings")).toBe(false);
  });

  test("an outcome this build does not know is no outcome at all", () => {
    // A URL somebody typed, or a newer control plane's word. Neither may put
    // the console into a state it cannot explain.
    for (const raw of ["", "yes", "DONE", "done ", undefined, null]) {
      expect(checkoutOutcomeFrom(raw as string | undefined | null)).toBeNull();
    }
  });
});
