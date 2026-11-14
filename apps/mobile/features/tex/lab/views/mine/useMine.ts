/**
 * The Lab's "You" (`engine/mine.ts`): the signed-in person's workspaces, and their chats with Tex, their one-to-one
 * and each group chat they're in, read from the chat's history file (`POST /tex/page/ledger`, the same route the Tex
 * page's History reads, which answers only a person's own chat and a group's only for the chat's own people). Reading
 * is all it does: nothing here writes, sends or changes a setting.
 */
import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../../../../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../../../../console/placeholderData";
import { gatewaySource, type TexPageSource } from "../../../page/texPageSource";
import { LATEST, type LedgerEntry, type LedgerKind } from "../../../page/texPageTypes";
import { chatLines, myTexts, readsOf, type MyText } from "../../engine/mine";
import { realIO, realTimes } from "../../engine/realTimes";
import { turnPromptOf } from "../../engine/promptAt";
import { emit, lab, toast } from "../../engine/state";
import { traceMine } from "../../engine/traces";

let source: TexPageSource | null = null;
/** Every text and reply entry read so far, so an older page joins the texts it continues. */
let seen: LedgerEntry[] = [];
let reading = false;

/** The chats they can replay, from the Tex page's chat picker: their one-to-one first, then their group chats. */
export async function readMyChats() {
  if (!source) return;
  const r = await source.overview("me", "chats");
  if (r.kind !== "ok") return;
  const chats = r.value.chats.length ? r.value.chats : [r.value.chat];
  lab.myChats = chats.map((c) => ({ key: c.key, name: c.key === "me" ? "Just you and Tex" : c.name, ...(c.people ? { people: c.people } : {}) }));
  emit();
}

/** Switch the chat the Lab reads: its texts, conversation and measured times start over. */
export function pickChat(key: string) {
  if (key === lab.myChat) return;
  lab.myChat = key;
  seen = [];
  detail.clear();
  detailDays.clear();
  lab.moment = null;
  lab.myTexts = null;
  lab.myLines = [];
  lab.myOlder = null;
  lab.myPicks = [];
  lab.real = null;
  emit();
  void readMyTexts();
}

/** Read their newest texts, or the page before `lab.myOlder` with `older`. */
export async function readMyTexts(older = false) {
  if (!source || reading) return;
  reading = true;
  const chat = lab.myChat;
  try {
    const r = await source.ledger(chat, { kinds: ["text", "reply", "note"], jobs: false, before: older && lab.myOlder !== null ? lab.myOlder : LATEST });
    if (chat !== lab.myChat) return;
    if (r.kind !== "ok") {
      if (!older) lab.myTexts = "failed";
      else toast("Couldn't read older texts");
      return;
    }
    const known = new Set(seen.map((e) => e.id));
    seen = [...seen, ...r.value.entries.filter((e) => !known.has(e.id))];
    const first = !Array.isArray(lab.myTexts);
    lab.myTexts = myTexts(seen);
    lab.myLines = chatLines(seen, lab.myTexts, { group: chat !== "me" });
    // As You, the canvas traces your newest text until you pick another.
    if (first && lab.tester === "me" && lab.myTexts[0]) {
      traceMine(lab.myTexts[0].text);
      void readTurnTimes(lab.myTexts[0]);
    }
    lab.myOlder = r.value.older ?? null;
  } finally {
    reading = false;
    emit();
  }
  // The chat was switched while this read ran (it was skipped then): read the chat now picked.
  if (chat !== lab.myChat && lab.myTexts === null) void readMyTexts();
}

/**
 * Replay keeps up with the chat as it goes (Dev2, 2026-11-14: "these chats don't update in real time"): the newest page
 * of texts and replies joins what was read, and today's steps are read again from the newest back, so a text, a
 * check-in or a routine shows up, with its run, within one look.
 */
export async function refreshChat() {
  if (!source || reading || !Array.isArray(lab.myTexts)) return;
  await readMyTexts();
  const today = new Date().toLocaleDateString("en-CA");
  detailDays.delete(lab.myChat + "|" + today);
  await readMomentDetail(Date.now());
}

const PAGES_BACK = 6;

/** Each step, judging, tool call and thought read for Replay so far, by entry id. */
const detail = new Map<string, LedgerEntry>();
const detailDays = new Set<string>();

/** Everything read from the chat so far: texts and replies, and Replay's details. */
export const replayEntries = (): LedgerEntry[] => [...seen, ...detail.values()];

