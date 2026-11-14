/**
 * The console's Growth page renders the artifact's `P.growth` from plain data: the four tiles, the funnel with its
 * Everyone / From the waitlist switch, the newest arrivals and the nudge lists. Every value a person wrote is escaped.
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import { growthPage } from "../features/admin/console/pages/Growth.web";
import { S } from "../features/admin/console/state";
import type { CensusLike, PersonLike, UsageLike } from "../features/admin/console/pages/growthData";

const census: CensusLike = {
  accounts: { total: { count: 120, isFloor: false }, newInWindow: 14 },
  contexts: { total: { count: 90, isFloor: false }, personal: 80, shared: 10 },
  growthFunnel: [
    { step: "signed-up", count: 120 },
    { step: "texted-tex", count: 30 },
    { step: "connected-a-client", count: 40 },
    { step: "in-a-shared-workspace", count: 6 },
  ],
  waitlist: {
    growthFunnel: [
      { step: "let-in", count: 31 },
      { step: "signed-up", count: 20 },
      { step: "texted-tex", count: 5 },
      { step: "connected-a-client", count: 4 },
    ],
  },
  texAccess: { canText: 25, phoneButOff: 3 },
};

const usage: UsageLike = {
  activeContexts: {
    points: [
      { day: "2026-11-13", count: 3 },
      { day: "2026-11-14", count: 4 },
    ],
    distinctInWindow: 7,
  },
};

const ana: PersonLike = {
  id: "u1",
  name: "Ana Lee",
  handle: "ana",
  emails: ["ana@example.com"],
  phone: "+15555550100",
  joinedAt: Date.UTC(2026, 10, 13),
  from: "friend",
  invitedBy: "maya",
  clients: 1,
  lastSeenAt: null,
  archived: false,
};

const maya: PersonLike = {
  id: "u3",
  name: "Maya Lindqvist",
  handle: "maya",
  emails: [],
  phone: "+15555550101",
  joinedAt: Date.UTC(2026, 7, 2),
  from: "waitlist",
  invitedBy: null,
  clients: 2,
  lastSeenAt: null,
  archived: false,
};

const hostile: PersonLike = {
  id: "u2",
  name: "<script>alert(1)</script>",
  handle: null,
  emails: [],
  phone: null,
  joinedAt: Date.UTC(2026, 10, 12),
  from: "waitlist",
  invitedBy: null,
  clients: 0,
  lastSeenAt: null,
  archived: false,
};

const render = (d: Parameters<NonNullable<typeof growthPage.render>>[0]) => growthPage.render!(d);

beforeEach(() => {
  S.f.aud = "all";
});

describe("console Growth page", () => {
  it("draws the four tiles with their values and detail lines", () => {
    const html = render({ census, usage, people: [ana] });
    expect(html).toContain('<div class="kpis">');
    expect(html).toContain('<div class="l">Accounts</div><div class="v">120</div><div class="d">+14 in 30 days</div>');
    expect(html).toContain('<div class="l">Workspaces</div><div class="v">90</div><div class="d">80 personal · 10 shared</div>');
    expect(html).toContain('<div class="l">Active workspaces</div><div class="v">7</div><div class="d">4 today</div>');
    expect(html).toContain('<div class="l">Can text Tex</div><div class="v">25</div><div class="d">3 with a phone but switched off</div>');
  });

  it("puts the three panels in a two-column grid with the artifact's titles and keys", () => {
    const html = render({ census, usage, people: [ana] });
    expect(html).toContain('<div class="grid2">');
    expect(html).toContain('data-k="g-new"');
    expect(html).toContain('data-k="g-fun"');
    expect(html).toContain('data-k="g-nudge"');
    expect(html).toContain("Newest arrivals");
    expect(html).toContain("How far people get");
    expect(html).toContain("Needs a nudge");
  });

  it("shows who was invited by whom as a team pill, by the inviter's first name", () => {
    const html = render({ census, usage, people: [ana, maya] });
    expect(html).toContain('<span class="pill team">invited by Maya</span>');
    expect(html).toContain('data-act="person" data-id="u1"');
  });

  it("switches the funnel to the waitlist's steps when the audience is From the waitlist", () => {
    const everyone = render({ census, usage, people: [ana] });
    expect(everyone).toContain('<div class="r"><span>Signed up</span>');
    expect(everyone).not.toContain("Let in from the waitlist");

    S.f.aud = "wait";
    const waiting = render({ census, usage, people: [ana] });
    expect(waiting).toContain('<div class="r"><span>Let in from the waitlist</span>');
    expect(waiting).toContain('<span class="t">31 · 100%</span>');
    expect(waiting).toContain('aria-pressed="true" data-act="aud" data-v="wait"');
  });

  it("escapes a name that holds markup", () => {
    const html = render({ census, usage, people: [hostile] });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("says so when nobody has signed up, rather than an empty panel", () => {
    const html = render({ census, usage, people: [] });
    expect(html).toContain('<div class="empty">Nobody has signed up yet.</div>');
  });

  it("says nobody when a nudge list is empty", () => {
    const html = render({ census, usage, people: [] });
    expect(html.match(/<span class="sub">nobody<\/span>/g)).toHaveLength(3);
  });

  it("draws dashes and loading panels while the reports are still loading", () => {
    const html = render(undefined);
    expect(html.match(/<div class="v">—<\/div>/g)).toHaveLength(4);
    expect(html.match(/<div class="empty">Loading…<\/div>/g)).toHaveLength(3);
  });

  it("is not windowed and owns the aud filter", () => {
    expect(growthPage.windowed).toBe(false);
    expect(growthPage.filters).toEqual({ aud: "all" });
    expect(growthPage.Legacy).toBeUndefined();
  });
});
