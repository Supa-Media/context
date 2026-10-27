import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * NOTHING SCHEDULES A GOOGLE COPY PASS.
 *
 * Mail, calendar and chat are read from Google when asked and never copied
 * into a person's notes (owner, 2026-10-21; `docs/decisions/communications/
 * live-not-copied.md`). The pass that copied them (`googleSync.sweepDueGoogleSyncs`
 * and the `googleForwardSync` operation it starts) is kept so a kind can be
 * added back on purpose, which makes it easy to start again by accident: a
 * cron line, a push notification or a pass's own drain. This reads the source
 * for anything that schedules it.
 *
 * Sabotage record (2026-10-21, applied, run, reverted): putting the cron entry
 * back fails the first check; putting `runAfter(..., sweepDueGoogleSyncs)` back
 * in `lib/googlePush/pending.ts` fails the second, and so (2026-10-22) does
 * putting it back in `lib/googleSync/drain.ts`.
 */

const ROOT = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "_generated" || name === "node_modules") return [];
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

describe("copying stopped", () => {
  test("no cron runs the Google sync sweep", () => {
    const crons = readFileSync(join(ROOT, "crons.ts"), "utf8");
    expect(crons).not.toMatch(/internal\.functions\.googleSync\.sweepDueGoogleSyncs/);
  });

  test("nothing schedules the sweep, not even a pass that just reported", () => {
    const schedulers = sources(join(ROOT, "functions"))
      .filter((path) => /(runAfter|runAt)\([^)]*sweepDueGoogleSyncs/s.test(readFileSync(path, "utf8")))
      .map((path) => relative(ROOT, path));
    // A pass's own drain kept passes in flight at the stop starting each other, a day later (2026-10-22).
    expect(schedulers).toEqual([]);
  });
});
