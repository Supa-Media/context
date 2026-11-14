/**
 * The AI costs page's HTML, the artifact's `P.costs` and `P.costs.props`: pure, so the page
 * (`Costs.web.tsx`) only fetches and hands the data in. Classes, wording and order are the
 * artifact's; every value from the server goes through `esc`.
 */
import type { AiCostsAccount, AiCostsReport } from "@context/convex/functions/lib/adminFns/aiCostsShape";
import type { ConsoleCosts } from "@context/convex/functions/lib/adminFns/consoleCostsShape";
import { bars, delta, esc, ic, kpi, legend, money, panel, plural } from "../kit";
import { S, WIN } from "../state";

/** The costs action's answer, or the page's own error when the call threw. */
export type CostsResult = ConsoleCosts | { error: string };
export type CostsData = { costs?: CostsResult; report?: AiCostsReport; account?: AiCostsAccount | null };
type Live = Extract<ConsoleCosts, { configured: true }>;

const FEATURE_COLOUR: Record<string, string> = { tex: "c1", checkin: "c2", dream: "c3", meetings: "c4", search: "c5", other: "c6" };
const PAYER_COLOUR: Record<string, string> = { dev: "c1", dev2: "c2", plan: "c3", cloudflare: "bad" };
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MODEL_NAMES: Array<[string, string]> = [
  ["claude-opus-5-5", "Opus"],
  ["claude-haiku-5-5", "Haiku"],
  ["claude-sonnet-5-5", "Sonnet"],
  ["@cf/cloudflare/clef", "Clef"],
  ["@cf/zai-org/glm-4.7-flash", "GLM 4.7"],
  ["@cf/baai/bge-m3", "bge-m3"],
  ["whisper", "Whisper"],
];
const TEX_MODEL: Record<string, string> = { "opus-5-5": "Opus", "haiku-5-5": "Haiku", "sonnet-5-5": "Sonnet", clef: "Clef", "glm-4-7": "GLM 4.7" };
const TOKEN_MISSING = "The Cloudflare analytics token isn't set here, so AI costs can't be read.";

const num = (n: number) => n.toLocaleString("en-US");
const colourOf = (map: Record<string, string>, key: string) => map[key] ?? "c6";
const modelName = (m: string) => MODEL_NAMES.find(([k]) => m === k || m.includes(k))?.[1] ?? m;
const banner = (text: string, tone = "warn") => `<div class="banner ${tone}"><span class="tx">${text}</span></div>`;
/** The account report's meter has no 24-hour window: its figures are the last 7 days when the page asks for a day. */
export const accountWindow = (d: string) => (d === "1" ? "7 days" : WIN[d]);
/** A bucket's UTC day as "Nov 3", the same days the daily chart draws. */
const dayLabel = (ms: number) => {
  const d = new Date(ms);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
};
/** The texts the per-text figures divide by: the texts answered when the server counts them, else the texts received. */
export const textsDenominator = (c: Pick<Live, "answered" | "texts">): number | null =>
  typeof c.answered === "number" && c.answered > 0 ? c.answered : c.texts;

/** Module-level cache: one `consoleAi.costs` answer per window, shared by every mount for 60 seconds. */
const COSTS_TTL_MS = 60_000;
const costsCache = new Map<number, { at: number; promise: Promise<CostsResult> }>();

/** The answer for `days`: the cached promise while it is fresh, else `run(days)`. A failure is not kept. */
export function costsFor(days: number, run: (days: number) => Promise<CostsResult>): Promise<CostsResult> {
  const now = Date.now();
  const hit = costsCache.get(days);
  if (hit && now - hit.at < COSTS_TTL_MS) return hit.promise;
  const promise = run(days);
  const entry = { at: now, promise };
  costsCache.set(days, entry);
  promise.catch(() => {
    if (costsCache.get(days) === entry) costsCache.delete(days);
  });
  return promise;
}

/** Forgets every cached answer (tests). */
export function resetCostsCache(): void {
  costsCache.clear();
}

