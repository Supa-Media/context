/**
 * What a made-up chat's views read of it now: who is here (after the joins and leaves in its rows), each person's
 * account, the label Tex sees a guest by, and the "Tex can see" chips: the preview's own answer once a text has run,
 * the estimate before that, a workspace a join just took away marked as such.
 */
import type { SandboxState } from "../../../engine/sandbox";
import { groupOf, seeChips, type Account, type SeeChip, type WorldPerson } from "./worldModel";
import { lastGroup, peopleAfter } from "./chatModel";
import type { WorldState } from "./worldStore";

export type WorldNow = {
  here: WorldPerson[];
  /** Null while nothing says what Tex can see (an attached chat before its first answer). */
  chips: SeeChip[] | null;
  account: (name: string) => Account;
  guest: (name: string) => string | undefined;
  /** The person the newest people row added, highlighted in the strip. */
  newcomer: string | null;
};

export function worldNow(sb: Pick<SandboxState, "rows" | "handles">, w: Pick<WorldState, "opened" | "known" | "rolesKnown">): WorldNow {
  const opened = w.opened ?? [];
  const here = peopleAfter(opened, w.known, sb.rows);
  const group = lastGroup(sb.rows);
  const byHandle = new Map(Object.entries(sb.handles).map(([n, h]) => [h, n]));
  let at = -1;
  for (let i = sb.rows.length - 1; i >= 0 && at < 0; i -= 1) if (sb.rows[i].kind === "people") at = i;
  const before = at >= 0 ? peopleAfter(opened, w.known, sb.rows.slice(0, at)) : null;
  const account = (name: string): Account => w.known[name.trim().toLowerCase()]?.account ?? "on";
  // A guest's label, when the newest answer names exactly one guest and one person here has no account.
  let labels: string[] = [];
  for (let i = sb.rows.length - 1; i >= 0 && !labels.length; i -= 1) labels = groupOf(sb.rows[i].group)?.guests ?? [];
  const noAccount = here.filter((p) => p.account !== "on");
  const guest = (name: string) => (labels.length === 1 && noAccount.length === 1 && noAccount[0].name === name ? labels[0] : undefined);
  // The preview names a guest by their label; the one person here with no account is who it means.
  const nameOf = (h: string) => byHandle.get(h) ?? (labels.length === 1 && noAccount.length === 1 && h === labels[0] ? noAccount[0].name : h);
  const chips = w.rolesKnown || group ? seeChips(here, group, nameOf, w.rolesKnown ? before : null) : null;
  const last = at >= 0 ? sb.rows[at] : null;
  return { here, chips, account, guest, newcomer: last?.change === "added" ? (last.name ?? null) : null };
}
