/**
 * Moving a group chat to Tex's new number (Dev2, 2026-11-15, chose "New number removes the old one"; node `moveChat`):
 *
 *     staff flick the group's switch (`functions/texChatMoves.ts`), and the cron (`moveChats.ts`) asks the group's own object:
 *       1. Sendblue adds Tex's new number to the group (`/api/modify-group`, add_recipient); Sendblue cannot leave a group
 *       2. the old number posts the node's swap note ("same Tex, different phone number"), and the move is noted in the
 *          `group-moves` object, under the old line, with the group's people            -> reported `told`
 *     the new line hears that note from the old number in a group with the same people:
 *       3. the two ids are tied together in `group-moves`, both ways
 *       4. the new line takes the old number out of the group (`group/remove` on the bridge) -> reported `moved`
 *
 * From then on the group is still the group it was: a message the new line hears there is filed under the old
 * Sendblue group's id and line (`arrivedAs`), so its home, memory, rules and key (`groupKeyOf`) stay the same, and
 * everything Tex sends to the old group goes through the new line instead (`movedTo`, read by `groupLine.ts`).
 *
 * Nothing here holds a message's words. Logs carry outcomes; the step's ledger record carries what was set, never a
 * number.
 */

import { call, type SendblueKeys } from "./sendblue";
import { record, type Fetch } from "./clients";
import type { TextsBinding } from "./gatewaySession";
import type { GroupPlace } from "./groupLine";
import type { InboxStorage } from "./inbox";
import { inboxByName } from "./objectPlace";
import { photonCall } from "./photonClient";
import { photonGroupGuid } from "./photon";
import { readGroupMembers, sendGroupText } from "./sendblueGroups";
import { logStep } from "./stepEvents";
import type { MoveBody, MoveOutcome } from "./moveChats";

/** The one object that knows which groups moved: a chat object (in the gateway) by this name, used for these keys alone. */
export const GROUP_MOVES_NAME = "group-moves";
const PENDING = "gm:pending:";
const ALIAS = "gm:alias:";
const TO = "gm:to:";
/** A swap note the new line never heard is forgotten after this long; staff can flick the switch again. */
export const PENDING_FOR_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 20;
/** Where a moved group lives now is read once per isolate; a group that has not moved is read again after this. */
const UNMOVED_FOR_MS = 60_000;
const E164 = /^\+[1-9]\d{6,14}$/;

type Pending = { groupId: string; groupKey: string; people: string[]; askedAt: number; at: number };
type Arrival = { photonGroupId: string; photonLine: string; from: string; participants: string[] };
export type Matched = { groupKey: string; line: string; groupId: string; askedAt: number };

/** The people in a group other than Tex's lines, sorted, as the two lines' lists are compared. */
export function peopleOf(participants: readonly string[], lines: readonly string[]): string[] {
  return [...new Set(participants.filter((who) => !lines.includes(who)))].sort();
}

/** An address as both providers can name it: a phone's last ten digits, or an email in lower case. */
const addressKey = (who: string) => (who.includes("@") ? who.trim().toLowerCase() : who.replace(/\D/g, "").slice(-10));
const overlap = (a: readonly string[], b: readonly string[]) => {
  const keys = new Set(b.map(addressKey));
  return new Set(a.map(addressKey).filter((key) => key !== "" && keys.has(key))).size;
};

/**
 * The waiting move these people are. Sendblue and Photon do not list a group alike (Dev2's second Tex Devs move,
 * 2026-11-15: same group, lists that differed), so it is the move sharing the most people, more than half of the longer
 * list; the note also came from that move's old number, so it is never a stranger's group.
 */
function closest(live: readonly Pending[], people: readonly string[]): Pending | undefined {
  let found: Pending | undefined;
  let most = 0;
  for (const entry of live) {
    const shared = overlap(entry.people, people);
    if (shared > most && shared * 2 > Math.max(entry.people.length, people.length)) {
      found = entry;
      most = shared;
    }
  }
  return found;
}

// ── The `group-moves` object's side ────────────────────────────────────────

