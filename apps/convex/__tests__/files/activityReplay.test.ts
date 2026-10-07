/**
 * What the console map's Today / This week replay reads: `files.listActivity`
 * with `since`, and the `[from, to]` pairs a `moved` line now carries.
 *
 * The pairs are needed because `paths` is forwarded to where a note is now —
 * a move's own line reads `[to, to]` by the time anyone sees it — and they are
 * the one part of a line that is NOT forwarded, so they are re-checked on both
 * ends for every reader below owner.
 */

import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import { asUser } from "../fixtures.helpers";
import { activitySince } from "../../functions/lib/filesFns/noteReads";
import type { ActivityEntry } from "../../functions/lib/activity";
import { fixture, share } from "./fixtures.helpers";

const BODY = `# Week\n\n${"a".repeat(600)}\n`;

describe("listActivity for a replay", () => {
  test("a console move's line says where the note came from, unforwarded", async () => {
    const f = await fixture();
    const owner = asUser(f.t, f.owner);
    await owner.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/week.md",
      text: BODY,
    });
    await owner.action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: "1-projects/week.md",
      to: "2-areas/week.md",
    });
    const entries = await owner.action(api.functions.files.listActivity, {
      workspaceId: f.workspaceId,
    });
    const moved = entries.find((entry) => entry.kind === "moved");
    expect(moved?.moves).toEqual([["1-projects/week.md", "2-areas/week.md"]]);
    // `paths` is still forwarded, as every reader has always had it.
    expect(moved?.paths).toEqual(["2-areas/week.md", "2-areas/week.md"]);
  });

  test("a member gets a pair only while both of its ends are visible to them", async () => {
    const f = await fixture();
    const owner = asUser(f.t, f.owner);
    await share(f);
    for (const path of ["1-projects/sub/x.md", "1-projects/sub/keep.md"]) {
      await owner.action(api.functions.files.writeNote, { workspaceId: f.workspaceId, path, text: BODY });
    }
    await owner.action(api.functions.files.moveEntry, {
      workspaceId: f.workspaceId,
      from: "1-projects/sub/x.md",
      to: "1-projects/x.md",
    });
    const member = asUser(f.t, f.reader);
    const before = await member.action(api.functions.files.listActivity, { workspaceId: f.workspaceId });
    expect(before.find((entry) => entry.kind === "moved")?.moves).toEqual([
      ["1-projects/sub/x.md", "1-projects/x.md"],
    ]);

    // The folder the note left goes private. The line stays — the note it
    // points at is still shared — and the pair naming that folder goes.
    await owner.action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/sub",
      visibility: "private",
    });
    const after = await member.action(api.functions.files.listActivity, { workspaceId: f.workspaceId });
    const moved = after.find((entry) => entry.kind === "moved");
    expect(moved?.paths).toEqual(["1-projects/x.md", "1-projects/x.md"]);
    expect(moved?.moves).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain("sub/x.md");

    // The owner keeps the whole record.
    const asOwner = await owner.action(api.functions.files.listActivity, { workspaceId: f.workspaceId });
    expect(asOwner.find((entry) => entry.kind === "moved")?.moves).toEqual([
      ["1-projects/sub/x.md", "1-projects/x.md"],
    ]);
  });

  test("`since` cuts the feed at a time, through the real action", async () => {
    const f = await fixture();
    const owner = asUser(f.t, f.owner);
    await owner.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/today.md",
      text: BODY,
    });
    const all = await owner.action(api.functions.files.listActivity, {
      workspaceId: f.workspaceId,
      since: 0,
    });
    expect(all.length).toBeGreaterThan(0);
    const future = await owner.action(api.functions.files.listActivity, {
      workspaceId: f.workspaceId,
      since: Date.now() + 60 * 60 * 1000,
    });
    expect(future).toEqual([]);
  });
});

describe("activitySince", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  // 120 lines, one an hour, newest first.
  const entries: ActivityEntry[] = Array.from({ length: 120 }, (_, index) => ({
    at: new Date(now - index * 60 * 60 * 1000).toISOString(),
    kind: "revised",
    paths: [`1-projects/n${index}.md`],
    n: 1,
    vis: "team",
    by: "@sayo",
    via: null,
    note: null,
  }));

  test("with no `since`, the old default of 50", () => {
    expect(activitySince(entries, {})).toHaveLength(50);
  });

  test("with `since` and no limit, every line in the window — a week is not cut at 50", () => {
    const week = activitySince(entries, { since: now - 7 * DAY });
    expect(week).toHaveLength(120);
    const today = activitySince(entries, { since: now - DAY });
    expect(today).toHaveLength(25);
    expect(today.every((entry) => Date.parse(entry.at) >= now - DAY)).toBe(true);
  });

  test("a limit still applies inside the window, and never past what the file keeps", () => {
    expect(activitySince(entries, { since: now - 7 * DAY, limit: 10 })).toHaveLength(10);
    expect(activitySince(entries, { since: 0, limit: 10_000 })).toHaveLength(120);
  });
});
