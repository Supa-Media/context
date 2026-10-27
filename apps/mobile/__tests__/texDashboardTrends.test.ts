/**
 * The Tex dashboard's spend by day (`features/tex/dashboard/trends.ts`): a
 * day Cloudflare no longer keeps is a gap, never a zero, and our estimate
 * stands in when Cloudflare is not connected.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { describe, expect, test } from "@jest/globals";
import type { TexReport } from "../features/tex/dashboard/model";
import { spendByDay, type TexSpend } from "../features/tex/dashboard/trends";

describe("spend by day", () => {
  test("billed spend is blank before the oldest day Cloudflare keeps, and our estimate stands in when it is not connected", () => {
    const report = { turns: { byDay: [{ day: "2026-10-24", turns: 3, costMicroUsd: 2_000_000 }] } } as unknown as TexReport;
    const days = ["2026-08-20", "2026-10-23", "2026-10-24"];
    const billed = { configured: true, error: null, totalUsd: 5, testsUsd: 0, keptFrom: "2026-08-26", days: [{ day: "2026-10-24", usd: 5, requests: 9 }], models: [], jobs: [] } as TexSpend;
    expect(spendByDay(report, billed, days)).toEqual({ values: [null, null, 5], real: true });
    expect(spendByDay(report, { configured: false }, days)).toEqual({ values: [null, null, 2], real: false });
  });
});