/** The staff console's feature keys for a meter feature name (`JEV_FEATURES` and the job names). */
export function featureKeyOf(feature: string): string {
  if (feature === "assistant" || feature.startsWith("tex")) return "tex";
  if (feature === "meetingSummary") return "meetings";
  if (["dream", "reflect", "daySummary", "housekeeping"].includes(feature)) return "dream";
  if (feature === "heartbeat" || feature === "checkIn") return "checkin";
  return "other";
}

/** The whole page: loading, a banner for a read that failed, or the artifact's layout. */
export function costsPageHtml(costs: CostsResult | undefined, report: AiCostsReport | undefined): string {
  if (costs === undefined) return `<div class="empty">Loading…</div>`;
  if (!("configured" in costs)) return banner(esc(costs.error));
  if (costs.configured === false) return banner(TOKEN_MISSING);
  if (costs.error) return banner(esc(costs.error));
  return (
    kpisHtml(costs) +
    truncationBanners(costs) +
    `<div class="banner ok"><span class="tx">Matches Cloudflare: ${money(costs.billedUsd)} billed = ${money(costs.totalUsd)} for people + ${money(costs.labRunsUsd)} Lab test runs.</span></div>` +
    whoPaidPanel(costs) +
    dayPanel(costs) +
    `<div class="grid2">${featPanel(costs)}</div>` +
    texPanel(costs) +
    accountsPanel(report)
  );
}

/** The banners under the KPIs: the background job split was cut short, or Cloudflare keeps less than the window. */
function truncationBanners(c: Live): string {
  const meter = c.meterTruncated ? banner("More turns than one read holds: the background job split covers the newest ones.") : "";
  const coverage = c.coverageFrom > c.from ? banner(`Cloudflare keeps 62 days of gateway figures, so this covers from ${dayLabel(c.coverageFrom)}.`) : "";
  return meter + coverage;
}

function kpisHtml(c: Live): string {
  const pct = c.priorUsd > 0 ? Math.round(((c.totalUsd - c.priorUsd) / c.priorUsd) * 100) : null;
  const partial = c.priorPartial ? " (Cloudflare keeps 62 days, so the window before is partial)" : "";
  return (
    `<div class="kpis">` +
    kpi("Spent on AI", money(c.totalUsd), pct === null ? "" : delta(pct, false, "%") + " on the window before" + partial) +
    kpi("Cost per text", c.perTextUsd === null ? "—" : money(c.perTextUsd), c.texts === null ? "" : `Tex replies ÷ ${num(c.texts)} texts`) +
    kpi("Lab test runs", money(c.labRunsUsd), "billed, not in the total") +
    kpi("Out of pocket", money(c.outOfPocketUsd), `of ${money(c.billedUsd)} billed; credits paid the rest`) +
    `</div>`
  );
}

function leftCell(p: Live["payers"][number], colour: string): string {
  if (p.capUsd == null) return `<span class="sub">${esc(p.note ?? "")}</span>`;
  const cap = p.capUsd;
  const used = p.usedUsd ?? 0;
  const left = p.leftUsd ?? cap - used;
  const width = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  const text = left <= 0 ? `all $${cap} spent` : `${money(left)} of $${cap} left`;
  return `<span style="display:inline-block;width:90px;height:6px;border-radius:3px;background:var(--track);vertical-align:middle"><span style="display:block;height:100%;width:${width}%;border-radius:3px;background:var(--${used >= cap ? "bad" : colour})"></span></span> <span class="sub">${text}</span>`;
}

