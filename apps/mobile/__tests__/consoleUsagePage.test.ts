/**
 * The console's Usage page: `usagePage.render` draws the artifact's `P.usage` markup from real data, and each panel
 * waits for its own source. The fake data is shaped like the four sources (PostHog, our counters, the workspace
 * objects' note counts, the census) and the names are ones a person could type, so the escaping is what is tested.
 */
import { beforeEach, describe, expect, test } from "@jest/globals";
import {
  renderUsage,
  usagePage,
  type UsageData,
} from "../features/admin/console/pages/Usage.web";
import { S } from "../features/admin/console/state";

// The page's data is loaded by hooks, but its view is plain HTML: the shell's window is the only state it reads.
beforeEach(() => {
  S.d = "30";
});

const series = (metric: string, counts: number[], total: number) => ({
  metric,
  points: counts.map((count, i) => ({
    day: `2026-11-${String(i + 1).padStart(2, "0")}`,
    count,
  })),
  total,
});

// Only the fields the view reads are filled in; the rest of each report's shape is not used here.
const fake = (): UsageData => ({
  analytics: {
    connected: true,
    error: null,
    sites: [
      { host: "context.lc", visits: 1240, visitors: 530, priorVisits: 1100 },
      { host: "tex.lc", visits: 860, visitors: 410, priorVisits: 657 },
    ],
    time: {
      sessions: 90,
      people: 49,
      medianSeconds: 250,
      totalSeconds: 219_600,
    },
    priorTime: {
      sessions: 80,
      people: 40,
      medianSeconds: 212,
      totalSeconds: 180_000,
    },
    funnels: [
      {
        id: "context_waitlist",
        steps: [
          { key: "landing", people: 540 },
          { key: "signup_started", people: 120 },
          { key: "waitlist_joined", people: 61 },
        ],
      },
    ],
  },
  // The window's totals (here, 30 days' worth).
  usage: {
    series: [
      series("mcp.tool_call", [1, 2, 3, 4], 4120),
      series("search.query", [0, 1, 1, 2], 1384),
      series("mcp.session", [0, 0, 1, 1], 38),
    ],
  } as unknown as UsageData["usage"],
  // The last 14 calendar days, whatever the window: the trend and today against yesterday.
  daily: {
    series: [
      series("mcp.tool_call", [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 105),
      series("search.query", [0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 2], 8),
      series("mcp.session", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1], 2),
    ],
  } as unknown as UsageData["daily"],
  notes: { total: 214, daily: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] },
  census: {
    clients: [
      {
        clientId: "c1",
        clientName: "<b>Evil</b>",
        active: 3,
        revoked: 0,
        contexts: 2,
        accounts: 2,
        lastUsedAt: Date.now() - 120_000,
      },
      {
        clientId: "c2",
        clientName: "Claude",
        active: 14,
        revoked: 0,
        contexts: 9,
        accounts: 8,
        lastUsedAt: null,
      },
      {
        clientId: "c3",
        clientName: "Old",
        active: 0,
        revoked: 2,
        contexts: 0,
        accounts: 0,
        lastUsedAt: null,
      },
    ],
    sources: {
      googleAccounts: 6,
      gmail: 5,
      calendar: 6,
      chat: 1,
      mailOpen: 1,
      mailAllowlisted: 4,
      obsidian: 2,
      mailOpenSlugs: ["sam"],
    },
  } as unknown as UsageData["census"],
});

/** The Events panel's markup, from its id to the next panel. */
function eventsPanel(html: string): string {
  const from = html.indexOf('data-k="u-ev"');
  const to = html.indexOf('data-k="u-j"');
  return html.slice(from, to === -1 ? undefined : to);
}

describe("console Usage page", () => {
  test("is the Usage page, windowed, with no filters and no legacy section", () => {
    expect(usagePage.key).toBe("usage");
    expect(usagePage.filters).toEqual({});
    expect(usagePage.windowed).toBe(true);
    expect(usagePage.Legacy).toBeUndefined();
  });

  test("draws the mock's tiles, panels and captions from real data", () => {
    const html = usagePage.render?.(fake()) ?? "";
    expect(html).toContain("context.lc visits");
    expect(html).toContain("tex.lc visits");
    expect(html).toContain("Typical session");
    expect(html).toContain("Today vs yesterday");
    expect(html).toContain("In 30 days");
    expect(html).toContain("visitors, not accounts");
    expect(html).toContain("names are self-reported");
    for (const key of ["u-ev", "u-j", "u-cli", "u-cap"])
      expect(html).toContain(`data-k="${key}"`);
    // Values from the sources, not the mock's constants.
    expect(html).toContain("1240");
    expect(html).toContain("530 visitors · ");
    expect(html).toContain("4,120");
    expect(html).toContain("214");
    expect(html).toContain("6 · mail 5 · calendar 6 · chat 1");
    expect(html).toContain("@sam");
    expect(html).not.toContain("Loading…");
  });

  test("escapes a client name typed as markup", () => {
    const html = renderUsage(fake());
    expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
    expect(html).not.toContain("<b>Evil</b>");
  });

  test("leaves out revoked-only clients and says so when none are left", () => {
    const data = fake();
    data.census = { ...data.census!, clients: [] } as UsageData["census"];
    expect(renderUsage(data)).toContain("No AI clients connected");
  });

  test("shows the PostHog note as a warning banner above the tiles", () => {
    const data = fake();
    data.analytics = { connected: true, error: "PostHog could not be asked" };
    const html = renderUsage(data);
    expect(html).toContain(
      '<div class="banner warn"><span class="tx">PostHog could not be asked</span></div>',
    );
    expect(html.indexOf("banner warn")).toBeLessThan(
      html.indexOf('class="kpis"'),
    );
  });

  test("draws each panel's loading state while its source is undefined, and the tiles as dashes", () => {
    const html = renderUsage(undefined);
    expect(html).toContain("context.lc visits");
    expect(html).toContain('<div class="v">—</div>');
    expect(html.match(/Loading…/g)?.length).toBe(4);
    for (const key of ["u-ev", "u-j", "u-cli", "u-cap"])
      expect(html).toContain(`data-k="${key}"`);
  });

  test("the events panel waits for usage, the 14-day daily report and the notes count, all three", () => {
    const noUsage = fake();
    noUsage.usage = undefined;
    expect(eventsPanel(renderUsage(noUsage))).toContain("Loading…");

    const noDaily = fake();
    noDaily.daily = undefined;
    expect(eventsPanel(renderUsage(noDaily))).toContain("Loading…");

    const noNotes = fake();
    noNotes.notes = undefined;
    expect(eventsPanel(renderUsage(noNotes))).toContain("Loading…");

    expect(eventsPanel(renderUsage(fake()))).not.toContain("Loading…");
  });

  test("the events panel reads the window's totals and the daily trend, with today against yesterday", () => {
    const panel = eventsPanel(renderUsage(fake()));
    // Window total for tool calls, not the 14-day sum; yesterday's 14 against today's 15 is +7%.
    expect(panel).toContain("<td class=\"r\">4,120</td>");
    expect(panel).not.toContain("105");
    expect(panel).toContain("+7%");
    // Notes created: the workspace count, and its own trend.
    expect(panel).toContain("<td class=\"r\">214</td>");
  });

  test("a notes read that failed does not hold the events table on Loading", () => {
    // Pinned as it is: a failed notes read (null) still draws the table, with Notes created at zero.
    const data = fake();
    data.notes = null;
    const panel = eventsPanel(renderUsage(data));
    expect(panel).not.toContain("Loading…");
    expect(panel).toContain("Notes created");
  });
});
