/**
 * The console's Usage page as data (`features/admin/console/pages/usageData.ts`), in the staff console mock's
 * wording (`staff-console.html`). Pure functions: no React, no native modules.
 */

import { describe, expect, test } from "@jest/globals";
import {
  DAY_MS,
} from "../features/admin/console/pages/homeData";
import {
  ago,
  analyticsNote,
  captureRows,
  clientRows,
  eventRows,
  journeys,
  usageTiles,
  type AnalyticsLike,
  type ClientLike,
  type Series,
} from "../features/admin/console/pages/usageData";

const NOW = 1_000_000_000_000;
const DAY = DAY_MS;

// -- usageData ---------------------------------------------------------------------------------------------------------

describe("usageTiles", () => {
  const ready: AnalyticsLike = {
    connected: true,
    error: null,
    sites: [
      { host: "context.lc", visits: 1240, visitors: 530, priorVisits: 1107 },
      { host: "tex.lc", visits: 860, visitors: 410, priorVisits: 656 },
    ],
    time: { sessions: 110, people: 60, medianSeconds: 250, totalSeconds: 61 * 3600 },
    priorTime: { sessions: 100, people: 60, medianSeconds: 212, totalSeconds: 50 * 3600 },
  };
  const byKey = (tiles: ReturnType<typeof usageTiles>) => Object.fromEntries(tiles.map((t) => [t.key, t]));

  test("tile figures carry no thousands separator, as the artifact's 90-day tiles read", () => {
    const big: AnalyticsLike = {
      ...ready,
      sites: [{ host: "context.lc", visits: 3472, visitors: 1484, priorVisits: 3100 }],
      time: { sessions: 110, people: 60, medianSeconds: 250, totalSeconds: 1714 * 3600 },
    };
    const t = byKey(usageTiles(big));
    expect(t.ctx?.value).toBe("3472");
    expect(t.ctx?.detail).toBe("1484 visitors · ");
    expect(t.hours?.value).toBe("1714");
  });

  test("the four tiles read as the mock does", () => {
    const t = byKey(usageTiles(ready));
    expect(t.ctx).toEqual({
      key: "ctx",
      label: "context.lc visits",
      value: "1240",
      detail: "530 visitors · ",
      delta: { text: "+12%", good: true },
    });
    expect(t.tex?.value).toBe("860");
    expect(t.tex?.delta).toEqual({ text: "+31%", good: true });
    expect(t.session).toEqual({
      key: "session",
      label: "Typical session",
      value: "4m 10s",
      detail: " · active time",
      delta: { text: "+38s", good: true },
    });
    expect(t.hours).toEqual({
      key: "hours",
      label: "Hours in the app",
      value: "61",
      detail: "1.8 sessions a person",
    });
  });

  test("a site change that fell is bad when visits are the good direction", () => {
    const fell: AnalyticsLike = { ...ready, sites: [{ host: "context.lc", visits: 100, visitors: 5, priorVisits: 200 }] };
    expect(byKey(usageTiles(fell)).ctx?.delta).toEqual({ text: "-50%", good: false });
  });

  test("a site with no prior visits has no delta", () => {
    const fresh: AnalyticsLike = { ...ready, sites: [{ host: "tex.lc", visits: 5, visitors: 2, priorVisits: 0 }] };
    expect(byKey(usageTiles(fresh)).tex?.delta).toBeUndefined();
  });

  test("a session that got shorter reads as a negative change", () => {
    const shorter: AnalyticsLike = { ...ready, time: { ...ready.time!, medianSeconds: 200 }, priorTime: { ...ready.priorTime!, medianSeconds: 212 } };
    expect(byKey(usageTiles(shorter)).session?.delta).toEqual({ text: "-12s", good: false });
  });

  test("without analytics every tile is an em dash", () => {
    for (const a of [undefined, { connected: false } as AnalyticsLike, { connected: true, error: "down" } as AnalyticsLike]) {
      const t = usageTiles(a);
      expect(t.map((x) => x.value)).toEqual(["—", "—", "—", "—"]);
      expect(t.every((x) => x.delta === undefined)).toBe(true);
    }
  });

  test("a missing site on a ready answer reads an em dash", () => {
    const t = byKey(usageTiles({ ...ready, sites: [] }));
    expect(t.ctx).toEqual({ key: "ctx", label: "context.lc visits", value: "—", detail: "" });
  });

  test("hours and sessions need people to divide by", () => {
    const none: AnalyticsLike = { ...ready, time: { sessions: 3, people: 0, medianSeconds: 60, totalSeconds: 3600 } };
    expect(byKey(usageTiles(none)).hours?.detail).toBe("");
  });

  test("no prior time means no session delta", () => {
    expect(byKey(usageTiles({ ...ready, priorTime: null })).session?.delta).toBeUndefined();
  });
});

