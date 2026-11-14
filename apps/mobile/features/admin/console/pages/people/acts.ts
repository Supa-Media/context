/**
 * People's acts: the artifact's `A` entries for the page, one for one, with the same toasts,
 * confirms and undos. Each write goes through the page's mutations (`d.m`) and then redraws; a
 * failed write is a toast with the server's words, never an unhandled rejection. Undo reads Tex's
 * list again before it acts, so it works from what is there now and not from the list at the tap.
 */
import { plural } from "../../kit";
import { S, go, render, setF, toast } from "../../state";
import { changeSentence, type TexChange } from "../../../texAllowlist";
import {
  displayName,
  failureText,
  listedOn,
  pickable,
  rowsOf,
  texOn,
  texView,
  visibleRows,
  type InviteId,
  type PeopleData,
  type Person,
  type PersonId,
  type ReadyPeopleData,
  type Row,
  type WaitId,
} from "./model";

type Act = (el: HTMLElement, d: PeopleData | undefined) => void | Promise<void>;

/** The most the server takes in one call (`checkBatch`). Bulk acts send the picked rows in batches of this. */
export const BATCH = 200;

/** A write that needs the list loaded; a failure becomes the toast, and the page redraws. */
const writes = (fn: (el: HTMLElement, d: ReadyPeopleData) => Promise<void>): Act => {
  return async (el, d) => {
    if (!d || !d.people) return;
    const ready: ReadyPeopleData = { ...d, people: d.people };
    try {
      await fn(el, ready);
    } catch (error) {
      toast(failureText(error));
      render();
    }
  };
};

/** An undo: the same failure toast as a write when it fails, then a redraw. */
const undoable = (fn: () => Promise<void>) => (): Promise<void> =>
  fn().then(
    () => render(),
    (error: unknown) => {
      toast(failureText(error));
      render();
    },
  );

const inputValue = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? "";
const accountOf = (d: PeopleData | undefined, id: string | undefined): Person | undefined =>
  d?.people?.accounts.find((a) => a.userId === id);
/** The rows picked that match `pred`, in the list's order. */
function chosen(d: ReadyPeopleData, pred: (r: Row) => boolean): Row[] {
  return rowsOf(d.people).filter((r) => S.sel.has(r.id) && pred(r));
}