/** `/group-move/*` on the `group-moves` object. Every answer is JSON; a path it does not know is a 404. */
export async function serveGroupMoves(storage: InboxStorage, path: string, body: Record<string, unknown>, now: number): Promise<Response> {
  if (path === "/group-move/pending") {
    const { line, groupId, groupKey, people, askedAt } = body;
    if (typeof line !== "string" || !E164.test(line) || typeof groupId !== "string" || typeof groupKey !== "string" || typeof askedAt !== "number") return new Response(null, { status: 400 });
    if (!Array.isArray(people) || people.some((who) => typeof who !== "string")) return new Response(null, { status: 400 });
    const kept = ((await storage.get<Pending[]>(`${PENDING}${line}`)) ?? []).filter((entry) => entry.groupId !== groupId && now - entry.at < PENDING_FOR_MS);
    kept.push({ groupId, groupKey, people: [...(people as string[])].sort(), askedAt, at: now });
    await storage.put(`${PENDING}${line}`, kept.slice(-MAX_PENDING));
    return Response.json({ ok: true });
  }
  if (path === "/group-move/arrive") {
    const { photonGroupId, photonLine, from, participants } = body as Partial<Arrival>;
    if (typeof photonGroupId !== "string" || typeof photonLine !== "string" || typeof from !== "string" || !Array.isArray(participants)) return new Response(null, { status: 400 });
    const alias = await storage.get<GroupPlace>(`${ALIAS}${photonGroupId}`);
    if (alias !== undefined) return Response.json({ from: alias });
    const pending = await storage.get<Pending[]>(`${PENDING}${from}`);
    if (pending === undefined) return Response.json({});
    const people = peopleOf(participants as string[], [from, photonLine]);
    const live = pending.filter((entry) => now - entry.at < PENDING_FOR_MS);
    const found = closest(live, people);
    // Photon's event names only who sent it, not the group's people: the Worker reads them from the bridge and asks again.
    if (found === undefined) {
      const best = Math.max(0, ...live.map((entry) => overlap(entry.people, people)));
      return Response.json(live.length > 0 ? { waiting: true, people: people.length, expected: Math.max(0, ...live.map((entry) => entry.people.length)), shared: best } : {});
    }
    const old: GroupPlace = { line: from, groupId: found.groupId };
    await storage.put(`${ALIAS}${photonGroupId}`, old);
    await storage.put<GroupPlace>(`${TO}${found.groupId}`, { line: photonLine, groupId: photonGroupId });
    await storage.put(`${PENDING}${from}`, pending.filter((entry) => entry !== found));
    const matched: Matched = { groupKey: found.groupKey, line: from, groupId: found.groupId, askedAt: found.askedAt };
    return Response.json({ from: old, matched });
  }
  if (path === "/group-move/to") {
    if (typeof body.groupId !== "string") return new Response(null, { status: 400 });
    const to = await storage.get<GroupPlace>(`${TO}${body.groupId}`);
    return Response.json(to === undefined ? {} : { to });
  }
  return new Response(null, { status: 404 });
}

// ── The Worker's side ──────────────────────────────────────────────────────

const movedCache = new Map<string, { at: number; to: GroupPlace | null }>();
const aliasCache = new Map<string, GroupPlace>();

/** Forget what this isolate read (tests). */
export function clearGroupMoveCache(): void {
  movedCache.clear();
  aliasCache.clear();
}

async function ask(ns: DurableObjectNamespace, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await inboxByName(ns, GROUP_MOVES_NAME).fetch(`https://inbox${path}`, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`group-moves answered ${response.status}`);
  return record(await response.json());
}

const placeOf = (value: unknown): GroupPlace | null => {
  const place = record(value);
  return typeof place.line === "string" && typeof place.groupId === "string" ? { line: place.line, groupId: place.groupId } : null;
};

/**
 * Where an old Sendblue group lives now, or null when it has not moved (`groupLine.ts` sends there instead). A read
 * that fails is null: the text goes the old way, as it did before any move.
 */
export function groupMovedTo(ns: DurableObjectNamespace): (groupId: string) => Promise<GroupPlace | null> {
  return async (groupId) => {
    const kept = movedCache.get(groupId);
    if (kept !== undefined && (kept.to !== null || Date.now() - kept.at < UNMOVED_FOR_MS)) return kept.to;
    try {
      const to = placeOf((await ask(ns, "/group-move/to", { groupId })).to);
      movedCache.set(groupId, { at: Date.now(), to });
      return to;
    } catch {
      return null;
    }
  };
}

/**
 * A group message the new line heard: filed as the old group when that group moved here (`from`), and `matched` when
 * it is the old number's swap note that ties the two together now. A read that fails leaves the message as it came.
 *
 * Photon's event lists only the sender (Dev2's first group move, 2026-11-15, left the old number in because of it), so
 * when a move from that sender is waiting, the group's people are read from the bridge (`members`) and matched again.
 */
