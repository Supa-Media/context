/**
 * Lines: Tex's old number (Dev2's Photon plan, "Old-number switch"). One switch says whether the old Sendblue line
 * answers each chat once with the new number (`functions/texOldLine.ts`, saved with Save); the two "Tell everyone"
 * buttons open the tell-everyone job's run form on GitHub, the same way Jobs opens its test bench: no token here can
 * start it, and nobody is texted until Send is ticked there.
 *
 * A change not yet saved is kept in `draft` while the page is open, so flipping the switch never wipes what was typed.
 */
import { useEffect, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@context/convex/_generated/api";
import { ago } from "./ago";
import { confirmBox, esc, panel, sw } from "../kit";
import { S, render, toast } from "../state";
import type { ConsolePage } from "../types";

type Saved = NonNullable<FunctionReturnType<typeof api.functions.texOldLine.getTexOldLine>>;
type Mode = "off" | "redirect";
type View = { mode: Mode; number: string; archiveOn: string };
/** What the page's fields said, and the saved change they were typed against (`base`: its `updatedAt`, 0 for none). */
type Draft = View & { base: number };

export type LinesData = {
  setting: Saved | undefined;
  save: (args: { mode: Mode; number: string | null; archiveOn: string | null }) => Promise<unknown>;
};

/** The run form of `.github/workflows/tell-texters-new-number.yml`: a dry run unless Send is ticked there. */
export const TELL_NEW_NUMBER_URL = "https://github.com/Supa-Media/context/actions/workflows/tell-texters-new-number.yml";

const LOADING = '<div class="empty">Loading…</div>';

/** The server's message for a failed call, or a flat sentence. Never `String(error)`. */
function errText(error: unknown, fallback = "That did not work. Try again.") {
  const data = (error as { data?: unknown })?.data;
  if (data !== null && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}

let draft: Draft | null = null;

/** Forget an unsaved change (the page leaving, and tests). */
export function forgetLinesDraft(): void {
  draft = null;
}

function useLinesData(): LinesData {
  const setting = useQuery(api.functions.texOldLine.getTexOldLine, {});
  const save = useMutation(api.functions.texOldLine.setTexOldLine);
  // The draft lives while this page is open: leaving and coming back shows the saved setting.
  useEffect(() => forgetLinesDraft, []);
  // Stable between renders: the shell calls `onData` whenever this object changes.
  return useMemo(() => ({ setting, save }), [setting, save]);
}
type LinesDataHook = ReturnType<typeof useLinesData>;

/** What the page shows: the draft while it is for the saved change on screen, else the saved change. */
function viewOf(d: LinesDataHook | undefined): View & { base: number } {
  const saved = d?.setting;
  const base = saved?.updatedAt ?? 0;
  if (draft !== null && draft.base === base) return draft;
  return { base, mode: saved?.mode ?? "off", number: saved?.number ?? "", archiveOn: saved?.archiveOn ?? "" };
}

/** The view with what is typed in the fields now, so a re-render (the switch, a toast) keeps it. */
function typedView(d: LinesDataHook | undefined): View & { base: number } {
  const shown = viewOf(d);
  const number = document.querySelector<HTMLInputElement>("#pgin #lnnum")?.value ?? shown.number;
  const archiveOn = document.querySelector<HTMLInputElement>("#pgin #lnday")?.value ?? shown.archiveOn;
  return { ...shown, number, archiveOn };
}

function oldLinePanel(d: LinesDataHook | undefined) {
  const saved = d?.setting;
  if (saved === undefined) return panel("ln-old", "Old number", "", LOADING);
  const view = viewOf(d);
  const on = view.mode === "redirect";
  const changed = saved.updatedAt === null ? "" : `changed ${esc(ago(saved.updatedAt))}`;
  return panel(
    "ln-old",
    "Old number",
    on ? "on" : "off",
    `<div class="row" style="padding:6px 0"><div style="flex:1"><div>Text the new number instead</div><div class="sub">Off: the old line answers as it always has. On: each chat gets one reply with the new number, once a day, and no turn.</div></div>${sw(on, "lnmode", "old", "Text the new number instead")}</div>
<div class="row" style="margin-top:10px"><label class="sub" for="lnnum" style="min-width:110px">New number</label><input class="search" id="lnnum" value="${esc(view.number)}" placeholder="+18133350746" inputmode="tel" style="max-width:220px" aria-label="New number"></div>
<div class="row" style="margin-top:8px"><label class="sub" for="lnday" style="min-width:110px">Archive day</label><input class="search" id="lnday" type="date" value="${esc(view.archiveOn)}" style="max-width:220px" aria-label="Archive day"><span class="sub">The day the old number stops working. Blank for none.</span></div>
<div class="row" style="margin-top:10px"><button class="primary" data-act="lnsave">Save</button>${changed ? `<span class="sub">${changed}</span>` : ""}</div>`,
  );
}

function tellPanel(d: LinesDataHook | undefined) {
  const saved = d?.setting;
  if (saved === undefined) return panel("ln-tell", "Tell everyone", "", LOADING);
  const ask =
    S.confirm === "lntell"
      ? confirmBox("Open the run form to tell everyone on the old line? Nobody is texted until Send is ticked there.", "Open the run form", "lnsend")
      : `<button class="primary" data-act="lnask">Tell everyone</button>`;
  const actions = `<div class="row" style="margin-top:10px"><button class="ghost" data-act="lndry">Tell everyone (dry run)</button>${ask}</div>`;
  const number = saved.number ? `<span class="mono">${esc(saved.number)}</span>` : "no number saved yet";
  return panel(
    "ln-tell",
    "Tell everyone",
    "",
    `<div class="sub">Tells each phone whose last chat was on the old line, once, in that chat: "Tex here, on my new number…". The run form opens on GitHub with the number to type there: ${number}${
      saved.archiveOn ? `, archive day <span class="mono">${esc(saved.archiveOn)}</span>` : ""
    }. The dry run leaves Send unticked and texts nobody.</div>${actions}`,
  );
}

export const linesPage: ConsolePage<LinesDataHook> = {
  key: "lines",
  filters: {},
  windowed: false,
  useData: useLinesData,
  render: (d) => oldLinePanel(d) + tellPanel(d),

  acts: {
    lnmode(_el, d) {
      const view = typedView(d);
      draft = { ...view, mode: view.mode === "redirect" ? "off" : "redirect" };
      render();
    },

    async lnsave(_el, d) {
      if (!d) return;
      const view = typedView(d);
      try {
        await d.save({
          mode: view.mode,
          number: view.number.trim() || null,
          archiveOn: view.archiveOn.trim() || null,
        });
        draft = null;
        toast("Saved");
      } catch (error) {
        draft = view;
        toast(errText(error));
      }
      render();
    },

    lndry() {
      window.open(TELL_NEW_NUMBER_URL, "_blank", "noopener");
      toast("Opened the run form. Send is unticked there, so nobody is texted.");
    },

    lnask() {
      S.confirm = "lntell";
      render();
    },

    lnsend() {
      S.confirm = null;
      window.open(TELL_NEW_NUMBER_URL, "_blank", "noopener");
      toast("Opened the run form. Tick Send there to text everyone.");
      render();
    },
  },
};