function whoPaidPanel(c: Live): string {
  const tot = c.payers.reduce((a, p) => a + p.usd, 0);
  const share = (usd: number) => (tot > 0 ? (usd / tot) * 100 : 0);
  const colour = (p: Live["payers"][number]) => colourOf(PAYER_COLOUR, p.key);
  const bar = `<div class="share">${c.payers.map((p) => `<i style="width:${share(p.usd)}%;background:var(--${colour(p)})"></i>`).join("")}</div>`;
  const key = legend(
    "pay",
    c.payers.map((p) => [colour(p), `${p.label} ${Math.round(share(p.usd))}%`]),
  );
  const rows = c.payers
    .map(
      (p) =>
        `<tr><td><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--${colour(p)});margin-right:6px"></span>${esc(p.label)}</td><td class="r">${money(p.usd)}</td><td>${leftCell(p, colour(p))}</td></tr>`,
    )
    .join("");
  const table = `<div class="tbl" style="margin-top:8px"><table><tr><th>Paid by</th><th class="r">In ${WIN[S.d]}</th><th>Left</th></tr>${rows}</table></div>`;
  const pace =
    c.devDaysLeft == null ? "" : `<div class="sub" style="margin-top:8px">At this pace dev credits last about ${c.devDaysLeft} more days; after that every call is out of pocket.</div>`;
  return panel("c-pay", "Who paid", "in the order the gateway tries them", bar + key + table + pace);
}

function dayPanel(c: Live): string {
  const title = "Each " + (S.d === "1" ? "hour" : "day") + ", by feature";
  if (!c.daily.length || !c.features.length) return panel("c-day", title, "", `<div class="empty">Nothing spent in ${WIN[S.d]}</div>`);
  const stack = c.features.map((f) => ({ c: colourOf(FEATURE_COLOUR, f.key), v: c.daily.map((day) => day.byFeature.find((b) => b.key === f.key)?.usd ?? 0) }));
  const chart = bars([], { stack, fmt: (v) => "$" + +v.toFixed(2) });
  const key = legend(
    "feat",
    c.features.map((f) => [colourOf(FEATURE_COLOUR, f.key), f.label]),
  );
  return panel("c-day", title, "", chart + key);
}

function featPanel(c: Live): string {
  const rows = c.features
    .filter((f) => f.usd > 0)
    .map(
      (f) =>
        `<tr><td>${esc(f.label)}${f.key === "tex" ? ' <button class="link" data-act="totex">by step ↓</button>' : ""}</td><td class="hp">${esc(f.models.map(modelName).join(" · "))}</td><td class="r">${Math.round(f.share * 100)}%</td><td class="r">${money(f.usd)}</td></tr>`,
    )
    .join("");
  return panel("c-feat", "By feature", "", `<div class="tbl"><table><tr><th>Feature</th><th class="hp">Model</th><th class="r">Share</th><th class="r">Cost</th></tr>${rows}</table></div>`);
}

function texPanel(c: Live): string {
  const rows = c.texSteps
    .filter((s) => s.usd > 0 || s.calls > 0)
    .sort((a, b) => b.usd - a.usd);
  const top = Math.max(0, ...rows.map((s) => s.share));
  const answered = textsDenominator(c);
  const meta = answered ? `${money(c.texUsd)} · ${money(c.texUsd / answered)} a text` : money(c.texUsd);
  const body = rows
    .map(
      (s) =>
        `<tr><td>${esc(s.label)}</td><td class="hp">${esc(TEX_MODEL[s.model] ?? s.model)}</td><td class="r hp">${num(s.calls)}</td><td><span class="tr" style="display:inline-block;width:100%;max-width:160px;height:6px;border-radius:3px;background:var(--track);vertical-align:middle"><span style="display:block;height:100%;width:${top > 0 ? (s.share / top) * 100 : 0}%;border-radius:3px;background:var(--c1)"></span></span> <span class="sub">${(Math.round(s.share * 1000) / 10).toFixed(1)}%</span></td><td class="r">${money(s.usd)}</td><td class="r hp">${answered ? money(s.usd / answered, 3) : "—"}</td></tr>`,
    )
    .join("");
  const off = c.texSteps.filter((s) => !s.on).map((s) => s.label);
  const table = `<div class="tbl"><table><tr><th>Step</th><th class="hp">Model</th><th class="r hp">Calls</th><th>Share of Tex</th><th class="r">Cost</th><th class="r hp">Per text</th></tr>${body}</table></div>`;
  const footer = off.length ? `<div class="sub" style="margin-top:8px">Switched off now and costing nothing: ${esc(off.join(", "))}.</div>` : "";
  return panel("c-tex", "Tex replies by step", meta, table + footer, `<a class="link" href="https://context.lc/lab" target="_blank" rel="noopener">Each step in the Lab ↗</a>`);
}

