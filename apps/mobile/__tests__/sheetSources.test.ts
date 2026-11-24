/**
 * The Data sources control on a sheet: the call it hands out and where it
 * appears. What a key may do is proved in `apps/convex/__tests__/sheetSources.test.ts`.
 */

import { describe, expect, test } from "@jest/globals";
import { sheetRowsEndpoint, sourceCurl } from "../features/console/files/sheet/SheetSources";

const KEY = `ctxs_${"A".repeat(43)}`;

describe("the call a source key is used with", () => {
  test("goes to the page's own origin, else the platform's", () => {
    expect(sheetRowsEndpoint("https://context-router-pr1.example.workers.dev")).toBe("https://context-router-pr1.example.workers.dev/api/sheets/rows");
    expect(sheetRowsEndpoint(null)).toBe("https://context.lc/api/sheets/rows");
  });

  test("carries the key in a header and never in the URL, with the sheet's columns but its date", () => {
    const call = sourceCurl("https://context.lc/api/sheets/rows", KEY, ["date", "metric", "value"]);
    const [first] = call.split("\n");
    expect(first).not.toContain(KEY);
    expect(call).toContain(`-H "Authorization: Bearer ${KEY}"`);
    const body = JSON.parse(/-d '(.*)'$/m.exec(call)![1]!);
    expect(body).toEqual({ rows: [{ metric: "…", value: "…" }] });
  });
});
