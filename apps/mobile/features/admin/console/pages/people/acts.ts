/**
 * People's acts: the artifact's `A` entries for the page, one for one, with the same toasts,
 * confirms and undos. Each write goes through the page's mutations (`d.m`) and then redraws; a
 * failed write is a toast with the server's words, never an unhandled rejection.
 */
import { plural } from "../../kit";
import { S, go, render, setF, toast } from "../../state";
import { changeSentence, type TexChange } from "../../../texAllowlist";
import {
  displayName,
  failureText,
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

const inputValue = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? "";
const accountOf = (d: PeopleData | undefined, id: string | undefined): Person | undefined =>
  d?.people?.accounts.find((a) => a.userId === id);
/** The rows picked that match `pred`, in the list's order. */
function chosen(d: ReadyPeopleData, pred: (r: Row) => boolean): Row[] {
  return rowsOf(d.people).filter((r) => S.sel.has(r.id) && pred(r));
}

/** One Tex list change, then the list is read again so the switches match it. */
async function texChange(d: ReadyPeopleData, phone: string, change: "add" | "remove"): Promise<TexChange> {
  const result = await d.m.changeTex({ phone, change });
  await d.m.texRefresh();
  return result;
}

/**
 * Puts a person on Tex's list, or takes them off. Returns the words for a refusal, or null when it
 * worked (an add that was already there, or a remove that was already gone, counts as worked).
 */
async function setTex(d: ReadyPeopleData, p: Person, want: boolean): Promise<string | null> {
  const tv = texView(d.tex);
  if (tv.state !== "shared") return null;
  const phone = p.phone;
  if (want) {
    if (phone === null) return null;
    const r = await texChange(d, phone, "add");
    return r.status === "added" || r.status === "already" ? null : changeSentence(r).text;
  }
  for (const n of [phone, ...p.textingPhones]) {
    if (n === null || !tv.listed.has(n)) continue;
    const r = await texChange(d, n, "remove");
    if (r.status !== "removed" && r.status !== "absent") return changeSentence(r).text;
  }
  return null;
}

export const acts: Record<string, Act> = {
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
    const refusal = await setTex(d, p, !on);
    if (refusal) toast(refusal);
    else toast(on ? `${name} taken off the Tex line` : `${name} can text Tex`, () => {
      void setTex(d, p, on).then(() => render());
    });
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
    const r = await d.m.setPhone({ userId: el.dataset.id as PersonId, phone: v || null });
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
    S.confirm = null;
    toast(r.status === "saved" && r.phone ? `Saved ${r.phone}` : "Phone removed");
    render();
  }),

  phonerm: writes(async (el, d) => {
    const p = accountOf(d, el.dataset.id);
    if (!p) return;
    const old = p.phone;
    const tv = texView(d.tex);
    const wasListed = old !== null && tv.state === "shared" && tv.listed.has(old);
    const userId = p.userId;
    await d.m.setPhone({ userId, phone: null });
    if (old !== null && wasListed) await texChange(d, old, "remove");
    S.confirm = null;
    toast("Phone removed", () => {
      void (async () => {
        if (old !== null) {
          await d.m.setPhone({ userId, phone: old });
          if (wasListed) await texChange(d, old, "add");
        }
        render();
      })();
    });
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
    toast(next ? `${name} archived` : `${name} back in People`, () => {
      void d.m.setArchived({ userId: p.userId, archived: p.archived });
    });
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
    const r = await d.m.admit({ ids });
    S.sel.clear();
    S.confirm = null;
    toast(`Let in ${r.changed}; each got one email or text`);
    render();
  }),

  tell: writes(async (_el, d) => {
    const ids = chosen(d, (r) => r.st === "in").map((r) => r.id as WaitId);
    const r = await d.m.tell({ ids });
    S.sel.clear();
    S.confirm = null;
    toast(`Texted ${plural(r.texted, "person", "people")} that they're in`);
    if (S.f.told === "no") setF("told", "all");
    else render();
  }),

  remove: writes(async (_el, d) => {
    const ids = chosen(d, (r) => r.st === "waiting").map((r) => r.id as WaitId);
    const r = await d.m.remove({ ids });
    S.sel.clear();
    S.confirm = null;
    toast(`Removed ${r.changed}`, () => {
      void d.m.restore({ ids });
    });
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
