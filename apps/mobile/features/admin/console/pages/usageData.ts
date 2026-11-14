/**
 * The console's Usage page, as data: site visits and time in the app (PostHog, `usageAnalytics.report`), the events
 * we count ourselves (`admin.usageReport`, plus notes created from `texStats.report`), the journeys, the connected AI
 * clients and the capture sources (`admin.censusReport`). Pure functions; the page is `UsagePage.web.tsx` and the mock
 * it copies is the staff console artifact's `P.usage`.
 */

import type { UsageFunnelId, UsageStepId } from "@context/shared";
import { formatDuration } from "../../usage";
import { delta, percentChange, type Delta } from "./homeData";

export type UsageTile = { key: string; label: string; value: string; detail: string; delta?: Delta };

type Site = { host: string; visits: number; visitors: number; priorVisits: number };
type Time = { sessions: number; people: number; medianSeconds: number; totalSeconds: number };

export type AnalyticsLike =
  | { connected: false }
  | { connected: true; error: string }
  | {
      connected: true;
      error: null;
      sites: Site[];
      time: Time | null;
      priorTime: Time | null;
      funnels?: { id: string; steps: { key: string; people: number }[] }[];
    };

export function analyticsReady(a: AnalyticsLike | undefined): a is Extract<AnalyticsLike, { error: null }> {
  return a !== undefined && a.connected && a.error === null;
}

/** Why the PostHog half is empty, in our words; null when it answered. */
export function analyticsNote(a: AnalyticsLike | undefined): string | null {
  if (a === undefined) return null;
  if (!a.connected) return "PostHog is not connected on this deployment.";
  if (a.error !== null) return a.error;
  return null;
}

function siteTile(key: string, host: string, a: AnalyticsLike | undefined): UsageTile {
  const site = analyticsReady(a) ? a.sites.find((s) => s.host === host) : undefined;
  if (!site) return { key, label: `${host} visits`, value: "—", detail: "" };
  const change = percentChange(site.visits, site.priorVisits);
  return {
    key,
    label: `${host} visits`,
    value: String(site.visits),
    detail: `${site.visitors} visitors · `,
    delta: change === null ? undefined : delta(change, true, "%"),
  };
}

export function usageTiles(a: AnalyticsLike | undefined): UsageTile[] {
  const ready = analyticsReady(a) ? a : null;
  const time = ready?.time ?? null;
  const prior = ready?.priorTime ?? null;
  return [
    siteTile("ctx", "context.lc", a),
    siteTile("tex", "tex.lc", a),
    {
      key: "session",
      label: "Typical session",
      value: time ? formatDuration(time.medianSeconds) : "—",
      detail: time ? " · active time" : "",
      delta: time && prior ? delta(Math.round(time.medianSeconds - prior.medianSeconds), true, "s") : undefined,
    },
    {
      key: "hours",
      label: "Hours in the app",
      // Tile figures carry no thousands separator, as the artifact draws them.
      value: time ? String(Math.round(time.totalSeconds / 3600)) : "—",
      detail: time && time.people > 0 ? `${(Math.round((time.sessions / time.people) * 10) / 10).toFixed(1)} sessions a person` : "",
    },
  ];
}

/** The Events table's rows, in the mock's order: our own counters, by metric. */
export const EVENT_ROWS: readonly { label: string; metric: string }[] = [
  { label: "Tool calls", metric: "mcp.tool_call" },
  { label: "Searches", metric: "search.query" },
  { label: "Notes written", metric: "note.write" },
  { label: "Notes created", metric: "notes.created" },
  { label: "AI client connections", metric: "mcp.session" },
  { label: "App sessions", metric: "app.session" },
  { label: "Sign-ins", metric: "account.signin" },
];

export type Series = { metric: string; points: { day: string; count: number }[]; total: number };

export type EventRow = { label: string; total: number; trend: number[]; change: Delta | null };

/**
 * One row per counter. The total is the window's (`totals`); the trend and "today vs yesterday" are always the last 14
 * calendar days (`daily`), whatever the window, so a 24-hour window never compares two hours (review of #3291).
 * Notes created come from the workspace objects' own counts (`texStats`), the rest from `usageReport`.
 */
