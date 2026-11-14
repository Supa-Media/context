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
import { myTexts, readsOf } from "../../engine/mine";
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
    if (first && lab.tester === "me" && lab.myTexts[0]) traceMine(lab.myTexts[0].text);
    lab.myOlder = r.value.older ?? null;
  } finally {
    reading = false;
    emit();
  }
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