export async function arrivedAs(ns: DurableObjectNamespace, arrival: Arrival, members?: () => Promise<string[]>): Promise<{ from: GroupPlace | null; matched?: Matched }> {
  const kept = aliasCache.get(arrival.photonGroupId);
  if (kept !== undefined) return { from: kept };
  try {
    let answer = await ask(ns, "/group-move/arrive", arrival);
    if (answer.waiting === true && members !== undefined) {
      const participants = await members();
      answer = await ask(ns, "/group-move/arrive", { ...arrival, participants: [...new Set([...participants, arrival.from])] });
      // Counts only, never an address: how many the bridge listed, how many the move noted, how many they share.
      if (answer.waiting === true) console.log(JSON.stringify({ event: "chat_move", kind: "group", outcome: "people_differ", heard: participants.length, people: answer.people, expected: answer.expected, shared: answer.shared }));
    }
    const from = placeOf(answer.from);
    if (from !== null) aliasCache.set(arrival.photonGroupId, from);
    const matched = record(answer.matched);
    return typeof matched.groupKey === "string" ? { from, matched: matched as unknown as Matched } : { from };
  } catch {
    return { from: null };
  }
}

/** A group message as the old group it is now: its id and line, with the new line standing in the old one's place. */
export function asOldGroup<T extends { groupId: string; line: string; participants: string[] }>(message: T, old: GroupPlace): T {
  const participants = [...new Set(message.participants.map((who) => (who === message.line ? old.line : who)))];
  return { ...message, groupId: old.groupId, line: old.line, participants };
}

/** The new line takes the old number out of the group. True when the bridge did it. */
export async function removeOldNumber(photon: Fetcher | null | undefined, photonLine: string, photonGroupId: string, oldLine: string): Promise<boolean> {
  const chat = photonGroupGuid(photonGroupId);
  if (!photon || chat === null) return false;
  try {
    await photonCall(photon, "group/remove", { line: photonLine, chat, address: oldLine });
    return true;
  } catch {
    return false;
  }
}

// ── The old group's own object ─────────────────────────────────────────────

/** Which ask this group was moved for. */
export const GROUP_MOVE_TOLD_KEY = "gmove:told";

export type GroupMoveBody = MoveBody & GroupPlace & { groupKey: string };
export type GroupMoveDeps = { fetch: Fetch; sendblue?: SendblueKeys | null; texts?: TextsBinding; moves: DurableObjectNamespace; now: () => number };

/** Steps 1 and 2 of the module comment, logged as the group's `moveChat` step. */
export async function moveGroup(storage: InboxStorage, body: GroupMoveBody, deps: GroupMoveDeps): Promise<MoveOutcome> {
  const started = Date.now();
  const seen = { kind: "group", number: body.number !== null, archiveOn: body.archiveOn !== null };
  const done = async (outcome: MoveOutcome, extra: Record<string, unknown> = {}): Promise<MoveOutcome> => {
    const ok = outcome === "told" || outcome === "already_told";
    await logStep(storage, body.groupId, { name: "moveChat", ok, ms: Date.now() - started, input: seen, output: { outcome, ...extra }, ...(ok ? {} : { cause: outcome }) }, deps.now());
    return outcome;
  };
  if ((await storage.get<number>(GROUP_MOVE_TOLD_KEY)) === body.askedAt) return await done("already_told");
  if (body.number === null) return await done("no_number");
  if (!deps.sendblue) return await done("unreachable");
  if (deps.texts === undefined) return await done("no_gateway");
  let output: { to?: unknown; text?: unknown };
  try {
    const response = await deps.texts.fetch("https://gateway/texts/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "group", number: body.number, ...(body.archiveOn !== null ? { archiveOn: body.archiveOn } : {}) }),
    });
    if (!response.ok) return await done("node_failed");
    output = (await response.json()) as typeof output;
  } catch {
    return await done("node_failed");
  }
  if (output.to !== "group" || typeof output.text !== "string" || output.text === "") return await done("no_number");
  const members = await readGroupMembers(deps.fetch, deps.sendblue, body.groupId);
  if (members === null) return await done("members_unread");
  const people = peopleOf(members, [body.line, body.number]);
  // Step 1: Sendblue adds the new number. An already-added number is fine; anything else Sendblue refuses stops here.
  const added = await call(deps.fetch, deps.sendblue, "/api/modify-group", { group_id: body.groupId, modify_type: "add_recipient", number: body.number, from_number: body.line });
  if (added < 200 || added >= 300) return await done("add_failed", { status: added });
  // Noted before the note goes, so the new line can tie the groups the moment it hears it.
  try {
    await ask(deps.moves, "/group-move/pending", { line: body.line, groupId: body.groupId, groupKey: body.groupKey, people, askedAt: body.askedAt });
  } catch {
    return await done("unreachable");
  }
  await storage.put(GROUP_MOVE_TOLD_KEY, body.askedAt);
  try {
    await sendGroupText(deps.fetch, deps.sendblue, { line: body.line, groupId: body.groupId }, output.text);
  } catch {
    await storage.delete(GROUP_MOVE_TOLD_KEY);
    return await done("send_failed", { textChars: output.text.length });
  }
  return await done("told", { textChars: output.text.length, people: people.length });
}