describe("analyticsNote", () => {
  test("is null while loading and when PostHog answered", () => {
    expect(analyticsNote(undefined)).toBeNull();
    expect(analyticsNote({ connected: true, error: null, sites: [], time: null, priorTime: null })).toBeNull();
  });

  test("says PostHog is not connected in our words", () => {
    expect(analyticsNote({ connected: false })).toBe("PostHog is not connected on this deployment.");
  });

  test("shows the error when it is connected but failed", () => {
    expect(analyticsNote({ connected: true, error: "rate limited" })).toBe("rate limited");
  });
});

describe("eventRows", () => {
  const series = (metric: string, counts: number[], total: number): Series => ({
    metric,
    total,
    points: counts.map((count, i) => ({ day: `2026-11-${String(i + 1).padStart(2, "0")}`, count })),
  });
  const notes = (daily: number[], total: number) => ({ total, daily });

  test("one row per counter, in the mock's order", () => {
    expect(eventRows([], [], null).map((r) => r.label)).toEqual([
      "Tool calls",
      "Searches",
      "Notes written",
      "Notes created",
      "AI client connections",
      "App sessions",
      "Sign-ins",
    ]);
  });

  test("the total is the window's, read from totals", () => {
    const [row] = eventRows([series("mcp.tool_call", [1, 2], 4120)], [series("mcp.tool_call", [1, 2], 3)], null);
    expect(row).toMatchObject({ label: "Tool calls", total: 4120 });
  });

  test("the trend and today against yesterday come from the 14-day daily series", () => {
    const [row] = eventRows([series("mcp.tool_call", [1], 5)], [series("mcp.tool_call", [90, 100, 110], 300)], null);
    expect(row).toMatchObject({ total: 5, trend: [90, 100, 110], change: { text: "+10%", good: true } });
  });

  test("a one-day window with a single totals point still gets today vs yesterday from the daily series", () => {
    const totals = [series("search.query", [4], 4)];
    const daily = [series("search.query", [40, 50], 90)];
    const row = eventRows(totals, daily, null).find((r) => r.label === "Searches");
    expect(row).toEqual({ label: "Searches", total: 4, trend: [40, 50], change: { text: "+25%", good: true } });
  });

  test("a fall today is a negative change", () => {
    const [row] = eventRows([], [series("mcp.tool_call", [100, 89], 189)], null);
    expect(row?.change).toEqual({ text: "-11%", good: false });
  });

  test("today against yesterday is null when yesterday was zero", () => {
    const [row] = eventRows([], [series("mcp.tool_call", [0, 5], 5)], null);
    expect(row?.change).toBeNull();
  });

  test("a single daily point has no yesterday, so no change", () => {
    const [row] = eventRows([], [series("mcp.tool_call", [7], 7)], null);
    expect(row?.change).toBeNull();
  });

  test("the trend is the last fourteen days at most", () => {
    const counts = Array.from({ length: 20 }, (_, i) => i + 1);
    const [row] = eventRows([], [series("mcp.tool_call", counts, 210)], null);
    expect(row?.trend).toHaveLength(14);
    expect(row?.trend).toEqual(counts.slice(-14));
    expect(row?.trend[0]).toBe(7);
  });

  test("a short trend is kept whole", () => {
    const [row] = eventRows([], [series("mcp.tool_call", [1, 2, 3], 6)], null);
    expect(row?.trend).toEqual([1, 2, 3]);
  });

  test("a counter with no series reads zero with no trend and no change", () => {
    const row = eventRows([], [], null).find((r) => r.label === "Searches");
    expect(row).toEqual({ label: "Searches", total: 0, trend: [], change: null });
  });

  test("notes created take their total and trend from the workspace counts, not the usage series", () => {
    const rows = eventRows(
      [series("notes.created", [9], 9)],
      [series("note.write", [1], 1)],
      notes([10, 12, 15], 214),
    );
    const created = rows.find((r) => r.label === "Notes created");
    expect(created).toEqual({ label: "Notes created", total: 214, trend: [10, 12, 15], change: { text: "+25%", good: true } });
  });

  test("notes created keep the last fourteen days of their own trend", () => {
    const daily = Array.from({ length: 16 }, (_, i) => i + 1);
    const created = eventRows([], [], notes(daily, 136)).find((r) => r.label === "Notes created");
    expect(created?.trend).toEqual(daily.slice(-14));
    expect(created?.change).toEqual({ text: "+7%", good: true });
  });

  test("two days with nothing on either read +0%, as the artifact's flat rows do", () => {
    const row = eventRows([], [series("search.query", [0, 0, 0], 0)], null).find((r) => r.label === "Searches");
    expect(row?.change).toEqual({ text: "+0%", good: true });
  });

  test("notes created with no workspace counts reads zero", () => {
    const created = eventRows([], [], null).find((r) => r.label === "Notes created");
    expect(created).toEqual({ label: "Notes created", total: 0, trend: [], change: null });
  });
});