/** The Split bar: one segment per feature key, coloured as the feature legend, widths from the account's cost. */
function splitOf(byFeature: Array<{ feature: string; costUsd: number }>, total: number): string {
  const sums = new Map<string, number>();
  for (const f of byFeature) {
    const key = featureKeyOf(f.feature);
    sums.set(key, (sums.get(key) ?? 0) + f.costUsd);
  }
  return [...sums].map(([key, usd]) => `<i style="width:${(usd / total) * 100}%;background:var(--${colourOf(FEATURE_COLOUR, key)})"></i>`).join("");
}

function accountsPanel(report: AiCostsReport | undefined): string {
  const title = "By account";
  const meta = S.d === "1" ? "last 7 days; an account pays for the workspaces it owns" : "an account pays for the workspaces it owns";
  if (!report) return panel("c-acc", title, meta, `<div class="empty">Loading…</div>`);
  const rows = report.accounts
    .map((a) => {
      const split = a.costUsd > 0 ? splitOf(a.byFeature, a.costUsd) : "";
      return `<tr class="click" tabindex="0" data-act="sel" data-id="${esc(a.userId)}" aria-selected="${S.x === a.userId}"><td>${esc(a.name ?? a.email ?? a.userId)} <span class="sub">${esc(a.handle ? "@" + a.handle : a.name ? a.email ?? "" : "")}</span></td><td class="hp" style="width:140px"><div class="share">${split}</div></td><td class="r">${money(a.costUsd)}</td></tr>`;
    })
    .join("");
  const more = report.moreAccounts > 0 ? `<div class="sub" style="margin-top:8px">+ ${plural(report.moreAccounts, "more account", "more accounts")}</div>` : "";
  const body = `<div class="tbl"><table><tr><th>Account</th><th class="hp">Split</th><th class="r">Cost</th></tr>${rows || `<tr><td colspan="3" class="empty">Nobody spent in ${accountWindow(S.d)}</td></tr>`}</table></div>${more}`;
  return panel("c-acc", title, meta, body);
}

/** The side panel for one account (the artifact's `P.costs.props`). */
export function accountPropsHtml(account: AiCostsAccount | null | undefined, x: string, report?: AiCostsReport): string {
  const card = report?.accounts.find((a) => a.userId === x);
  const name = card?.name ?? account?.email ?? card?.email ?? x;
  const head = `<div class="pph"><h3 tabindex="-1">${esc(name)}</h3><button class="ib sm" data-act="close" aria-label="Close">${ic("x")}</button></div>`;
  if (account === undefined) return head + `<div class="empty">Loading…</div>`;
  if (account === null) return head + `<div class="empty">Account not found</div>`;
  const limits = account.today.length
    ? `<div class="fun">${account.today
        .map((t) => `<div class="r"><span>${esc(t.label)}</span><span class="tr"><span class="bb" style="width:${t.cap > 0 ? Math.min(100, (t.used / t.cap) * 100) : 0}%"></span></span><span class="t">${num(t.used)} of ${num(t.cap)}</span></div>`)
        .join("")}</div>`
    : `<div class="sub">No capped features today</div>`;
  const ws = account.rows.length
    ? account.rows.map((r) => `<tr><td>@${esc(r.workspace)}</td><td>${esc(r.label)}</td><td class="r">${money(r.costUsd)}</td></tr>`).join("")
    : `<tr><td colspan="3" class="empty">Nothing spent in ${accountWindow(S.d)}</td></tr>`;
  return (
    head +
    `<div class="kpis">${kpi("AI, " + accountWindow(S.d), money(account.totalUsd))}${kpi("Per text", account.perQuestionUsd === null ? "—" : money(account.perQuestionUsd))}</div>` +
    `<div class="ppb"><div class="h">Today against today's limits</div>${limits}</div>` +
    `<div class="ppb"><div class="h">By workspace</div><div class="tbl"><table>${ws}</table></div></div>` +
    `<button class="link" data-act="person" data-id="${esc(account.userId)}">Open in People</button>`
  );
}

