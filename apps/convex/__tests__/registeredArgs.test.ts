/**
 * EVERY REGISTERED FUNCTION'S ARGS VALIDATOR IS AN OBJECT.
 *
 * Convex refuses a push whose function takes a top-level union (or any
 * non-object validator) as `args` — "Args validator must be an object or
 * any" — and nothing short of a deploy noticed: `tsc` accepts it and
 * `convex-test` runs it. `signupAlerts.send` reached main that way on
 * 2026-10-03 and failed the staging deploy. This reads what the deploy reads.
 *
 * Sabotage: `signupAlerts.send` with `args: alertValidator` (a union) fails
 * this file.
 */

import { expect, test } from "vitest";

const MODULES = import.meta.glob(["../functions/**/*.ts", "../auth.ts", "../http.ts", "../crons.ts"], {
  eager: true,
}) as Record<string, Record<string, unknown>>;

test("no registered function takes a non-object args validator", () => {
  const bad: string[] = [];
  let checked = 0;
  for (const [path, exports] of Object.entries(MODULES)) {
    for (const [name, value] of Object.entries(exports)) {
      const exportArgs = (value as { exportArgs?: () => string } | null)?.exportArgs;
      if (typeof exportArgs !== "function") continue;
      checked += 1;
      const type = (JSON.parse(exportArgs.call(value)) as { type?: string }).type;
      if (type !== "object" && type !== "any") bad.push(`${path}:${name} (${type})`);
    }
  }
  expect(checked).toBeGreaterThan(100);
  expect(bad).toEqual([]);
});
