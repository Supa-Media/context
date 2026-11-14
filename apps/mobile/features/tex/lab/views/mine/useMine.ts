/**
 * The Lab's "You" (`engine/mine.ts`): the signed-in person's workspaces, and their own one-to-one chat with Tex read
 * from its history file (`POST /tex/page/ledger`, the same route the Tex page's History reads, which answers only a
 * person's own chat). Reading is all it does: nothing here writes, sends or changes a setting.
 */
import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../../../../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../../../../console/placeholderData";
import { gatewaySource, type TexPageSource } from "../../../page/texPageSource";
import { LATEST, type LedgerEntry } from "../../../page/texPageTypes";
import { myTexts, readsOf, type MyText } from "../../engine/mine";
import { realIO, realTimes } from "../../engine/realTimes";
import { emit, lab, toast } from "../../engine/state";
import { traceMine } from "../../engine/traces";

let source: TexPageSource | null = null;
/** Every text and reply entry read so far, so an older page joins the texts it continues. */
let seen: LedgerEntry[] = [];
let reading = false;

/** Read their newest texts, or the page before `lab.myOlder` with `older`. */
export async function readMyTexts(older = false) {
  if (!source || reading) return;
  reading = true;
  try {
    const r = await source.ledger("me", { kinds: ["text", "reply"], jobs: false, before: older && lab.myOlder !== null ? lab.myOlder : LATEST });
    if (r.kind !== "ok") {
      if (!older) lab.myTexts = "failed";
      else toast("Couldn't read older texts");
      return;
    }
    const known = new Set(seen.map((e) => e.id));
    seen = [...seen, ...r.value.entries.filter((e) => !known.has(e.id))];
    const first = !Array.isArray(lab.myTexts);
    lab.myTexts = myTexts(seen);
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
}

const PAGES_BACK = 6;

/**
 * The measured times of a traced text's turn, for the canvas: first from its reply's timing (already read), then with
 * the reviewer's and other model steps' entries from that day, read back page by page until the text's own time.
 */
export async function readTurnTimes(t: MyText) {
  const now = (entries: LedgerEntry[]) => {
    const times = realTimes(entries, t.turn);
    if (lab.ownText !== t.text) return false;
    lab.real = times ? { text: t.text, times, io: realIO(entries, t.turn, t.text, t.then.text) } : null;
    emit();
    return times !== null;
  };
  if (!now(seen) || !source || !t.turn) return;
  const day = new Date(t.at).toLocaleDateString("en-CA");
  const more: LedgerEntry[] = [];
  let before = LATEST;
  for (let i = 0; i < PAGES_BACK; i++) {
    const r = await source.ledger("me", { kinds: ["judge", "step", "tool", "thinking", "said"], day, before });
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
  const r = await source.ledger("me", { kinds: ["tool"], day, before: LATEST });
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
  }, [workspaces, personal]);
  return null;
}
