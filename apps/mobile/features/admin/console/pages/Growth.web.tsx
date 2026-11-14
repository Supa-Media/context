/**
 * Growth: the artifact's `P.growth`. Four tiles, "How far people get" (the funnel, Everyone or From the waitlist),
 * "Newest arrivals" and "Needs a nudge", as the mock draws them. The numbers come from `growthData.ts`; the reads come
 * from `censusReport` and `usageReport` (read once, see `useReportOnce`) and the People page's list of everyone.
 */
import { useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "@context/convex/_generated/api";
import { esc, kpi, panel, pill, seg } from "../kit";
import { S, go, setF } from "../state";
import type { ConsolePage } from "../types";
import { useReportOnce } from "../../useReportOnce";
import {
  displayName,
  firstName,
  fromPill,
  growthFunnel,
  growthTiles,
  monthDay,
  newestArrivals,
  nudges,
  type CensusLike,
  type PersonLike,
  type UsageLike,
} from "./growthData";

/** One row of `consolePeople.everyone`'s `accounts`, as the People page's query returns it. */
type EveryoneAccount = {
  userId: string;
  name: string | null;
  handle: string | null;
  emails: string[];
  phone: string | null;
  joinedAt: number;
  archived: boolean;
  lastSeenAt: number | null;
  from: PersonLike["from"];
  invitedBy: string | null;
  clients: { name: string; lastUsedAt: number | null }[];
};

type GrowthData = {
  census: CensusLike | undefined;
  usage: UsageLike | undefined;
  people: PersonLike[] | undefined;
};

const TILE_LABELS = ["Accounts", "Workspaces", "Active workspaces", "Can text Tex"] as const;

function useGrowthData(): GrowthData {
  const census = useReportOnce(api.functions.admin.censusReport, { days: 30 });
  const usage = useReportOnce(api.functions.admin.usageReport, { days: 30 });
  const everyone: { accounts: EveryoneAccount[] } | undefined = useQuery(api.functions.consolePeople.everyone, {});
  const people = useMemo<PersonLike[] | undefined>(
    () =>
      everyone?.accounts.map((a) => ({
        id: a.userId,
        name: a.name,
        handle: a.handle,
        emails: a.emails,
        phone: a.phone,
        joinedAt: a.joinedAt,
        from: a.from,
        invitedBy: a.invitedBy,
        clients: a.clients.length,
        lastSeenAt: a.lastSeenAt,
        archived: a.archived,
      })),
    [everyone],
  );
  return { census, usage, people };
}

const audience = (): "all" | "wait" => (S.f.aud === "wait" ? "wait" : "all");

function tiles(d: GrowthData | undefined): string {
  if (!d?.census) return TILE_LABELS.map((l) => kpi(esc(l), "—")).join("");
  return growthTiles(d.census, d.usage)
    .map((t) => kpi(esc(t.label), esc(t.value), esc(t.detail)))
    .join("");
}

function newest(people: PersonLike[] | undefined): string {
  if (!people) return `<div class="empty">Loading…</div>`;
  return `<div class="tl">${newestArrivals(people).map((p) => {
    const pl = fromPill(p);
    return `<div class="it"><span class="sub">${esc(monthDay(p.joinedAt ?? 0))}</span><button class="link" data-act="person" data-id="${esc(p.id)}" style="color:var(--text)">${esc(displayName(p))}</button>${pl ? pill(pl.text, pl.tone) : ""}</div>`;
  }).join("")}</div>`;
}

function funnel(census: CensusLike | undefined, aud: "all" | "wait"): string {
  if (!census) return `<div class="empty">Loading…</div>`;
  return `<div class="fun">${growthFunnel(census, aud)
    .map((r) => `<div class="r"><span>${esc(r.label)}</span><span class="tr"><span class="bb" style="width:${r.width}%"></span></span><span class="t">${esc(r.count)} · ${esc(r.pct)}%</span></div>`)
    .join("")}</div>`;
}

function nudge(people: PersonLike[] | undefined): string {
  if (!people) return `<div class="empty">Loading…</div>`;
  return `<div class="needs">${nudges(people, Date.now())
    .map(
      (n) =>
        `<div class="need"><span class="tx">${esc(n.label)}</span><span class="chips">${
          n.people.length
            ? n.people.map((p) => `<button class="pill acc" data-act="person" data-id="${esc(p.id)}">${esc(firstName(p))}</button>`).join("")
            : '<span class="sub">nobody</span>'
        }</span></div>`,
    )
    .join("")}</div>`;
}

export const growthPage: ConsolePage<GrowthData> = {
  key: "growth",
  filters: { aud: "all" },
  windowed: false,
  useData: useGrowthData,
  render: (d) => {
    const aud = audience();
    return (
      `<div class="kpis">${tiles(d)}</div>` +
      `<div class="grid2">` +
      panel("g-new", "Newest arrivals", "", newest(d?.people)) +
      panel("g-fun", "How far people get", "", funnel(d?.census, aud), seg("Audience", [["all", "Everyone"], ["wait", "From the waitlist"]], aud, "aud")) +
      panel("g-nudge", "Needs a nudge", "", nudge(d?.people)) +
      `</div>`
    );
  },
  acts: {
    aud: (el) => setF("aud", el.dataset.v ?? "all"),
    person: (el) => go("people", [], el.dataset.id ?? null),
  },
};
