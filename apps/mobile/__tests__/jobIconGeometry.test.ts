/**
 * The drawn built-in folder icons (`jobIcons/geometry.ts`): the board's
 * drawing, to the tenth of a unit, every time.
 */
import { describe, expect, test } from "@jest/globals";
import { createHash } from "node:crypto";
import { ROW_ROLES } from "@context/shared/src/folderRoles.cjs";
import {
  DRAWN_JOBS,
  LIST_SIZE_MAX,
  inkFor,
  jobStrokes,
  seedFor,
} from "../features/console/files/jobIcons/geometry";

/**
 * SHA-256 of every path the approved board (`system-folders/source/icons.js`,
 * 2026-10-17) drew, main and dry pass of each stroke in turn, in this job
 * order. A change to a point, the seed, the jitter or the curve changes it.
 */
const BOARD_DIGEST = "c5a57a099d8aa9e026f0bc7f1c6939b11124de6662fde2fe0fd03689b3d40697";
const BOARD_ORDER = ["inbox", "projects", "areas", "resources", "archive", "website", "clients", "teams", "products", "meetings"] as const;

describe("drawn job icons", () => {
  test("every job a folder row can carry has a drawing", () => {
    expect([...DRAWN_JOBS].sort()).toEqual([...ROW_ROLES].sort());
  });

  test("the paths are the board's, exactly", () => {
    const all = BOARD_ORDER.map((job) => jobStrokes(job).flatMap((stroke) => [stroke.d, stroke.dry]).join("|")).join("\n");
    expect(createHash("sha256").update(all).digest("hex")).toBe(BOARD_DIGEST);
  });

  test("the inbox tray's first stroke, spelled out", () => {
    expect(jobStrokes("inbox")[0]!.d).toBe(
      "M10.6 56.1 C11.8 53.8 23.8 26.1 28.2 23.8 C32.6 21.5 67.6 21.6 71.8 23.8 C75.9 26.0 85.3 50.9 86.3 54.8 C87.3 58.8 90.6 77.5 85.4 79.3 C80.2 81.1 18.5 81.9 13.5 79.9 C8.5 77.8 15.8 52.6 15.9 50.5",
    );
  });

  test("deterministic: the same strokes whatever order icons are first drawn in", () => {
    const first = jobStrokes("teams");
    expect(jobStrokes("teams")).toBe(first);
    expect(jobStrokes("teams").map((stroke) => stroke.d)).toEqual(first.map((stroke) => stroke.d));
  });

  test("each job has its own seed, so no two drawings wobble alike", () => {
    expect(new Set(DRAWN_JOBS.map((job) => jobStrokes(job)[0]!.d)).size).toBe(DRAWN_JOBS.length);
    expect(seedFor("inbox")).toBe(7 + 5 * 31 + "i".charCodeAt(0));
  });

  test("every path is a move then cubic curves, inside a little past the box", () => {
    for (const job of DRAWN_JOBS) {
      for (const stroke of jobStrokes(job)) {
        for (const d of [stroke.d, stroke.dry]) {
          expect(d).toMatch(/^M-?\d+\.\d -?\d+\.\d( C(-?\d+\.\d ){5}-?\d+\.\d)+$/);
          const numbers = d.match(/-?\d+\.\d/g)!.map(Number);
          for (const value of numbers) {
            expect(value).toBeGreaterThan(-10);
            expect(value).toBeLessThan(110);
          }
        }
      }
    }
  });

  test("heavier when small, and the dry pass only at heading size", () => {
    expect(inkFor(16)).toEqual({ width: 12, dryOpacity: 0.55 });
    expect(inkFor(18).width).toBe(11);
    expect(inkFor(22).width).toBe(10);
    expect(inkFor(LIST_SIZE_MAX).dryWidth).toBeUndefined();
    expect(inkFor(38)).toEqual({ width: 10, dryWidth: 4.2, dryOpacity: 0.55 });
  });
});