/**
 * Replay a moment: read the details of the day it happened (the texting Worker's judgings, the turns' steps, tool
 * calls and thoughts), page by page back to its first text, once per chat and day.
 */
/** Everything a turn's steps logged beyond its texts and reply: what the panel shows each step got and gave. */
const DETAIL_KINDS: LedgerKind[] = ["step", "judge", "tool", "thinking", "said", "brief", "advisor", "mail_check", "job"];

export async function readMomentDetail(at: number) {
  if (!source) return;
  const chat = lab.myChat;
  const day = new Date(at).toLocaleDateString("en-CA");
  if (detailDays.has(chat + "|" + day)) return;
  detailDays.add(chat + "|" + day);
  let before = LATEST;
  for (let i = 0; i < PAGES_BACK; i++) {
    const r = await source.ledger(chat, { kinds: DETAIL_KINDS, day, before });
    if (r.kind !== "ok" || chat !== lab.myChat) break;
    for (const e of r.value.entries) detail.set(e.id, e);
    const oldest = Math.min(...r.value.entries.map((e) => e.at));
    if (r.value.older === undefined || !(oldest > at - 60_000)) break;
    before = r.value.older;
  }
  emit();
}

/**
 * The measured times of a traced text's turn, for the canvas: first from its reply's timing (already read), then with
 * the reviewer's and other model steps' entries from that day, read back page by page until the text's own time.
 */
export async function readTurnTimes(t: MyText) {
  const now = (entries: LedgerEntry[]) => {
    const times = realTimes(entries, t.turn);
    if (lab.ownText !== t.text) return false;
    lab.real = times ? { text: t.text, times, io: realIO(entries, t.turn, t.text, t.then.text), prompt: turnPromptOf(entries, t.turn) } : null;
    emit();
    return times !== null;
  };
  if (!now(seen) || !source || !t.turn) return;
  const day = new Date(t.at).toLocaleDateString("en-CA");
  const more: LedgerEntry[] = [];
  let before = LATEST;
  for (let i = 0; i < PAGES_BACK; i++) {
    const r = await source.ledger(lab.myChat, { kinds: DETAIL_KINDS, day, before });
    if (r.kind !== "ok") break;
    more.push(...r.value.entries);
    const oldest = Math.min(...r.value.entries.map((e) => e.at));
    if (r.value.older === undefined || !(oldest > t.at)) break;
    before = r.value.older;
  }
  now([...seen, ...more]);
}

/** The notes a picked text's turn read, from that day's tool calls; kept with the pick for the run config. */
export async function readTurnReads(id: string) {
  const t = Array.isArray(lab.myTexts) ? lab.myTexts.find((x) => x.id === id) : null;
  if (!source || !t?.turn || lab.myReads[id]) return;
  const day = new Date(t.at).toLocaleDateString("en-CA");
  const r = await source.ledger(lab.myChat, { kinds: ["tool"], day, before: LATEST });
  if (r.kind !== "ok") return;
  lab.myReads = { ...lab.myReads, [id]: readsOf(r.value.entries, t.turn) };
  emit();
}

/**
 * Who "You" is, and the source their texts are read through. Mounted only while the test user is You, inside the
 * staff-only Lab, so nothing is read for anyone who never switches.
 */
export function MineLoader() {
  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces, {});
  const mint = useConsoleGrant();
  const minting = useRef(mint);
  minting.current = mint;
  const personal = workspaces?.find((w) => w.kind === "personal" && w.role === "owner") ?? null;
  const id = personal?.workspaceId ?? null;
  const handle = personal?.slug ?? null;

  useMemo(() => {
    source =
      id === null || handle === null
        ? null
        : gatewaySource({ endpoint: MCP_ENDPOINT, handle, token: async (refresh) => (await minting.current({ workspaceId: id as Id<"workspaces"> }, refresh)).accessToken });
    seen = [];
  }, [id, handle]);

  useEffect(() => {
    if (!workspaces) return;
    lab.me = personal ? { handle: personal.slug, name: personal.displayName || personal.slug, workspaces: workspaces.map((w) => ({ n: w.slug, kind: w.kind, role: w.role })) } : null;
    if (lab.myTexts === null) void readMyTexts();
    else emit();
    if (lab.myChats === null) void readMyChats();
  }, [workspaces, personal]);
  return null;
}
