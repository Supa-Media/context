/**
 * Settings: the artifact's `P.settings`. "For you" is this staff member's signup-email switch
 * (`admin.setSignupAlerts`, the real setting); "Community links" are the outside links the app
 * shows, saved and deleted through `admin.saveCommunityLink` and `admin.deleteCommunityLink`.
 */
import { useMutation, useQueries } from "convex/react";
import { useMemo } from "react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { confirmBox, esc, panel, sw } from "../kit";
import { S, render, toast } from "../state";
import type { ConsolePage } from "../types";

type CommunityLink = { id: string; kind: string; label: string; url: string; audience: "members" | "everyone"; position: number };
type Loaded<T> = T | Error | undefined;

export type SettingsData = {
  alerts: Loaded<{ on: boolean; email: string }>;
  links: Loaded<CommunityLink[]>;
  setAlerts: (a: { on: boolean }) => Promise<unknown>;
  saveLink: (a: { kind: "discord" | "github" | "x" | "newsletter" | "other"; label: string; url: string; audience: "members" | "everyone" }) => Promise<unknown>;
  deleteLink: (a: { id: Id<"communityLinks"> }) => Promise<unknown>;
};

const KINDS = ["discord", "github", "x", "newsletter", "other"] as const;
const AUDIENCE: Record<CommunityLink["audience"], string> = { members: "Signed-in only", everyone: "Everyone" };
const LOADING = '<div class="empty">Loading…</div>';
const ok = <T,>(v: Loaded<T>): T | undefined => (v instanceof Error ? undefined : v);
const errorWords = (e: unknown) => {
  const data = (e as { data?: { message?: unknown } })?.data;
  const message = typeof data?.message === "string" ? data.message : (e as { message?: unknown })?.message;
  return typeof message === "string" && message.length > 0 ? message.slice(0, 160) : "That didn't work. Try again.";
};

function useSettingsData(): SettingsData {
  const specs = useMemo(
    () => ({
      alerts: { query: api.functions.admin.getSignupAlerts, args: {} },
      links: { query: api.functions.admin.listCommunityLinks, args: {} },
    }),
    [],
  );
  const got = useQueries(specs);
  return {
    alerts: got.alerts as Loaded<{ on: boolean; email: string }>,
    links: got.links as Loaded<CommunityLink[]>,
    setAlerts: useMutation(api.functions.admin.setSignupAlerts) as SettingsData["setAlerts"],
    saveLink: useMutation(api.functions.admin.saveCommunityLink) as SettingsData["saveLink"],
    deleteLink: useMutation(api.functions.admin.deleteCommunityLink) as SettingsData["deleteLink"],
  };
}

function linksPanel(d: SettingsData | undefined) {
  const links = ok(d?.links);
  const meta = links ? String(links.length) : "";
  const adding = S.adding
    ? `<div class="row" style="margin-top:10px"><select class="search" id="lk" style="max-width:130px" aria-label="Kind">${KINDS.map((k) => `<option>${k}</option>`).join("")}</select><input class="search" id="ll" placeholder="Label" aria-label="Label"><input class="search" id="lu" placeholder="https://" aria-label="Address"><select class="search" id="la" style="max-width:150px" aria-label="Who sees it"><option value="members">Signed-in only</option><option value="everyone">Everyone</option></select><button class="primary" data-act="addlink">Add</button><button class="ghost" data-act="addcancel">Cancel</button></div>`
    : "";
  const body = links
    ? `<div class="tbl"><table><tr><th>Kind</th><th>Label</th><th class="hp">Address</th><th class="hp">Who sees it</th><th></th></tr>${links
        .map((l) => {
          const id = esc(l.id);
          const del =
            S.confirm === "rl" + l.id
              ? confirmBox(`Delete ${esc(l.label)}?`, "Delete", "rmlink", l.id, true)
              : `<button class="ghost danger" data-act="askrmlink" data-id="${id}">Delete</button>`;
          return `<tr><td>${esc(l.kind)}</td><td>${esc(l.label)}</td><td class="mono hp">${esc(l.url)}</td><td class="hp">${AUDIENCE[l.audience] ?? esc(l.audience)}</td><td class="r">${del}</td></tr>`;
        })
        .join("") || '<tr><td colspan="5" class="empty">No community links yet</td></tr>'}</table></div>${adding}`
    : d?.links instanceof Error
      ? '<div class="empty">Couldn\'t load the community links.</div>'
      : LOADING;
  return panel("st-links", "Community links", meta, body, S.adding ? "" : `<button class="ghost" data-act="addppl">Add link</button>`);
}

const settings: ConsolePage<SettingsData> = {
  key: "settings",
  filters: {},
  windowed: false,
  useData: useSettingsData,
  render: (d) => {
    const alerts = ok(d?.alerts);
    const me = alerts
      ? `<div class="row" style="padding:6px 0"><div style="flex:1"><div>Email me about every signup</div><div class="sub">New waitlist entries, new accounts and handles picked</div></div>${sw(alerts.on, "alerts", "x", "Signup emails")}</div>`
      : LOADING;
    return panel("st-me", "For you", "", me, "") + linksPanel(d);
  },
  acts: {
    async alerts(_e, d) {
      const current = ok(d?.alerts);
      if (!d || !current) return;
      try {
        await d.setAlerts({ on: !current.on });
      } catch (err) {
        toast(errorWords(err));
      }
      render();
    },
    addppl() {
      S.adding = true;
      render();
      setTimeout(() => (document.querySelector("#ll") as HTMLElement | null)?.focus(), 0);
    },
    addcancel() {
      S.adding = false;
      render();
    },
    askrmlink(e) {
      S.confirm = "rl" + e.dataset.id;
      render();
    },
    async rmlink(e, d) {
      if (!d || !e.dataset.id) return;
      try {
        await d.deleteLink({ id: e.dataset.id as Id<"communityLinks"> });
        S.confirm = null;
        toast("Link deleted");
      } catch (err) {
        toast(errorWords(err));
      }
      render();
    },
    async addlink(e, d) {
      const field = (sel: string) => e.closest(".sc")?.querySelector(sel) as HTMLInputElement | HTMLSelectElement | null;
      const url = (field("#lu")?.value ?? "").trim();
      if (!url.startsWith("https://")) return toast("Links must start with https://");
      if (!d) return;
      try {
        await d.saveLink({
          kind: (field("#lk")?.value ?? "other") as "discord" | "github" | "x" | "newsletter" | "other",
          label: (field("#ll")?.value ?? "").trim() || url,
          url,
          audience: field("#la")?.value === "everyone" ? "everyone" : "members",
        });
        S.adding = false;
        toast("Link added");
      } catch (err) {
        toast(errorWords(err));
      }
      render();
    },
  },
};

/** Typed as `ConsolePage<SettingsData>` above; the registry holds every page as `ConsolePage` (see `types.ts`). */
export const settingsPage = settings as ConsolePage;
