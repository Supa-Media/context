/**
 * A Lab copy keeps the main its source started from (`engine/state.ts` `forkFromMain`), so Promote merges only the
 * copy's own changes (`scripts/tex-lab-merge.mjs`): a copy of main takes main's stamp, a copy of a draft keeps that
 * draft's, and a copy of an older draft with no stamp keeps when that draft was made, never today's main.
 *
 * Sabotage record (temporary local edit, reverted, 2026-11-17): dropping the `madeAt` line fails the older-draft case.
 */
import { describe, expect, test } from "@jest/globals";
import { forkFromMain, lab } from "../features/tex/lab/engine/state";
import { MAIN_STAMP } from "../features/tex/lab/data/graph";
import type { LabVersion } from "../features/tex/lab/types";

const draft = (over: Partial<LabVersion>): LabVersion => ({ ...lab.versions[0], id: "vsource", name: "Source", createdAt: 1000, ...over }) as LabVersion;

describe("a Lab copy's base", () => {
  test("a copy of main takes main's stamp", () => {
    lab.cur = { ...lab.versions[0] };
    forkFromMain();
    expect(lab.cur.base).toBe(MAIN_STAMP);
    expect(lab.cur.madeAt).toBeUndefined();
  });

  test("a copy of a draft keeps that draft's stamp", () => {
    lab.cur = draft({ base: "c0123456789abcd" });
    forkFromMain();
    expect([lab.cur.base, lab.cur.madeAt]).toEqual(["c0123456789abcd", undefined]);
  });

  test("a copy of an older draft with no stamp keeps when that draft was made", () => {
    lab.cur = draft({ base: undefined });
    forkFromMain();
    expect([lab.cur.base, lab.cur.madeAt]).toEqual([undefined, 1000]);
    // and a copy of that copy keeps the same time
    lab.versions.push({ ...lab.cur, id: "vcopy" });
    lab.cur = { ...lab.cur, id: "vcopy", createdAt: 5000 };
    forkFromMain();
    expect(lab.cur.madeAt).toBe(1000);
  });
});
