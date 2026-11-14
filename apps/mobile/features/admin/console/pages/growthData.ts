/**
 * The console's Growth page, as data: four tiles, the funnel ("How far people get") with its Everyone / From the
 * waitlist switch, the newest arrivals and the people who need a nudge. Pure functions over `admin.censusReport`,
 * `admin.usageReport` and the People page's list of everyone (`consolePeople.everyone`). The page is
 * `GrowthPage.web.tsx`; the mock it copies is the staff console artifact's `P.growth`.
 */

export type Audience = "all" | "wait";

export const FUNNEL_LABELS: Readonly<Record<string, string>> = {
  "let-in": "Let in from the waitlist",
  "signed-up": "Signed up",
  "texted-tex": "Texted Tex",
  "connected-a-client": "Connected an AI client",
  "in-a-shared-workspace": "In a shared workspace",
};

export type FunnelRow = { label: string; count: number; pct: number; width: number };

/** Each step's bar is a share of the first step, as the mock draws it. */
export function funnelRows(steps: readonly { step: string; count: number }[]): FunnelRow[] {
  const first = steps[0]?.count ?? 0;
  return steps.map(({ step, count }) => {
    const share = first > 0 ? count / first : 0;
    return { label: FUNNEL_LABELS[step] ?? step, count, pct: Math.round(share * 100), width: share * 100 };
  });
}

/** The census parts Growth reads. */
export type CensusLike = {
  accounts: { total: { count: number; isFloor: boolean }; newInWindow: number };
  contexts: { total: { count: number; isFloor: boolean }; personal: number; shared: number };
  growthFunnel?: { step: string; count: number }[];
  waitlist: { growthFunnel?: { step: string; count: number }[] };
  texAccess?: { canText: number; phoneButOff: number };
};

export type UsageLike = { activeContexts: { points: { day: string; count: number }[]; distinctInWindow: number } };

export type GrowthTile = { key: string; label: string; value: string; detail: string };

const total = (t: { count: number; isFloor: boolean }): string => `${t.count.toLocaleString("en-US")}${t.isFloor ? "+" : ""}`;

export function growthTiles(census: CensusLike, usage: UsageLike | null | undefined): GrowthTile[] {
  const today = usage?.activeContexts.points.at(-1)?.count ?? 0;
  return [
    { key: "accounts", label: "Accounts", value: total(census.accounts.total), detail: `+${census.accounts.newInWindow} in 30 days` },
    { key: "workspaces", label: "Workspaces", value: total(census.contexts.total), detail: `${census.contexts.personal} personal · ${census.contexts.shared} shared` },
    { key: "active", label: "Active workspaces", value: usage ? String(usage.activeContexts.distinctInWindow) : "—", detail: usage ? `${today} today` : "" },
    {
      key: "tex",
      label: "Can text Tex",
      value: census.texAccess ? String(census.texAccess.canText) : "—",
      detail: census.texAccess ? `${census.texAccess.phoneButOff} with a phone but switched off` : "",
    },
  ];
}

/**
 * The funnel for Everyone, or for people from the waitlist. The waitlist's stops at "Connected an AI client", as the
 * artifact draws it: four rows, "Let in from the waitlist" first.
 */
export function growthFunnel(census: CensusLike, audience: Audience): FunnelRow[] {
  if (audience === "wait") return funnelRows((census.waitlist.growthFunnel ?? []).filter((s) => s.step !== "in-a-shared-workspace"));
  return funnelRows(census.growthFunnel ?? []);
}

/** One person, as the People page's list of everyone gives them; only the fields Growth reads. */
export type PersonLike = {
  id: string;
  name: string | null;
  handle: string | null;
  emails?: string[];
  phone?: string | null;
  /** Only accounts arrive; somebody still waiting has no `joinedAt`. */
  joinedAt: number | null;
  from: "waitlist" | "friend" | "ad" | "staff" | "direct" | null;
  invitedBy: string | null;
  clients: number;
  lastSeenAt: number | null;
  archived?: boolean;
};

/** "@handle", else the first address, else the phone (Dev2, 2026-11-14). */
export function displayName(p: PersonLike): string {
  return p.name || (p.handle ? `@${p.handle}` : p.emails?.[0] || p.phone || "?");
}

export function firstName(p: PersonLike): string {
  return displayName(p).split(" ")[0] ?? "?";
}

export type FromPill = { text: string; tone: "" | "team" | "warn" } | null;

/**
 * The pill by a newest arrival. "invited by Maya", as the artifact has it: `invitedBy` is the inviter's handle, so it
 * reads as their first name when they are among `people`, and as @handle when not.
 */
export function fromPill(p: PersonLike, people: readonly PersonLike[] = []): FromPill {
  if (p.from === "waitlist") return { text: "waitlist", tone: "" };
  if (p.from === "friend") {
    if (!p.invitedBy) return { text: "invited", tone: "team" };
    const inviter = people.find((q) => q.handle === p.invitedBy);
    return { text: `invited by ${inviter ? firstName(inviter) : `@${p.invitedBy}`}`, tone: "team" };
  }
  if (p.from === "ad") return { text: "ad", tone: "warn" };
  return null;
}

/** `11/14`, in UTC like every day on the console. */
export function monthDay(at: number): string {
  const d = new Date(at);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

const accountsOf = (people: readonly PersonLike[]) => people.filter((p) => p.joinedAt !== null && !p.archived);

export function newestArrivals(people: readonly PersonLike[], count = 5): PersonLike[] {
  return [...accountsOf(people)].sort((a, b) => (b.joinedAt ?? 0) - (a.joinedAt ?? 0)).slice(0, count);
}

const HOUR = 3_600_000;

/** Not seen for this long, an account "never came back" (the artifact's `lastN > 100`, in hours). */
export const AWAY_MS = 100 * HOUR;

/**
 * The three "Needs a nudge" rows. "Never came back" is an account last seen more than 100 hours ago, as the artifact
 * has it; one never seen counts from when it joined, so somebody who signed up an hour ago is not on it yet.
 */
export function nudges(people: readonly PersonLike[], now: number): { label: string; people: PersonLike[] }[] {
  const A = accountsOf(people);
  return [
    { label: "No AI client", people: A.filter((p) => p.clients === 0) },
    {
      label: "Never came back",
      people: A.filter((p) => (p.lastSeenAt ?? p.joinedAt ?? now) < now - AWAY_MS),
    },
    { label: "No phone for Tex", people: A.filter((p) => !p.phone) },
  ];
}
