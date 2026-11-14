/**
 * Flags: the artifact's `P.flags`: one panel per feature flag (who gets it, its testers, the everyone confirm) and the
 * Tester groups panel. Each flag's mode buttons carry the flag's id, so one shared act serves every panel.
 */
import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { relativeTime } from "../../report";
import { confirmBox, esc, panel } from "../kit";
import { S, render, toast } from "../state";
import type { ConsolePage } from "../types";

type Listed = FunctionReturnType<typeof api.functions.featureFlags.listFlags>;
type Flag = Listed["flags"][number];
type Group = Listed["groups"][number];
type Mode = "off" | "people" | "everyone";

/** The server's message for a failed call, or a flat sentence. Never `String(error)`. */
function errText(error: unknown, fallback = "That did not work. Try again.") {
  const data = (error as { data?: unknown })?.data;
  if (data !== null && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

function useFlagsData() {
  const listed = useQuery(api.functions.featureFlags.listFlags, {});
  const setMode = useMutation(api.functions.featureFlags.setFlagMode);
  const addPerson = useMutation(api.functions.featureFlags.addFlagPerson);
  const removePerson = useMutation(api.functions.featureFlags.removeFlagPerson);
  const addGroup = useMutation(api.functions.featureFlags.addFlagGroup);
  const removeGroup = useMutation(api.functions.featureFlags.removeFlagGroup);
  const createGroup = useMutation(api.functions.featureFlags.createTesterGroup);
  const addGroupPerson = useMutation(api.functions.featureFlags.addGroupPerson);
  const removeGroupPerson = useMutation(api.functions.featureFlags.removeGroupPerson);
  // Stable between renders: the shell calls `onData` whenever this object changes, so a fresh one each time would loop.
  return useMemo(
    () => ({ listed, setMode, addPerson, removePerson, addGroup, removeGroup, createGroup, addGroupPerson, removeGroupPerson }),
    [listed, setMode, addPerson, removePerson, addGroup, removeGroup, createGroup, addGroupPerson, removeGroupPerson],
  );
}
type FlagsData = ReturnType<typeof useFlagsData>;

const LOADING = '<div class="empty">Loading…</div>';
const MODES: Array<[Mode, string]> = [
  ["off", "Off"],
  ["people", "Testers"],
  ["everyone", "Everyone"],
];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2027-02-06" as "Feb 6, 2027"; anything else as it came. */
function dayWords(day: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (m === null) return day;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}, ${m[1]}`;
}

/** The expiry line in the artifact's words: "expires Feb 6, 2027, in 84 days", or past due: launch it or remove it. */
function expiryWords(daysLeft: number, expires: string) {
  const day = dayWords(expires);
  if (daysLeft > 1) return `expires ${day}, in ${daysLeft} days`;
  if (daysLeft === 1) return `expires tomorrow, ${day}`;
  if (daysLeft === 0) return `expires today, ${day}`;
  return `expired ${-daysLeft === 1 ? "yesterday" : `${-daysLeft} days ago`}, ${day}: launch it or remove it`;
}

/** The artifact's `seg('Who gets it', …, 'flagmode')`, with the flag's id on each button. */
function modeSeg(flagId: string, current: string) {
  return `<div class="seg" role="group" aria-label="Who gets it">${MODES.map(
    ([v, label]) => `<button aria-pressed="${v === current}" data-act="flagmode" data-id="${esc(flagId)}" data-v="${v}">${label}</button>`,
  ).join("")}</div>`;
}

/** A chip's remove button: `data-v` is `group:<id>` or `person:<id>`. */
function testerChip(flag: Flag, kind: "group" | "person", key: string, name: string) {
  return `<span class="chipx">${esc(name)}<button data-act="rmtester" data-id="${esc(flag.id)}" data-v="${kind}:${esc(key)}" aria-label="Remove ${esc(name)}">×</button></span>`;
}

function flagPanel(flag: Flag, confirmingAll: boolean) {
  const id = esc(flag.id);
  const label = esc(flag.label);
  // Testers show only in Testers mode; in Everyone they are kept (say so), and in Off nothing is drawn.
  const testers =
    flag.mode === "people"
      ? `<div class="chips">${[
          ...flag.people.map((p) => testerChip(flag, "person", p.userId, p.name)),
          ...flag.groups.map((g) => testerChip(flag, "group", g.groupId, `group: ${g.name}`)),
        ].join("")}<input class="search" data-tadd="${id}" placeholder="@handle, email or group" style="min-width:210px;max-width:260px" aria-label="Add a tester to ${label}"><button class="ghost" data-act="addtester" data-id="${id}">Add</button></div>`
      : flag.mode === "everyone"
        ? '<div class="sub">Testers are kept for if you switch back.</div>'
        : "";
  return panel(
    "fl-" + flag.id,
    label,
    `<span class="mono">${id}</span>`,
    `<div class="sub" style="margin-bottom:8px">${esc(flag.description)}</div><div class="row" style="margin-bottom:10px">${modeSeg(flag.id, flag.mode)}<span class="sub">${esc(expiryWords(flag.daysLeft, flag.expires))}${
      flag.updatedAt === null ? "" : ` · changed ${esc(relativeTime(flag.updatedAt))}`
    }</span></div>${
      confirmingAll
        ? `<div class="row" style="margin-bottom:10px">${confirmBox(`Turn ${label} on for every account?`, "Turn on for everyone", "flagall", flag.id)}</div>`
        : ""
    }${testers}`,
  );
}

function groupRow(group: Group) {
  const gid = esc(group.groupId);
  return `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--line)"><b style="min-width:120px">${esc(group.name)}</b><span class="chips" style="flex:1">${group.people
    .map(
      (p) =>
        `<span class="chipx">${esc(p.name)}<button data-act="rmgp" data-id="${gid}" data-v="${esc(p.userId)}" aria-label="Remove ${esc(p.name)}">×</button></span>`,
    )
    .join("")}<input class="search" data-gid="${gid}" placeholder="@handle" style="max-width:120px" aria-label="Add to ${esc(group.name)}"><button class="ghost" data-act="addgp" data-id="${gid}">Add</button></span></div>`;
}

function groupsPanel(groups: Group[] | undefined, adding: boolean) {
  if (!groups) return panel("fl-groups", "Tester groups", "", LOADING);
  const body = groups.length ? groups.map(groupRow).join("") : '<div class="sub">No tester groups yet.</div>';
  const form = adding
    ? `<div class="row" style="margin-top:10px"><input class="search" id="gname" placeholder="Group name"><button class="primary" data-act="newgroup">Make group</button><button class="ghost" data-act="addcancel">Cancel</button></div>`
    : "";
  return panel("fl-groups", "Tester groups", `${groups.length}`, body + form, adding ? "" : `<button class="ghost" data-act="addppl">New group</button>`);
}

/** The act's flag, by the id its button carries. */
function flagOf(d: FlagsData | undefined, id: string | undefined): Flag | undefined {
  return d?.listed?.flags.find((f) => f.id === id);
}

export const flagsPage: ConsolePage<FlagsData> = {
  key: "flags",
  filters: {},
  windowed: false,
  useData: useFlagsData,
  render: (d) => {
    const listed = d?.listed;
    if (!listed) return panel("fl-flags", "Features", "", LOADING) + groupsPanel(undefined, false);
    const flags = listed.flags.length
      ? listed.flags.map((f) => flagPanel(f, S.confirm === "flagall" + f.id)).join("")
      : '<div class="empty">No flags yet. A flag is added in code, in packages/shared/src/flags.cjs, with the day it expires.</div>';
    return flags + groupsPanel(listed.groups, S.adding);
  },

  acts: {
    async flagmode(el, d) {
      const flag = flagOf(d, el.dataset.id);
      if (!flag || !d) return;
      const mode = el.dataset.v as Mode;
      if (mode === "everyone" && flag.mode !== "everyone") {
        S.confirm = "flagall" + flag.id;
        return render();
      }
      try {
        await d.setMode({ flagId: flag.id, mode });
        S.confirm = null;
        toast(`${flag.label}: ${mode === "people" ? "testers" : mode}`);
      } catch (error) {
        toast(errText(error));
      }
      render();
    },

    async flagall(el, d) {
      const flag = flagOf(d, el.dataset.id);
      if (!flag || !d) return;
      try {
        await d.setMode({ flagId: flag.id, mode: "everyone" });
        toast(`${flag.label} is on for everyone`);
      } catch (error) {
        toast(errText(error));
      }
      S.confirm = null;
      render();
    },

    async rmtester(el, d) {
      if (!d) return;
      const flagId = el.dataset.id!;
      const v = el.dataset.v ?? "";
      const cut = v.indexOf(":");
      const kind = v.slice(0, cut);
      const key = v.slice(cut + 1);
      try {
        if (kind === "group") await d.removeGroup({ flagId, groupId: key as Id<"testerGroups"> });
        else await d.removePerson({ flagId, userId: key as Id<"users"> });
      } catch (error) {
        toast(errText(error));
      }
      render();
    },

    async addtester(el, d) {
      if (!d) return;
      const flagId = el.dataset.id!;
      const input = document.querySelector<HTMLInputElement>(`#pgin input[data-tadd="${flagId}"]`);
      const v = input?.value.trim() ?? "";
      if (!v) return;
      const group = d.listed?.groups.find((g) => g.name.toLowerCase() === v.toLowerCase());
      try {
        if (group) await d.addGroup({ flagId, groupId: group.groupId });
        else await d.addPerson({ flagId, who: v });
        if (input) input.value = "";
      } catch (error) {
        toast(errText(error, "Nobody was added."));
      }
      render();
    },

    async addgp(el, d) {
      if (!d) return;
      const groupId = el.dataset.id!;
      const input = document.querySelector<HTMLInputElement>(`#pgin input[data-gid="${groupId}"]`);
      const v = input?.value.trim() ?? "";
      if (!v) return;
      try {
        await d.addGroupPerson({ groupId: groupId as Id<"testerGroups">, who: v });
        if (input) input.value = "";
      } catch (error) {
        toast(errText(error, "Nobody was added."));
      }
      render();
    },

    async rmgp(el, d) {
      if (!d) return;
      try {
        await d.removeGroupPerson({ groupId: el.dataset.id as Id<"testerGroups">, userId: el.dataset.v as Id<"users"> });
      } catch (error) {
        toast(errText(error));
      }
      render();
    },

    addppl() {
      S.adding = true;
      render();
      setTimeout(() => document.querySelector<HTMLElement>("#pgin #gname")?.focus(), 0);
    },

    addcancel() {
      S.adding = false;
      render();
    },

    async newgroup(_el, d) {
      if (!d) return;
      const name = (document.querySelector<HTMLInputElement>("#pgin #gname")?.value ?? "").trim();
      if (!name) return toast("Name the group");
      try {
        await d.createGroup({ name });
        S.adding = false;
      } catch (error) {
        toast(errText(error, "That group was not made."));
      }
      render();
    },
  },
};