/** Splits ids into batches of `BATCH`, in order. */
export function batchesOf<T>(ids: readonly T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** One Tex list change, then the list is read again so the switches match it. */
async function texChange(d: ReadyPeopleData, phone: string, change: "add" | "remove"): Promise<TexChange> {
  const result = await d.m.changeTex({ phone, change });
  await d.m.texRefresh();
  return result;
}

/**
 * Puts a person on Tex's list, or takes them off, from Tex's list as it is now. Returns the words
 * for a refusal, or null when it worked (an add that was already there, or a remove that was
 * already gone, counts as worked).
 */
/** Puts a person on Tex's line or takes them off. Returns a refusal, and the numbers it moved (for Undo). */
async function setTex(d: ReadyPeopleData, p: Person, want: boolean): Promise<{ refusal: string | null; moved: string[] }> {
  const tv = texView(await d.m.texRefresh());
  if (tv.state !== "shared") return { refusal: null, moved: [] };
  if (want) {
    const phone = p.phone ?? p.textingPhones[0] ?? null;
    if (phone === null) return { refusal: null, moved: [] };
    return await moveNumbers(d, [phone], "add");
  }
  return await moveNumbers(d, [p.phone, ...p.textingPhones].filter((n): n is string => n !== null && tv.listed.has(n)), "remove");
}

/** Adds or removes each number on Tex's line, stopping at the first refusal. */
async function moveNumbers(d: ReadyPeopleData, numbers: readonly string[], change: "add" | "remove"): Promise<{ refusal: string | null; moved: string[] }> {
  const moved: string[] = [];
  for (const n of numbers) {
    const r = await texChange(d, n, change);
    const ok = change === "add" ? r.status === "added" || r.status === "already" : r.status === "removed" || r.status === "absent";
    if (!ok) return { refusal: changeSentence(r).text, moved };
    moved.push(n);
  }
  return { refusal: null, moved };
}

/**
 * Sends ids in batches of `BATCH`. When a batch fails, the ones already done leave the selection
 * and the rest stay picked, so the bulk bar offers exactly what is left; then the failure is thrown.
 */
async function inBatches<T extends string, R>(ids: readonly T[], call: (part: T[]) => Promise<R>, done: (part: T[], r: R) => void): Promise<void> {
  for (const part of batchesOf(ids)) {
    let r: R;
    try {
      r = await call(part);
    } catch (error) {
      S.confirm = null;
      throw error;
    }
    done(part, r);
    for (const id of part) S.sel.delete(id);
  }
}

/**
 * Tex access follows a person's phone: when the old number was on the line, it comes off and the
 * new one goes on. A number that was not on the line changes nothing. Returns a refusal, or null.
 */
async function followPhone(d: ReadyPeopleData, old: string | null, next: string | null): Promise<string | null> {
  if (old === next) return null;
  const tv = texView(await d.m.texRefresh());
  if (!listedOn(tv, old) || old === null) return null;
  const removed = await texChange(d, old, "remove");
  if (removed.status !== "removed" && removed.status !== "absent") return changeSentence(removed).text;
  if (next === null) return null;
  const added = await texChange(d, next, "add");
  return added.status === "added" || added.status === "already" ? null : changeSentence(added).text;
}

export const acts: Record<string, Act> = {
  // Known senders only: there is no mutation that reopens the inbox, so this has no Undo (the artifact's has one).
  mailclose: writes(async (el, d) => {
    await d.m.closeInbox({ userId: el.dataset.id as PersonId });
    toast("Mail now only from known senders");
    render();
  }),

  gocost: (el) => go("costs", [], el.dataset.id ?? null),

  theirturns: (el) => go("turns", [], null, { q: el.dataset.id ?? "" }),

  tex: writes(async (el, d) => {
    const p = accountOf(d, el.dataset.id);
    if (!p) return;
    const name = displayName(p);
    const on = texOn(p, texView(d.tex));
    const { refusal, moved } = await setTex(d, p, !on);
    if (refusal) toast(refusal);
    else
      toast(on ? `${name} taken off the Tex line` : `${name} can text Tex`, undoable(async () => {
        const back = await moveNumbers(d, moved, on ? "add" : "remove");
        await d.m.texRefresh();
        if (back.refusal) toast(back.refusal);
      }));
    render();
  }),

  askunown: (el) => {
    S.confirm = "un" + el.dataset.id;
    render();
  },

  unown: writes(async (el, d) => {
    const n = el.dataset.id ?? "";
    const r = await texChange(d, n, "remove");
    S.confirm = null;
    toast(r.status === "removed" ? `${n} can no longer text Tex` : changeSentence(r).text);
    render();
  }),

  addnum: writes(async (_el, d) => {
    const v = inputValue("newnum").trim();
    if (!/^\+\d[\d\s-]{6,}$/.test(v)) {
      toast("Type the number with its country code, like +1 555 555 0100");
      return;
    }
    const r = await texChange(d, v, "add");
    toast(r.status === "added" ? `${r.phone} can text Tex` : changeSentence(r).text);
    render();
  }),

  phone: () => {
    S.confirm = "phone";
    render();
    setTimeout(() => document.getElementById("ph")?.focus(), 0);
  },

  phonesave: writes(async (el, d) => {
    const v = inputValue("ph").trim();
    if (v && !/^\+\d/.test(v)) {
      toast("Start with the country code, like +1");
      return;
    }
    const userId = el.dataset.id as PersonId;
    const old = accountOf(d, userId)?.phone ?? null;
    const r = await d.m.setPhone({ userId, phone: v || null });
    if (r.status === "invalid") {
      toast("Start with the country code, like +1");
      return;
    }
    if (r.status === "taken") {
      toast(`That number belongs to ${r.heldBy ?? "another account"}.`);
      return;
    }
    if (r.status === "not_found") {
      toast("That account no longer exists.");
      return;
    }
    const next = r.status === "saved" && r.phone ? r.phone : null;
    const refusal = await followPhone(d, old, next);
    S.confirm = null;
    if (refusal) toast(refusal);
    else toast(next ? `Saved ${next}` : "Phone removed");
    render();
  }),

  phonerm: writes(async (el, d) => {
    const p = accountOf(d, el.dataset.id);
    if (!p) return;
    const old = p.phone;
    const userId = p.userId;
    const wasListed = listedOn(texView(await d.m.texRefresh()), old);
    await d.m.setPhone({ userId: userId, phone: null });
    const refusal = await followPhone(d, old, null);
    S.confirm = null;
    toast(
      refusal ?? "Phone removed",
      undoable(async () => {
        if (old === null) return;
        const back = await d.m.setPhone({ userId: userId, phone: old });
        if (back.status === "taken") {
          toast(`That number belongs to ${back.heldBy ?? "another account"}.`);
          return;
        }
        if (wasListed) {
          const r = await texChange(d, old, "add");
          if (r.status !== "added" && r.status !== "already") toast(changeSentence(r).text);
        }
      }),
    );
    render();
  }),

  archive: writes(async (el, d) => {
    const p = accountOf(d, el.dataset.id);
    if (!p) return;
    const next = !p.archived;
    const name = displayName(p);
    const r = await d.m.setArchived({ userId: p.userId, archived: next });
    if (r.status === "self") {
      toast("You can't archive your own account.");
      return;
    }
    if (r.status === "not_found") {
      toast("That account no longer exists.");
      return;
    }
    toast(next ? `${name} archived` : `${name} back in People`, undoable(async () => {
      await d.m.setArchived({ userId: p.userId, archived: p.archived });
    }));
    render();
  }),

  cf: (el) => setF("cf", (el as HTMLSelectElement).value),

  psel: (el) => {
    S.sel.clear();
    S.f.told = "all";
    setF("ps", (el as HTMLSelectElement).value);
  },

  pick: (el) => {
    const id = el.dataset.id ?? "";
    if (S.sel.has(id)) S.sel.delete(id);
    else S.sel.add(id);
    S.confirm = null;
    render();
  },

  selall: (el, d) => {
    const rows = d?.people ? visibleRows(rowsOf(d.people), S.f, S.q).filter(pickable) : [];
    if ((el as HTMLInputElement).checked) rows.forEach((r) => S.sel.add(r.id));
    else S.sel.clear();
    render();
  },

  clearsel: () => {
    S.sel.clear();
    S.confirm = null;
    render();
  },

  askbulk: (el) => {
    S.confirm = el.dataset.v ?? null;
    render();
  },

  asklet: (el) => {
    S.confirm = "let" + el.dataset.id;
    render();
  },

  letone: writes(async (el, d) => {
    const id = el.dataset.id as WaitId;
    const who = d.people.waitlist.find((w) => w.id === id)?.who ?? "";
    await d.m.admit({ ids: [id] });
    S.confirm = null;
    toast(`Let in ${who}; they were told`);
    render();
  }),

  letin: writes(async (_el, d) => {
    const ids = chosen(d, (r) => r.st === "waiting" || r.st === "removed").map((r) => r.id as WaitId);
    let changed = 0;
    try {
      await inBatches(ids, (part) => d.m.admit({ ids: part }), (_p, r) => (changed += r.changed));
    } catch (error) {
      toast(`Let ${changed} in; the rest failed: ${failureText(error)}`);
      render();
      return;
    }
    S.sel.clear();
    S.confirm = null;
    toast(`Let in ${changed}; each got one email or text`);
    render();
  }),

  tell: writes(async (_el, d) => {
    const ids = chosen(d, (r) => r.st === "in" && !r.told).map((r) => r.id as WaitId);
    let texted = 0;
    let left = 0;
    try {
      await inBatches(ids, (part) => d.m.tell({ ids: part }), (_p, r) => {
        texted += r.texted;
        left += r.left;
      });
    } catch (error) {
      toast(`Texted ${plural(texted, "person", "people")}; the rest failed: ${failureText(error)}`);
      render();
      return;
    }
    S.sel.clear();
    S.confirm = null;
    toast(`Texted ${plural(texted, "person", "people")} that they're in` + (left > 0 ? `. ${plural(left, "person", "people")} left to text.` : ""));
    if (S.f.told === "no") setF("told", "all");
    else render();
  }),

  remove: writes(async (_el, d) => {
    const ids = chosen(d, (r) => r.st === "waiting").map((r) => r.id as WaitId);
    const removed: WaitId[] = [];
    let changed = 0;
    const undo = undoable(async () => {
      for (const part of batchesOf(removed)) await d.m.restore({ ids: part });
    });
    try {
      await inBatches(ids, (part) => d.m.remove({ ids: part }), (part, r) => {
        removed.push(...part);
        changed += r.changed;
      });
    } catch (error) {
      // Some went through: say so with an Undo for them, and leave the rest picked.
      toast(`Removed ${changed}; the rest failed: ${failureText(error)}`, removed.length ? undo : undefined);
      render();
      return;
    }
    S.sel.clear();
    S.confirm = null;
    toast(`Removed ${changed}`, undo);
    render();
  }),

  answered: () => setF("ans", S.f.ans === "1" ? "0" : "1"),

  toldf: (el) => {
    S.sel.clear();
    setF("told", el.dataset.v ?? "all");
  },

  addgo: writes(async (_el, d) => {
    const r = await d.m.addToWaitlist({ emails: inputValue("addbox") });
    if (r.changed === 0) {
      toast(
        r.invalid.length
          ? `Nothing added. Not an email or phone: ${r.invalid.join(", ")}`
          : "Nothing to add: type emails or phones with a country code",
      );
      render();
      return;
    }
    S.adding = false;
    toast(
      `Let in ${r.changed}; each got one email or text` +
        (r.invalid.length ? `. Skipped ${r.invalid.length} that weren't an email or phone: ${r.invalid.join(", ")}` : ""),
    );
    render();
  }),

  invon: writes(async (_el, d) => {
    const off = !d.people.invitesOff;
    await d.m.setInvitesOff({ off });
    toast(off ? "New invites paused; sent ones still work" : "Friends can invite again");
    render();
  }),

  askrevoke: (el) => {
    S.confirm = "rv" + el.dataset.id;
    render();
  },

  revoke: writes(async (el, d) => {
    const r = await d.m.revoke({ inviteId: el.dataset.id as InviteId });
    S.confirm = null;
    toast(r.changed ? "Invite revoked" : "That invite can no longer be revoked");
    render();
  }),
};