describe("journeys", () => {
  test("nothing without a ready analytics answer", () => {
    expect(journeys(undefined)).toEqual([]);
    expect(journeys({ connected: false })).toEqual([]);
  });

  test("a funnel missing from the answer is skipped, the rest are kept", () => {
    const a: AnalyticsLike = {
      connected: true,
      error: null,
      sites: [],
      time: null,
      priorTime: null,
      funnels: [
        {
          id: "context_signin",
          steps: [
            { key: "code_sent", people: 140 },
            { key: "code_submitted", people: 121 },
            { key: "signed_in", people: 109 },
          ],
        },
      ],
    };
    const got = journeys(a);
    expect(got.map((j) => j.id)).toEqual(["context_signin"]);
    expect(got[0]?.title).toBe("Context sign-in");
  });

  test("no funnels on the answer skips them all", () => {
    expect(journeys({ connected: true, error: null, sites: [], time: null, priorTime: null })).toEqual([]);
  });

  test("steps are labelled, shares are of the first step, and a missing step counts zero", () => {
    const a: AnalyticsLike = {
      connected: true,
      error: null,
      sites: [],
      time: null,
      priorTime: null,
      funnels: [
        {
          id: "context_signin",
          steps: [
            { key: "code_sent", people: 140 },
            { key: "code_submitted", people: 121 },
          ],
        },
      ],
    };
    const [j] = journeys(a);
    expect(j?.title).toBe("Context sign-in");
    expect(j?.steps.map((s) => [s.label, s.people, s.pct])).toEqual([
      ["Sent a code", 140, 100],
      ["Typed the code", 121, 86],
      ["Signed in", 0, 0],
    ]);
    expect(j?.steps[1]?.width).toBeCloseTo((121 / 140) * 100, 10);
  });

  test("a first step of zero leaves every share at zero", () => {
    const a: AnalyticsLike = {
      connected: true,
      error: null,
      sites: [],
      time: null,
      priorTime: null,
      funnels: [{ id: "context_setup", steps: [{ key: "setup_started", people: 0 }, { key: "workspace_created", people: 4 }] }],
    };
    const [j] = journeys(a);
    expect(j?.steps.map((s) => [s.pct, s.width])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });

  test("the journeys carry the artifact's titles and step words, three steps each but the handoff's two", () => {
    const steps = (id: string, keys: string[]) => ({ id, steps: keys.map((key, i) => ({ key, people: 100 - i * 10 })) });
    const a: AnalyticsLike = {
      connected: true,
      error: null,
      sites: [],
      time: null,
      priorTime: null,
      funnels: [
        steps("context_waitlist", ["landing", "signup_started", "signup_submitted", "waitlist_joined"]),
        steps("tex_waitlist", ["landing", "signup_started", "signup_submitted", "waitlist_joined"]),
        steps("context_setup", ["setup_started", "workspace_created", "setup_completed", "note_opened"]),
        steps("tex_handoff", ["signed_in", "text_page", "messages_opened"]),
      ],
    };
    expect(journeys(a).map((j) => [j.title, j.steps.map((s) => s.label)])).toEqual([
      ["Context waitlist", ["Opened context.lc", "Started the form", "Joined"]],
      ["Tex waitlist", ["Opened tex.lc", "Typed a phone", "Joined"]],
      ["New workspace", ["Opened", "Named it", "Finished setup"]],
      ["Tex Messages handoff", ["Shown", "Opened Messages"]],
    ]);
    // "Joined" is the last recorded step, not "Submitted signup": 70 of 100, not 80.
    expect(journeys(a)[0]?.steps[2]).toMatchObject({ people: 70, pct: 70 });
  });
});

describe("ago", () => {
  test("null is never", () => {
    expect(ago(null, NOW)).toBe("never");
  });

  test("under a minute is just now, and so is a time in the future", () => {
    expect(ago(NOW, NOW)).toBe("just now");
    expect(ago(NOW - 59_000, NOW)).toBe("just now");
    expect(ago(NOW + 5_000, NOW)).toBe("just now");
  });

  test("minutes, hours and days, rounding down", () => {
    expect(ago(NOW - 60_000, NOW)).toBe("1m ago");
    expect(ago(NOW - 120_000, NOW)).toBe("2m ago");
    expect(ago(NOW - 3_599_000, NOW)).toBe("59m ago");
    expect(ago(NOW - 3_600_000, NOW)).toBe("1h ago");
    expect(ago(NOW - 86_399_000, NOW)).toBe("23h ago");
    expect(ago(NOW - 86_400_000, NOW)).toBe("1d ago");
    expect(ago(NOW - 4 * DAY, NOW)).toBe("4d ago");
  });
});

describe("clientRows", () => {
  const client = (clientId: string, active: number, accounts: number, lastUsedAt: number | null): ClientLike => ({
    clientId,
    clientName: clientId,
    active,
    accounts,
    lastUsedAt,
  });

  test("drops clients with no active grants", () => {
    const rows = clientRows([client("gone", 0, 3, NOW), client("live", 2, 1, NOW)], NOW);
    expect(rows.map((r) => r.key)).toEqual(["live"]);
  });

  test("a client with only revoked grants is gone altogether", () => {
    expect(clientRows([client("a", 0, 1, null), client("b", 0, 0, null)], NOW)).toEqual([]);
  });

  test("sorts by active grants, then by last use, and maps the columns", () => {
    const rows = clientRows(
      [
        client("Cursor", 2, 1, NOW - 4 * DAY),
        client("Codex", 3, 2, NOW - DAY),
        client("ChatGPT", 6, 4, NOW - 3_600_000),
        client("Claude", 14, 8, NOW - 120_000),
        client("Tie-old", 3, 1, NOW - 10 * DAY),
        client("Tie-never", 3, 1, null),
      ],
      NOW,
    );
    expect(rows.map((r) => r.name)).toEqual(["Claude", "ChatGPT", "Codex", "Tie-old", "Tie-never", "Cursor"]);
    expect(rows[0]).toEqual({ key: "Claude", name: "Claude", grants: 14, people: 8, last: "2m ago" });
    expect(rows[1]?.last).toBe("1h ago");
    expect(rows[4]?.last).toBe("never");
    expect(rows[5]?.last).toBe("4d ago");
  });
});

describe("captureRows", () => {
  test("the three rows read as the mock does", () => {
    expect(
      captureRows({
        googleAccounts: 6,
        gmail: 5,
        calendar: 6,
        chat: 1,
        mailOpen: 1,
        mailAllowlisted: 4,
        obsidian: 2,
        mailOpenSlugs: ["samw"],
      }),
    ).toEqual([
      { k: "Google accounts", v: "6 · mail 5 · calendar 6 · chat 1", pills: [] },
      { k: "Mail capture", v: "4 allowlisted · 1 open to anyone", pills: ["@samw"] },
      { k: "Obsidian plugin", v: "2 workspaces", pills: [] },
    ]);
  });

  test("one Obsidian workspace reads singular, none reads plural", () => {
    const base = { googleAccounts: 0, gmail: 0, calendar: 0, chat: 0, mailOpen: 0, mailAllowlisted: 0 };
    expect(captureRows({ ...base, obsidian: 1 })[2]?.v).toBe("1 workspace");
    expect(captureRows({ ...base, obsidian: 0 })[2]?.v).toBe("0 workspaces");
  });

  test("no open mail inbox means no pills", () => {
    const rows = captureRows({
      googleAccounts: 1,
      gmail: 1,
      calendar: 1,
      chat: 0,
      mailOpen: 0,
      mailAllowlisted: 2,
      obsidian: 0,
    });
    expect(rows[1]).toEqual({ k: "Mail capture", v: "2 allowlisted · 0 open to anyone", pills: [] });
  });
});
