/**
 * Lines → Move chats (Dev2, 2026-11-15: "I can see all the individual people and groups, and I can flick a switch ...
 * one by one and sort of monitor if it works"). Every person and group Tex texts with, each with a switch and how its
 * move went (`functions/texChatMoves.ts`): flicking it asks the texting Worker to text that one chat the new number
 * from the old line within a minute; the row then shows told, and moved once the person texts the new number. A group's
 * switch adds the new number to the group, posts the swap note from the old one, and is moved once the new number has
 * taken the old one out (`packages/tex/worker/groupMoves.ts`).
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "@context/convex/_generated/api";
import { ago } from "./ago";
import { confirmBox, esc, panel, pill, sw } from "../kit";
import { S } from "../state";

export type MoveList = FunctionReturnType<typeof api.functions.texChatMoves.listTexChatMoves>;
type Move = MoveList["people"][number]["move"];

/** What a move's code means, in a few words. */
const DETAIL: Record<string, string> = {
  already_told: "already told for this ask",
  on_new_line: "already texting the new number",
  no_chat: "never texted Tex",
  not_old_line: "not on the old Sendblue line",
  no_number: "no new number saved",
  no_gateway: "the gateway was not reached",
  node_failed: "the move node failed",
  send_failed: "the old line refused the text",
  unreachable: "the chat was not reached",
  members_unread: "Sendblue would not say who is in the group",
  add_failed: "Sendblue would not add the new number (it must be on iMessage)",
  remove_failed: "the new number could not take the old one out",
  unknown: "an unknown error",
};

/** The row's state as a pill: nothing yet, waiting, told, moved, or failed with why. */
export function moveState(move: Move, kind: "person" | "group" = "person"): string {
  if (move === null) return '<span class="sub">not moved</span>';
  const why = move.detail ? ` <span class="sub">${esc(DETAIL[move.detail] ?? move.detail)}</span>` : "";
  if (move.status === "asked") return `${pill("waiting", "acc")} <span class="sub">asked ${esc(ago(move.askedAt))}</span>`;
  if (move.status === "sending") return `${pill("sending", "acc")}`;
  if (move.status === "told") return `${pill("told", "warn")} <span class="sub">${esc(ago(move.toldAt ?? move.updatedAt))}, ${kind === "group" ? "waiting for the new number to hear the note and take the old one out" : "waiting for their first text on the new number"}</span>${why}`;
  if (move.status === "moved") return `${pill("moved", "ok")} <span class="sub">${esc(ago(move.movedAt ?? move.updatedAt))}</span>${why}`;
  return `${pill("failed", "bad")}${why}`;
}

const on = (move: Move) => move !== null && move.status !== "failed";
/** The confirm's id: kind and key, which the act splits again. */
export const moveId = (kind: "person" | "group", key: string) => `${kind}:${key}`;
const last4 = (phone: string) => `…${phone.slice(-4)}`;

export function movesPanel(list: MoveList | undefined, number: string | null): string {
  if (list === undefined) return panel("ln-moves", "Move chats", "", '<div class="empty">Loading…</div>');
  const moved = [...list.people, ...list.groups].filter((row) => row.move?.status === "moved").length;
  const ask = (id: string, label: string) =>
    S.confirm === `lnmv${id}` ? confirmBox(`Text ${esc(label)} the new number from the old one?`, "Send", "lnmvgo", id) : "";
  const people = list.people
    .map((row) => {
      const id = moveId("person", row.phone);
      return `<tr><td class="wrap"><div>${esc(row.name)}</div><div class="sub mono">${esc(last4(row.phone))}</div></td><td class="wrap">${moveState(row.move)}${ask(id, row.name)}</td><td class="r">${sw(on(row.move), "lnmv", id, `Move ${row.name}`)}</td></tr>`;
    })
    .join("");
  const groups = list.groups
    .map((row) => {
      const id = moveId("group", row.groupKey);
      return `<tr><td class="wrap"><div>${esc(row.name)}</div><div class="sub">${row.people} ${row.people === 1 ? "person" : "people"} · last text ${esc(ago(row.lastSeenAt))}</div></td><td class="wrap">${moveState(row.move, "group")}${ask(id, row.name)}</td><td class="r">${sw(on(row.move), "lnmv", id, `Move ${row.name}`)}</td></tr>`;
    })
    .join("");
  const intro = number
    ? `<div class="sub">One chat at a time: the switch texts that chat from the old number, within a minute, to use <span class="mono">${esc(number)}</span>. The old number keeps answering as before.</div>`
    : '<div class="sub">Save the new number under Old number first; the switches text people to use it.</div>';
  return panel(
    "ln-moves",
    "Move chats",
    `${moved} moved`,
    `${intro}
<div class="tbl"><table><tr><th>Person</th><th>Move</th><th></th></tr>${people || '<tr><td colspan="3" class="empty">Nobody has linked a phone yet</td></tr>'}</table></div>
<div class="tbl" style="margin-top:12px"><table><tr><th>Group chat</th><th>Move</th><th></th></tr>${groups || '<tr><td colspan="3" class="empty">No group chats yet</td></tr>'}</table></div>`,
  );
}

/** The kind and key a switch's id names, or null for anything else. */
export function moveOfId(id: string | undefined): { kind: "person" | "group"; key: string } | null {
  const m = /^(person|group):(.+)$/.exec(id ?? "");
  return m ? { kind: m[1] as "person" | "group", key: m[2] } : null;
}
