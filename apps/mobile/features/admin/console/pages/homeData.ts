/**
 * The console's Home page, as data: the five tiles on top and the "Needs you" list under them (Dev2, 2026-11-14:
 * "metric tiles on top, Needs you under them"). Pure functions over what the existing staff queries return, so every
 * figure on the page can be checked without mounting anything. The page is `HomePage.web.tsx`; the mock it copies is
 * the staff console artifact's `P.home` and `needsList`.
 */

/** The console's window, in days, as its `d` URL key holds it. */
export type ConsoleWindow = "1" | "7" | "30" | "90";

export const WINDOW_WORDS: Readonly<Record<ConsoleWindow, string>> = {
  "1": "24 hours",
  "7": "7 days",
  "30": "30 days",
  "90": "90 days",
};

export const DAY_MS = 86_400_000;

/** `[from, to)` for a window ending now, and the same-length window before it. */
export function windowRange(d: ConsoleWindow, now: number): { from: number; to: number; priorFrom: number } {
  const span = Number(d) * DAY_MS;
  return { from: now - span, to: now, priorFrom: now - 2 * span };
}

/** `$1,234.56`, as the mock's `money`. */
export function money(usd: number, digits = 2): string {
  const value = Number.isFinite(usd) ? usd : 0;
  return "$" + value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A signed change, and whether it is the good direction (the mock's `delta`). */
export type Delta = { text: string; good: boolean };

export function delta(change: number, upIsGood: boolean, unit = ""): Delta {
  // `|| 0` so a fall that rounds away reads +0, never -0.
  const rounded = Math.round(change * 100) / 100 || 0;
  return { text: `${rounded >= 0 ? "+" : ""}${rounded}${unit}`, good: rounded >= 0 === upIsGood };
}

/** Percent change from `prior` to `now`, or null when there was nothing before to compare with. */
export function percentChange(now: number, prior: number): number | null {
  if (!(prior > 0)) return null;
  return Math.round(((now - prior) / prior) * 100);
}

/** `texStats` reads at most this many days back: Cloudflare keeps the gateway's costs about two months (`MAX_STATS_DAYS`). */
export const STATS_MAX_DAYS = 60;

/**
 * The windows Home asks `texStats` for: the window, cut to the days the gateway keeps (`partial` when cut), and the
 * window before it only when all of it is still kept, so a change is never measured against a window cut short
 * (review of #3291).
 */
export function statsWindows(d: ConsoleWindow, now: number): { from: number; to: number; partial: boolean; prior: { from: number; to: number } | null } {
  const span = Number(d) * DAY_MS;
  const earliest = now - STATS_MAX_DAYS * DAY_MS;
  const from = Math.max(now - span, earliest);
  const priorFrom = now - 2 * span;
  return { from, to: now, partial: from > now - span, prior: priorFrom >= earliest ? { from: priorFrom, to: now - span } : null };
}

/** Texts in, 1:1 and group. */
const textsIn = (stats: TexStatsLike) => stats.texts.inOne + stats.texts.inGroup;

/** Cost per text, or null when the cost is unknown: texts with no cost behind them read as unknown, never as free. */
export function knownPerText(stats: TexStatsLike | null | undefined): number | null {
  if (!stats) return null;
  if (textsIn(stats) > 0 && !(stats.cost.totalUsd > 0)) return null;
  return stats.costPerTextUsd;
}

/** The window's spend, or null when texts came in and no cost is known for them. */
export function knownSpend(stats: TexStatsLike | null | undefined): number | null {
  if (!stats) return null;
  if (textsIn(stats) > 0 && !(stats.cost.totalUsd > 0)) return null;
  return stats.cost.totalUsd;
}

// -- tiles -------------------------------------------------------------------------------------------------------------

/** What `texStats.report` answers, the parts Home and Usage read. */
export type TexStatsLike = {
  configured: true;
  dailyActive: number;
  people: { one: number; group: number; any: number };
  texts: { inOne: number; inGroup: number; outOne: number; outGroup: number };
  cost: { totalUsd: number };
  costPerTextUsd: number | null;
  notes: { created: number };
  series: { at: number; people: number; textsIn: number; usd: number; notesCreated: number }[];
};

/** What the AI costs action answers, the parts Home reads (`admin.consoleCosts`). */
export type CostsLike = {
  totalUsd: number;
  outOfPocketUsd: number;
  perTextUsd: number | null;
  priorPerTextUsd: number | null;
  daily?: { usd: number }[];
};

export type Tile = {
  key: string;
  label: string;
  value: string;
  /** The line under the value; `delta` is drawn first, coloured, when set. */
  detail: string;
  delta?: Delta;
  /** The page a tile opens. */
  go: string;
  spark: number[];
  color: "c1" | "c2" | "c3" | "c4" | "c5";
};

/**
 * The five tiles. `stats` is null while it loads or when the deployment has no analytics token; a tile then reads `—`
 * rather than a zero nobody measured.
 */
export function homeTiles(input: {
  d: ConsoleWindow;
  stats: TexStatsLike | null;
  costs: CostsLike | null;
  /** Accounts, for "of N people". */
  accounts: number | null;
  /** Turns Tex answered in the window (`agentReport` texts `current.answered`). */
  answered: number | null;
  /** Cost per text in the window before, when `costs` does not say (from `texStats` of that window). */
  priorPerText?: number | null;
  /** The window was cut to the days `texStats` keeps; its tiles say so. */
  partial?: boolean;
}): Tile[] {
  const { d, stats, costs, accounts, answered } = input;
  const series = stats?.series ?? [];
  const dash = "—";
  const people = stats?.people;
  // Both sides counted by the same id, the sender's inbox: whoever texts Tex 1:1 has an account (or was let in to
  // make one), and a guest is somebody Tex only hears from in group chats.
  const withAccounts = people?.one ?? 0;
  const guests = Math.max(0, (people?.any ?? 0) - withAccounts);
  const received = stats ? textsIn(stats) : null;
  const perText = costs ? costs.perTextUsd : knownPerText(stats);
  const priorPerText = costs ? costs.priorPerTextUsd : (input.priorPerText ?? null);
  const total = costs ? costs.totalUsd : knownSpend(stats);
  // The window cut to the days `texStats` keeps reads "last 60 days" on the tiles it touches (review of #3291).
  const cut = input.partial && stats ? `last ${STATS_MAX_DAYS} days` : "";
  const line = (...parts: string[]) => parts.filter(Boolean).join(" · ");
  const daily = stats?.dailyActive;
  // Counts are drawn as the artifact draws them, with no thousands separator ("1714 answered").
  const count = (n: number) => String(n);
  return [
    {
      key: "dap",
      label: "Daily active people",
      value: daily == null ? dash : d === "1" ? String(people?.any ?? 0) : (Math.round(daily * 10) / 10).toString(),
      detail: line(accounts == null ? "" : `of ${accounts} people`, cut),
      go: "people",
      spark: series.map((p) => p.people),
      color: "c5",
    },
    {
      key: "texters",
      label: "People texting Tex",
      value: people ? String(people.any) : dash,
      detail: line(people ? `${withAccounts} with accounts · ${guests} guests` : "", cut),
      go: "turns",
      spark: series.map((p) => p.people),
      color: "c4",
    },
    {
      key: "texts",
      label: "Texts received",
      value: received == null ? dash : count(received),
      detail: line(answered == null ? "" : `${count(answered)} answered`, cut),
      go: "turns",
      spark: series.map((p) => p.textsIn),
      color: "c1",
    },
    {
      key: "cpt",
      label: "Cost per text",
      value: perText == null ? dash : money(perText),
      // The change is drawn first, so the words after it start with a space: "-0.03 vs the window before".
      detail: perText != null && priorPerText != null ? " vs the window before" : costs ? "" : cut,
      delta: perText != null && priorPerText != null ? delta(perText - priorPerText, false) : undefined,
      go: "costs",
      spark: series.map((p) => (p.textsIn > 0 ? p.usd / p.textsIn : 0)),
      color: "c2",
    },
    {
      key: "spent",
      label: "Spent on AI",
      value: total == null ? dash : money(total),
      detail: costs ? `${money(costs.outOfPocketUsd)} of it out of pocket` : cut,
      go: "costs",
      spark: costs?.daily?.length ? costs.daily.map((p) => p.usd) : series.map((p) => p.usd),
      color: "c3",
    },
  ];
}

// -- needs you ---------------------------------------------------------------------------------------------------------

/** Where a need's row goes: a page, its sub-path, a selected row and filters, as the console's `go` takes them. */
export type Target = { page: string; subs?: string[]; x?: string | null; f?: Record<string, string> };

export type NeedLine = {
  key: string;
  tone: "warn" | "bad";
  /** The bold words, then the rest of the sentence. */
  bold: string;
  rest: string;
  /** The page's name, shown at the right. */
  where: string;
  target: Target;
};

export type NeedsSources = {
  /** Credentials the code expects that are not set (`unsetKnownSecrets`). */
  secretsUnset: number | undefined;
  /** Open content reports; `viaTex` when the report rows say which came by text. */
  openReports: { count: number; viaTex: number | null } | undefined;
  /** Turns that did not finish in the window (`agentReport` texts). */
  unfinished: { exhausted: number; failed: number } | undefined;
  /** People waiting on the waitlist. */
  waiting: number | undefined;
  /** People let in by phone but never told. */
  untold: number | undefined;
  /** Workspaces whose search index failed. */
  failedIndexes: number | undefined;
  /** Workspaces (slugs) whose backup encryption check failed. */
  failedBackups: string[] | undefined;
  /** Workspaces whose mail inbox takes mail from anyone, and the account that owns each. */
  mailOpen: { slug: string; ownerId: string }[] | undefined;
};

/** The list, in the mock's order. A source still loading adds nothing; it never reads as "nothing needs you". */
export function needsList(s: NeedsSources): NeedLine[] {
  const out: NeedLine[] = [];
  const n = (v: number | undefined): number => (typeof v === "number" && v > 0 ? v : 0);
  if (n(s.secretsUnset)) {
    const c = n(s.secretsUnset);
    out.push({ key: "credentials", tone: "warn", bold: plural(c, "credential", "credentials"), rest: ` the code expects ${c > 1 ? "are" : "is"} not set`, where: "Credentials", target: { page: "credentials" } });
  }
  if (s.openReports && s.openReports.count > 0) {
    const r = s.openReports;
    out.push({ key: "reports", tone: "bad", bold: plural(r.count, "open report", "open reports"), rest: r.viaTex == null ? "" : `, ${r.viaTex} texted to Tex`, where: "Reports", target: { page: "reports" } });
  }
  if (s.unfinished) {
    const { exhausted, failed } = s.unfinished;
    const total = exhausted + failed;
    if (total > 0) out.push({ key: "turns", tone: "warn", bold: plural(total, "turn", "turns"), rest: ` didn't finish (${exhausted} ran out of steps, ${failed} failed)`, where: "Turns", target: { page: "turns", f: { end: "trouble" } } });
  }
  if (n(s.waiting)) out.push({ key: "waiting", tone: "warn", bold: plural(n(s.waiting), "person", "people"), rest: " waiting to be let in", where: "People", target: { page: "people", f: { ps: "waiting" } } });
  if (n(s.untold)) out.push({ key: "untold", tone: "warn", bold: plural(n(s.untold), "person", "people"), rest: " let in by phone but never told", where: "People", target: { page: "people", f: { ps: "in", told: "no" } } });
  if (n(s.failedIndexes)) out.push({ key: "indexes", tone: "bad", bold: plural(n(s.failedIndexes), "workspace", "workspaces"), rest: " with a failed search index", where: "Search", target: { page: "search", subs: ["indexes"] } });
  const backups = s.failedBackups ?? [];
  if (backups.length === 1) out.push({ key: "backup", tone: "bad", bold: `@${backups[0]}`, rest: " failed its backup encryption check", where: "Storage", target: { page: "storage" } });
  else if (backups.length > 1) out.push({ key: "backup", tone: "bad", bold: plural(backups.length, "workspace", "workspaces"), rest: " failed their backup encryption check", where: "Storage", target: { page: "storage" } });
  for (const { slug, ownerId } of s.mailOpen ?? []) {
    out.push({ key: `mail-${slug}`, tone: "warn", bold: `@${slug}'s mail inbox`, rest: " takes mail from anyone", where: "People", target: { page: "people", x: ownerId } });
  }
  return out;
}