export function eventRows(
  totals: readonly Series[],
  daily: readonly Series[],
  notesCreated: { total: number; daily: number[] } | null,
): EventRow[] {
  return EVENT_ROWS.map(({ label, metric }) => {
    const notes = metric === "notes.created";
    const points = notes ? (notesCreated?.daily ?? []) : (daily.find((s) => s.metric === metric)?.points.map((p) => p.count) ?? []);
    const total = notes ? (notesCreated?.total ?? 0) : (totals.find((s) => s.metric === metric)?.total ?? 0);
    const today = points.at(-1) ?? 0;
    const yesterday = points.at(-2) ?? 0;
    // Two days with nothing on either read +0%, as the artifact's flat rows do; something after nothing, or no days at
    // all, has no percentage.
    const pct = points.length >= 2 && today === 0 && yesterday === 0 ? 0 : percentChange(today, yesterday);
    return { label, total, trend: points.slice(-14), change: pct === null ? null : delta(pct, true, "%") };
  });
}

export type Journey = { id: string; title: string; steps: { label: string; people: number; pct: number; width: number }[] };

/**
 * The six journeys as the artifact names them, over the funnels PostHog counts (`USAGE_FUNNELS` in `@context/shared`).
 * Where the artifact names a step nothing records ("Opened sign-in", "Invited someone", "Sent first text"), the
 * nearest recorded step stands in; the handoff has no recorded third step, so it shows two.
 */
export const JOURNEYS: readonly { id: UsageFunnelId; title: string; steps: readonly [UsageStepId, string][] }[] = [
  { id: "context_waitlist", title: "Context waitlist", steps: [["landing", "Opened context.lc"], ["signup_started", "Started the form"], ["waitlist_joined", "Joined"]] },
  { id: "tex_waitlist", title: "Tex waitlist", steps: [["landing", "Opened tex.lc"], ["signup_started", "Typed a phone"], ["waitlist_joined", "Joined"]] },
  { id: "context_signin", title: "Context sign-in", steps: [["code_sent", "Sent a code"], ["code_submitted", "Typed the code"], ["signed_in", "Signed in"]] },
  { id: "tex_signin", title: "Tex sign-in", steps: [["code_sent", "Got the code"], ["code_submitted", "Typed the code"], ["signed_in", "Signed in"]] },
  { id: "context_setup", title: "New workspace", steps: [["setup_started", "Opened"], ["workspace_created", "Named it"], ["setup_completed", "Finished setup"]] },
  { id: "tex_handoff", title: "Tex Messages handoff", steps: [["text_page", "Shown"], ["messages_opened", "Opened Messages"]] },
];

export function journeys(a: AnalyticsLike | undefined): Journey[] {
  if (!analyticsReady(a)) return [];
  return JOURNEYS.flatMap((def) => {
    const value = a.funnels?.find((f) => f.id === def.id);
    if (!value) return [];
    const steps = def.steps.map(([key, label]) => ({ label, people: value.steps.find((s) => s.key === key)?.people ?? 0 }));
    const first = steps[0]?.people ?? 0;
    return [
      {
        id: def.id,
        title: def.title,
        steps: steps.map((s) => {
          const share = first > 0 ? s.people / first : 0;
          return { label: s.label, people: s.people, pct: Math.round(share * 100), width: share * 100 };
        }),
      },
    ];
  });
}

/** `2m ago`, `1h ago`, `4d ago`; `never` for null. */
export function ago(at: number | null, now: number): string {
  if (at === null) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export type ClientLike = { clientId: string; clientName: string; active: number; accounts: number; lastUsedAt: number | null };

export function clientRows(clients: readonly ClientLike[], now: number): { key: string; name: string; grants: number; people: number; last: string }[] {
  return [...clients]
    .filter((c) => c.active > 0)
    .sort((a, b) => b.active - a.active || (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    .map((c) => ({ key: c.clientId, name: c.clientName, grants: c.active, people: c.accounts, last: ago(c.lastUsedAt, now) }));
}

export type SourcesLike = {
  googleAccounts: number;
  gmail: number;
  calendar: number;
  chat: number;
  mailOpen: number;
  mailAllowlisted: number;
  obsidian: number;
  mailOpenSlugs?: string[];
};

export function captureRows(s: SourcesLike): { k: string; v: string; pills: string[] }[] {
  return [
    { k: "Google accounts", v: `${s.googleAccounts} · mail ${s.gmail} · calendar ${s.calendar} · chat ${s.chat}`, pills: [] },
    { k: "Mail capture", v: `${s.mailAllowlisted} allowlisted · ${s.mailOpen} open to anyone`, pills: (s.mailOpenSlugs ?? []).map((slug) => `@${slug}`) },
    { k: "Obsidian plugin", v: `${s.obsidian} ${s.obsidian === 1 ? "workspace" : "workspaces"}`, pills: [] },
  ];
}
