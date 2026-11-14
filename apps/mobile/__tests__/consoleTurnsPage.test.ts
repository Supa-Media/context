/**
 * The staff console's Turns page, drawn from real data: the turns, the texts received, the side
 * panel's step-by-step waterfall, and that a name from the database is escaped.
 */
import { floorToMinute, textWindow, turnsPage, TURNS_KEPT_DAYS } from "../features/admin/console/pages/Turns.web";
import { beforeEach, describe, expect, it } from "@jest/globals";
import { S } from "../features/admin/console/state";
import { modelOf, whenOf, type TurnsData } from "../features/admin/console/pages/turnsView";

type Data = TurnsData;

const NOW = Date.now();
const MIN = 60_000;
const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
const hm = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`;

const base = {
  workspace: "maya",
  group: false,
  costMicroUsd: null,
  modelMs: 0,
  toolMs: 0,
  inputTokens: 9200,
  outputTokens: 400,
  waitMs: null,
};

const answered = {
  ...base,
  id: "t-1",
  at: NOW - 2 * MIN,
  person: "Maya <b>L</b>",
  model: "anthropic/claude-haiku-4-5",
  outcome: "answered" as const,
  rounds: 2,
  ms: 4200,
  waitMs: 300,
  trace: [
    { kind: "model" as const, model: "haiku", ok: true, ms: 1000 },
    { kind: "tool" as const, tool: "search", action: "fetch", ok: true, ms: 900 },
    { kind: "model" as const, model: "haiku", ok: true, ms: 1400 },
  ],
};

const exhausted = {
  ...base,
  id: "t-2",
  at: NOW - 40 * MIN,
  workspace: null,
  person: null,
  group: true,
  model: "opus",
  outcome: "exhausted" as const,
  rounds: 8,
  ms: 21000,
  trace: [{ kind: "model" as const, model: "opus", ok: true, ms: 21000 }],
};

const failed = {
  ...base,
  id: "t-3",
  at: NOW - 3 * DAY,
  person: "Sam",
  model: "sonnet",
  outcome: "failed" as const,
  rounds: 1,
  ms: 2700,
  trace: [{ kind: "tool" as const, tool: "calendar", action: "write", ok: false, ms: 800 }],
};

function fixture(over: Partial<Data["turns"] & object> = {}): Data {
  return {
    turns: {
      days: 30,
      truncated: false,
      turns: 3,
      answered: 1,
      exhausted: 1,
      failed: 1,
      oneToOne: 2,
      group: 1,
      p50Ms: 4200,
      p95Ms: 14000,
      priorP50Ms: 4800,
      series: [
        { label: "2026-11-12", turns: 1, p50: 3000, p95: 9000 },
        { label: "2026-11-13", turns: 1, p50: 5000, p95: 14000 },
        { label: "2026-11-14", turns: 1, p50: 4200, p95: 12000 },
      ],
      where: { modelMs: 6000, toolMs: 2000, otherMs: 2000 },
      hurt: { troubledShare: 0.25, p95Ms: 14000, handedBackShare: 0.1, reviewed: 20 },
      answeredOne: 90,
      recentTotal: 3,
      recent: [answered, exhausted, failed],
      ...over,
    } as Data["turns"],
    texts: {
      configured: true,
      from: NOW - 30 * DAY,
      to: NOW,
      bucket: "day",
      errors: { texts: null, notes: null, cost: null },
      people: { one: 2, group: 1, any: 3 },
      dailyActive: 2,
      texts: { inOne: 100, inGroup: 20, heardGroup: 0, outOne: 90, outGroup: 10 },
      notes: { created: 0, edited: 0, saves: 0 },
      cost: { totalUsd: 1, testsUsd: 0 },
      costPerTextUsd: 0.01,
      countedSince: NOW - 90 * DAY,
      series: [],
    } as unknown as Data["texts"],
  };
}

const render = (d: Data | undefined) => turnsPage.render!(d);
const props = (d: Data | undefined, x: string) => turnsPage.props!(d, x);

beforeEach(() => {
  S.d = "30";
  S.f = { end: "all" };
  S.q = "";
  S.x = null;
});

describe("Turns page", () => {
  it("draws the four targets with their values", () => {
    const html = render(fixture());
    for (const label of ["Answered 1:1 texts", "Handed back to them", "Slowest 1 in 20", "Troubled chats"]) {
      expect(html).toContain(`<div class="l">${label}</div>`);
    }
    // 90 of 100 one-to-one texts answered is under the 95% target, so it is drawn as missed.
    expect(html).toContain('<div class="v dn">90%</div>');
    expect(html).toContain('<div class="v ">10%</div>');
    expect(html).toContain('<div class="v ">14.0 s</div>');
    expect(html).toContain('<div class="v dn">25%</div>');
  });

  it("draws the KPIs from the data, the delta against the window before, and the texts they answer", () => {
    const html = render(fixture());
    expect(html).toContain('<div class="v">4.2 s</div>');
    expect(html).toContain('<span class="up">-0.6 s</span> vs before');
    expect(html).toContain("answers to 120 texts");
    expect(html).toContain('<div class="v">2</div>'); // didn't finish: exhausted + failed
    expect(html).toContain("1 out of steps · 1 failed");
    expect(html).toContain('data-act="end" data-v="trouble" aria-pressed="false"');
  });

  it("omits the delta when there is no window before, and says the window when the texts are unknown", () => {
    const html = render(fixture({ priorP50Ms: null }));
    expect(html).not.toContain("vs before");
    const unknown = render({ turns: fixture().turns, texts: null });
    expect(unknown).toContain("in 30 days");
    expect(unknown).toContain('<div class="l">Answered 1:1 texts</div><div class="v ">—</div>');
  });

  it("draws a recent row with its pill, time and escaped name", () => {
    const html = render(fixture());
    expect(html).toContain(`<td>${hm(answered.at)}</td>`);
    expect(html).toContain("Maya &lt;b&gt;L&lt;/b&gt;");
    expect(html).not.toContain("<b>L</b>");
    expect(html).toContain('<span class="pill ok">Answered</span>');
    expect(html).toContain('<span class="pill warn">Ran out of steps</span>');
    expect(html).toContain('<span class="pill bad">Failed</span>');
    expect(html).toContain(`<td>${whenOf(failed.at)}</td>`);
    expect(whenOf(failed.at)).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
    expect(html).toContain('<td class="r">4.2 s</td>');
    expect(html).toContain("Someone");
  });

  it("names the trouble meta and the Didn't finish toggle when it is on", () => {
    S.f = { end: "trouble" };
    const html = render(fixture({ recent: [exhausted, failed] }));
    expect(html).toContain("latest 2 of 2");
    expect(html).toContain('data-act="end" data-v="all" aria-pressed="true"');
  });

  it("draws the side panel's waterfall from the real trace, slowest marked", () => {
    const html = props(fixture(), "t-1")!;
    const labels = [...html.matchAll(/<div class="r[^"]*"><span>([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(labels).toEqual(["Queue", "Round 1", "search · fetch", "Round 2"]);
    expect(html).toMatch(/<div class="r slow"><span>Round 2<\/span>/);
    expect(html).toContain("Step by step · 4.2 s");
    expect(html).toContain("Maya &lt;b&gt;L&lt;/b&gt;");
    expect(html).toContain("9.2k in · 0.4k out");
  });

  it("marks a failed step and says when a turn is not in the list", () => {
    const html = props(fixture(), "t-3")!;
    expect(html).toContain("calendar · write ✕");
    expect(props(fixture(), "nope")).toBeNull();
  });

  it("draws the loading state with the tools row", () => {
    const html = render(undefined);
    expect(html).toContain('<div class="tools">');
    expect(html).toContain('<div class="empty">Loading…</div>');
    expect(html).not.toContain("kpis");
  });

  it("names models and keeps the id's last part for others", () => {
    expect(modelOf("anthropic/claude-haiku-4-5")).toBe("Haiku");
    expect(modelOf("x/Opus-4")).toBe("Opus");
    expect(modelOf("google/gemma")).toBe("gemma");
  });
});

describe("Turns page: one read per visit, the texts over the same span", () => {
  it("floors the read's time to the minute", () => {
    expect(floorToMinute(1_700_000_123_456)).toBe(1_700_000_100_000);
    expect(floorToMinute(1_700_000_100_000)).toBe(1_700_000_100_000);
  });

  it("counts the texts over the window, clamped to the 30 days the turns are kept", () => {
    expect(textWindow(7, NOW)).toEqual({ from: NOW - 7 * DAY, to: NOW });
    expect(textWindow(30, NOW)).toEqual({ from: NOW - 30 * DAY, to: NOW });
    expect(TURNS_KEPT_DAYS).toBe(30);
    // 90 days of turns cover 30 days, so the texts cover the same 30.
    expect(textWindow(90, NOW)).toEqual({ from: NOW - 30 * DAY, to: NOW });
  });

  it("shows the number answered as the Turns value, with the texts they answer", () => {
    const html = render(fixture({ answered: 2 }));
    expect(html).toContain('<div class="v">2</div>');
    expect(html).toContain("answers to 120 texts");
  });

  it("shows the truncation banner under the KPIs only when the read was cut short", () => {
    const cut = render(fixture({ truncated: true }));
    expect(cut).toContain(
      '<div class="banner warn"><span class="tx">More turns than one read holds: these figures cover the newest ones.</span></div>',
    );
    expect(cut.indexOf('class="banner warn"')).toBeGreaterThan(cut.indexOf('class="kpis"'));
    expect(render(fixture())).not.toContain("More turns than one read holds");
  });
});

