/**
 * The staff console's AI costs page (`pages/costsView.ts`): the artifact's KPIs, banner, who paid,
 * daily chart, feature and Tex step tables, accounts, and the side panel for one account. Fixtures
 * use fake numbers in the shapes the server returns.
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import type { AiCostsAccount, AiCostsReport } from "@context/convex/functions/lib/adminFns/aiCostsShape";
import type { ConsoleCosts } from "@context/convex/functions/lib/adminFns/consoleCostsShape";
import { accountPropsHtml, costsPageHtml } from "../features/admin/console/pages/costsView";
import { S } from "../features/admin/console/state";

type Live = Extract<ConsoleCosts, { configured: true }>;

const live = (over: Partial<Live> = {}): Live => ({
  configured: true,
  error: null,
  days: 30,
  from: 0,
  to: 0,
  totalUsd: 170,
  priorUsd: 200,
  labRunsUsd: 9.8,
  billedUsd: 179.8,
  outOfPocketUsd: 31.6,
  outOfPocketPeopleUsd: 24.1,
  texts: 612,
  perTextUsd: 0.2,
  priorPerTextUsd: 0.3,
  devDaysLeft: 21,
  payers: [
    { key: "dev", label: "dev credits", usd: 52.4, capUsd: 100, usedUsd: 12.15, leftUsd: 87.85, note: null },
    { key: "dev2", label: "dev2 credits", usd: 86.1, capUsd: 200, usedUsd: 200, leftUsd: 0, note: null },
    { key: "plan", label: "Claude plan credit", usd: 9.7, capUsd: null, usedUsd: null, leftUsd: null, note: "Spent; comes back Dec 1" },
    { key: "cloudflare", label: "Out of pocket", usd: 31.6, capUsd: null, usedUsd: null, leftUsd: null, note: "Cloudflare Unified Billing · $9.46 balance left" },
  ],
  features: [
    { key: "tex", label: "Tex replies", models: ["claude-opus-5-5", "claude-haiku-5-5"], usd: 120, share: 0.71 },
    { key: "meetings", label: "Meeting summaries", models: ["claude-sonnet-5-5"], usd: 22, share: 0.13 },
    { key: "dream", label: "Dream", models: ["claude-sonnet-5-5"], usd: 12, share: 0.07 },
    { key: "checkin", label: "Check-in", models: ["claude-haiku-5-5"], usd: 10, share: 0.06 },
    { key: "search", label: "Search by meaning", models: ["@cf/baai/bge-m3"], usd: 6, share: 0.03 },
  ],
  daily: [
    { label: "2026-11-12", byFeature: [{ key: "tex", usd: 50 }, { key: "meetings", usd: 10 }, { key: "search", usd: 2 }] },
    { label: "2026-11-13", byFeature: [{ key: "tex", usd: 70 }, { key: "dream", usd: 12 }, { key: "checkin", usd: 10 }] },
  ],
  texUsd: 120,
  texSteps: [
    { id: "decide", label: "Decide", model: "clef", on: true, calls: 612, usd: 0.6, share: 0.005 },
    { id: "router", label: "Router", model: "clef", on: false, calls: 0, usd: 0, share: 0 },
    { id: "advisor", label: "Advisor", model: "opus-5-5", on: true, calls: 180, usd: 44.4, share: 0.37 },
    { id: "fd", label: "Front door", model: "haiku-5-5", on: true, calls: 1310, usd: 32.4, share: 0.27 },
    { id: "planner", label: "Big-ask planner", model: "opus-5-5", on: false, calls: 0, usd: 0, share: 0 },
    { id: "fallback", label: "Fallback", model: "glm-4-7", on: true, calls: 14, usd: 0.5, share: 0.004 },
  ],
  ...over,
});

const account = (over: Partial<AiCostsAccount> = {}): AiCostsAccount => ({
  userId: "u1",
  email: "maya@example.com",
  plan: "Premium",
  days: 30,
  totalUsd: 40,
  planUsd: 5,
  questionsTexted: 400,
  perQuestionUsd: 0.1,
  busiestDay: null,
  today: [{ feature: "tex", label: "Questions", used: 12, cap: 50 }],
  rows: [{ workspace: "maya", feature: "tex", label: "Tex replies", models: ["claude-opus-5-5"], costUsd: 30 }],
  ...over,
});

const report = (over: Partial<AiCostsReport> = {}): AiCostsReport => ({
  days: 30,
  since: "2026-10-16",
  totalUsd: 170,
  priorUsd: 200,
  payingAccounts: 2,
  perPayingAccountUsd: 85,
  textedQuestions: 612,
  perQuestionUsd: 0.2,
  features: [],
  models: [],
  unrecordedModelUsd: 0,
  daily: [],
  accounts: [
    {
      userId: "u1",
      email: "maya@example.com",
      name: "Maya Chen",
      handle: "maya",
      plan: "Premium",
      workspaces: 1,
      costUsd: 40,
      byFeature: [
        { feature: "tex", costUsd: 30 },
        { feature: "meetings", costUsd: 10 },
      ],
      questionsToday: 12,
      questionsCap: 50,
    },
    {
      userId: "u2",
      email: null,
      plan: "Free",
      workspaces: 1,
      costUsd: 0,
      byFeature: [],
      questionsToday: 0,
      questionsCap: 10,
    },
  ],
  moreAccounts: 2,
  truncated: false,
  ...over,
});

/** The HTML of one panel: from its toggle to the next panel. */
function panelOf(html: string, key: string): string {
  const start = html.indexOf(`data-k="${key}"`);
  if (start < 0) return "";
  const next = html.indexOf("<section", start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

beforeEach(() => {
  S.d = "30";
  S.x = null;
});

describe("AI costs page: states", () => {
  it("shows Loading until the costs action answers", () => {
    expect(costsPageHtml(undefined, undefined)).toBe('<div class="empty">Loading…</div>');
  });

  it("shows one banner when the Cloudflare token is not set here", () => {
    expect(costsPageHtml({ configured: false }, report())).toBe(
      '<div class="banner warn"><span class="tx">The Cloudflare analytics token isn\'t set here, so AI costs can\'t be read.</span></div>',
    );
  });

  it("escapes a read error in the banner", () => {
    const html = costsPageHtml({ error: "<b>boom</b> & more" }, undefined);
    expect(html).toBe('<div class="banner warn"><span class="tx">&lt;b&gt;boom&lt;/b&gt; &amp; more</span></div>');
    expect(html).not.toContain("<b>");
  });

  it("shows the same banner when the action reports an error on a configured page", () => {
    const html = costsPageHtml(live({ error: "Cloudflare could not be asked" }), undefined);
    expect(html).toBe('<div class="banner warn"><span class="tx">Cloudflare could not be asked</span></div>');
  });
});

describe("AI costs page: figures", () => {
  it("draws the four KPIs and the match banner with real figures", () => {
    const html = costsPageHtml(live(), report());
    expect(html).toContain('<div class="v">$170.00</div>');
    expect(html).toContain("-15%</span> on the window before");
    expect(html).toContain('<div class="v">$0.20</div>');
    expect(html).toContain("Tex replies ÷ 612 texts");
    expect(html).toContain('<div class="v">$9.80</div>');
    expect(html).toContain("billed, not in the total");
    expect(html).toContain('<div class="v">$31.60</div>');
    expect(html).toContain("of $179.80 billed; credits paid the rest");
    expect(html).toContain(
      '<div class="banner ok"><span class="tx">Matches Cloudflare: $179.80 billed = $170.00 for people + $9.80 Lab test runs.</span></div>',
    );
  });

  it("leaves the change out when nothing was spent the window before, and the per-text figure when texts are unknown", () => {
    const html = costsPageHtml(live({ priorUsd: 0, texts: null, perTextUsd: null }), report());
    expect(html).not.toContain("on the window before");
    expect(html).toContain('<div class="v">—</div>');
    expect(html).not.toContain("Tex replies ÷");
  });

  it("lists who paid in order, with the cap bars and the days left", () => {
    const pay = panelOf(costsPageHtml(live(), report()), "c-pay");
    expect(pay).toContain("Who paid");
    expect(pay).toContain("In 30 days");
    const order = ["dev credits", "dev2 credits", "Claude plan credit", "Out of pocket"].map((l) => pay.indexOf(l));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(pay).toContain("$87.85 of $100 left");
    expect(pay).toContain("all $200 spent");
    expect(pay).toContain('<span class="sub">Spent; comes back Dec 1</span>');
    expect(pay).toContain("Cloudflare Unified Billing · $9.46 balance left");
    expect(pay).toContain("At this pace dev credits last about 21 more days; after that every call is out of pocket.");
  });

  it("leaves the days-left line out when there is no dev spend", () => {
    expect(panelOf(costsPageHtml(live({ devDaysLeft: null }), report()), "c-pay")).not.toContain("At this pace");
  });

  it("draws the daily chart by feature, titled by the window", () => {
    const html = costsPageHtml(live(), report());
    expect(html).toContain("Each day, by feature");
    expect(panelOf(html, "c-day")).toContain('<svg class="chart"');
    S.d = "1";
    expect(costsPageHtml(live(), report())).toContain("Each hour, by feature");
    S.d = "30";
  });

  it("lists only features that cost something, with models and shares", () => {
    const feat = panelOf(costsPageHtml(live(), report()), "c-feat");
    expect(feat).toContain("Tex replies");
    expect(feat).toContain("Opus · Haiku");
    expect(feat).toContain('data-act="totex">by step ↓</button>');
    expect(feat).toContain("<td class=\"r\">71%</td><td class=\"r\">$120.00</td>");
    expect(feat).toContain("bge-m3");
    expect(feat).not.toContain("Transcription");
  });

  it("lists the Tex steps that ran, largest first, with the switched-off line", () => {
    const tex = panelOf(costsPageHtml(live(), report()), "c-tex");
    expect(tex).toContain("$120.00 · $0.20 a text");
    const at = (s: string) => tex.indexOf(`<td>${s}</td>`);
    expect(at("Advisor")).toBeGreaterThan(0);
    expect(at("Advisor")).toBeLessThan(at("Front door"));
    expect(at("Front door")).toBeLessThan(at("Decide"));
    expect(at("Decide")).toBeLessThan(at("Fallback"));
    expect(tex).not.toContain("<td>Router</td>");
    expect(tex).not.toContain("<td>Big-ask planner</td>");
    expect(tex).toContain("Switched off now and costing nothing: Router, Big-ask planner.");
    expect(tex).toContain("37.0%");
    expect(tex).toContain("$44.40");
    expect(tex).toContain('href="https://context.lc/lab"');
  });

  it("shows the Tex total without a per-text figure when texts are unknown", () => {
    expect(panelOf(costsPageHtml(live({ texts: null }), report()), "c-tex")).toContain('<span class="meta">$120.00</span>');
  });
});

describe("AI costs page: accounts", () => {
  it("lists accounts by name and @handle, never a plan, and says how many more there are", () => {
    const acc = panelOf(costsPageHtml(live(), report()), "c-acc");
    expect(acc).toContain('data-act="sel" data-id="u1" aria-selected="false"');
    expect(acc).toContain('<td>Maya Chen <span class="sub">@maya</span></td>');
    // Context is free for everyone (2026-10-20): no plan words on the console.
    expect(acc).not.toContain("Premium");
    expect(acc).toContain("$40.00");
    expect(acc).toContain('data-id="u2"');
    expect(acc).toContain("<td>u2 <span");
    expect(acc).toContain("+ 2 more accounts");
  });

  it("shows the account panel as loading while the report loads", () => {
    expect(panelOf(costsPageHtml(live(), undefined), "c-acc")).toContain('<div class="empty">Loading…</div>');
  });
});

describe("AI costs side panel for one account", () => {
  it("draws the account's header, figures, limits, workspaces and the People link", () => {
    const html = accountPropsHtml(account(), "u1", report());
    expect(html).toContain('<h3 tabindex="-1">Maya Chen</h3>');
    expect(html).toContain('<div class="v">$40.00</div>');
    expect(html).toContain("AI, 30 days");
    expect(html).toContain('<div class="v">$0.10</div>');
    expect(html).toContain("Today against today's limits");
    expect(html).toContain('<span class="t">12 of 50</span>');
    expect(html).toContain('style="width:24%"');
    expect(html).toContain("<td>@maya</td><td>Tex replies</td><td class=\"r\">$30.00</td>");
    expect(html).toContain('<button class="link" data-act="person" data-id="u1">Open in People</button>');
  });

  it("shows loading until the account answers, and a line when it is not found", () => {
    expect(accountPropsHtml(undefined, "u1")).toContain('<div class="empty">Loading…</div>');
    expect(accountPropsHtml(null, "u1")).toContain("Account not found");
  });
});
