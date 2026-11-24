/**
 * The Training and Dev conversations a test chat can start from (`route.js` `open` and `sets`): each as the Lab has it,
 * its draft over the repo's copy, and its messages as a test chat's first rows. The Test Set never runs here.
 */

import REPO from "../../src/texSetsRepo.generated.json" with { type: "json" };
import { eventId } from "./harness.js";

const CONVO_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MINUTE = 60_000;
const parse = (value) => {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
};

/** A Training or Dev conversation as the Lab has it: its draft over the repo's copy. Never the Test Set. */
export async function conversationOf(controlPlane, token, id) {
  if (typeof id !== "string" || !CONVO_ID.test(id)) return { error: [400, "name the conversation: convId"] };
  const draft = await controlPlane.labSandbox(token, "set", { id }).catch(() => null);
  const conv = draft?.status === "ok" ? parse(draft.conv) : (REPO.sets ?? []).find((c) => c.id === id) ?? null;
  if (!conv || !Array.isArray(conv.msgs)) return { error: [404, `There is no Training or Dev conversation ${id}.`] };
  if (conv.set === "test") return { error: [403, "The Test Set is people only and never runs here."] };
  return { conv };
}

/**
 * `sets`: the Training and Dev conversations a test chat can start from, each as the Lab has it (its draft over the
 * repo's copy, `texSets.ts` `listDrafts` through the control plane), a removed one left out. The Test Set is never kept
 * there or in the repo's copy, and anything that says it is one is left out here too.
 */
export async function setsList(controlPlane, token) {
  const answer = await controlPlane.labSandbox(token, "sets", {}).catch(() => null);
  if (answer === null) return { error: [503, "the control plane did not answer"] };
  const drafts = answer.status === "ok" && Array.isArray(answer.drafts) ? answer.drafts.filter((d) => d && typeof d.id === "string") : [];
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const repo = REPO.sets ?? [];
  const convs = [];
  for (const c of repo) {
    const d = byId.get(c.id);
    if (d?.removed) continue;
    convs.push(d ? (parse(d.conv) ?? c) : c);
  }
  for (const d of drafts) if (!d.removed && !repo.some((c) => c.id === d.id)) convs.push(parse(d.conv));
  const sets = convs
    .filter((c) => c && typeof c.id === "string" && (c.set === "training" || c.set === "dev") && Array.isArray(c.msgs))
    .map((c) => ({
      id: c.id,
      title: String(c.title ?? c.id),
      set: c.set,
      kind: c.kind === "group" ? "group" : "1:1",
      people: c.kind === "group" ? (Array.isArray(c.members) ? c.members.length : 0) : 1,
      texts: c.msgs.filter((m) => m && typeof m.text === "string").length,
    }));
  return { sets };
}

/** A conversation's messages as a test chat's start: rows, and the ledger entries a turn reads them from. */
export function conversationStart(conv, kind, base) {
  const msgs = conv.msgs.filter((m) => m && typeof m.text === "string");
  const until = typeof base === "string" && base !== "" ? msgs.findIndex((m) => m.id === base) : -1;
  const kept = until < 0 ? msgs : msgs.slice(0, until);
  const now = Date.now();
  const rows = [];
  const history = [];
  kept.forEach((m, i) => {
    const at = now - (kept.length - i) * MINUTE;
    const eid = eventId(at);
    const tex = m.tex === true || m.who === "Tex";
    const who = tex ? "Tex" : kind === "group" ? String(m.who ?? "Someone") : "You";
    rows.push({ id: String(m.id ?? eid), eid, who, text: m.text, at, prod: true });
    history.push(tex
      ? { v: 1, id: `ev${eid.replace("-", "")}`, eid, at, kind: "text", event: "text", from: { kind: "tex" }, text: m.text, delivered: true }
      : { v: 1, id: `ev${eid.replace("-", "")}`, eid, at, kind: "text", event: "text", from: { kind: "person", ...(kind === "group" ? { name: handleOf(m.who) } : {}) }, text: m.text });
  });
  return { rows, history };
}

/** A bench name as a handle (`Mia` → `mia`). */
export const handleOf = (name) => String(name ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64) || "someone";
