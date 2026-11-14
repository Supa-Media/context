/**
 * The console's Home page view: `renderHome` draws the artifact's `P.home` markup, the five tiles and "Needs you".
 * While a needs source is still loading the list says so; it never reads "Nothing needs you" before it knows.
 */
import { describe, expect, test } from "@jest/globals";
import { renderHome, type HomeData } from "../features/admin/console/pages/Home.web";
import type { TexStatsLike } from "../features/admin/console/pages/homeData";
import type { Need } from "../features/admin/console/types";

const stats: TexStatsLike = {
  configured: true,
  dailyActive: 6.4,
  people: { one: 8, group: 4, any: 12 },
  texts: { inOne: 1500, inGroup: 214, outOne: 0, outGroup: 0 },
  cost: { totalUsd: 274.24 },
  costPerTextUsd: 0.16,
  notes: { created: 0 },
  series: [
    { at: 1, people: 5, textsIn: 20, usd: 3, notesCreated: 0 },
    { at: 2, people: 7, textsIn: 24, usd: 4, notesCreated: 0 },
  ],
};

const reports: Need = { tone: "bad", html: "<b>3 open reports</b>, 2 texted to Tex", label: "Reports", to: { p: "reports" } };

const data = (over: Partial<HomeData> = {}): HomeData => ({
  d: "30",
  stats,
  prior: null,
  partial: false,
  accounts: 10,
  answered: 1394,
  needs: [],
  needsLoading: false,
  ...over,
});

const needsPanel = (html: string) => html.slice(html.indexOf('<section class="pn'));

describe("Home's Needs you", () => {
  test("while a source loads and nothing is known yet, it says Loading… with no count", () => {
    const html = needsPanel(renderHome(data({ needsLoading: true })));
    expect(html).toContain('<div class="empty">Loading…</div>');
    expect(html).not.toContain("Nothing needs you.");
    expect(html).not.toContain('<span class="meta">');
  });

  test("before the page's data arrives at all, it says Loading…", () => {
    expect(needsPanel(renderHome(undefined))).toContain('<div class="empty">Loading…</div>');
  });

  test("once every source has answered with nothing, it reads 'Nothing needs you.' and a count of 0", () => {
    const html = needsPanel(renderHome(data()));
    expect(html).toContain('<div class="empty">Nothing needs you.</div>');
    expect(html).toContain('<span class="meta">0</span>');
  });

  test("a line is the artifact's row: dot, sentence, page name, chevron, wired to the shell's need act", () => {
    const html = needsPanel(renderHome(data({ needs: [reports] })));
    expect(html).toContain('<span class="meta">1</span>');
    expect(html).toContain(
      '<button class="need" data-act="need" data-i="0"><span class="dt" style="background:var(--bad)"></span><span class="tx"><b>3 open reports</b>, 2 texted to Tex</span><span class="where hp">Reports</span>',
    );
  });
});

describe("Home's tiles", () => {
  test("counts read without a thousands separator, as the artifact's tiles do", () => {
    expect(renderHome(data())).toContain('<div class="v">1714</div><div class="d">1394 answered</div>');
  });

  test("each tile opens its page", () => {
    const html = renderHome(data());
    for (const p of ["people", "turns", "costs"]) expect(html).toContain(`data-act="go" data-p="${p}"`);
  });
});
