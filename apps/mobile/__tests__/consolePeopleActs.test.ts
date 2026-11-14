/**
 * @jest-environment jsdom
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
/**
 * People's acts (`features/admin/console/pages/people/acts.ts`) against a fake `d.m` that records
 * every call and keeps Tex's list in memory. Fixtures are fake: every name, address and phone is
 * invented. Toasts are captured, not drawn.
 */
import { acts, batchesOf } from "../features/admin/console/pages/people/acts";
import type { ConsolePeople, PeopleData, PeopleMutations, Person, TexLine, WaitRow } from "../features/admin/console/pages/people/model";
import { S } from "../features/admin/console/state";

const mockToasts: Array<{ text: string; undo?: () => unknown }> = [];
jest.mock("../features/admin/console/state", () => {
  const actual = jest.requireActual<Record<string, unknown>>("../features/admin/console/state");
  return {
    ...actual,
    toast: (text: string, undo?: () => unknown) => {
      mockToasts.push({ text, undo });
    },
    render: () => undefined,
  };
});

const lastToast = () => mockToasts[mockToasts.length - 1]!;
const el = (id?: string, v?: string) => ({ dataset: { id, v } }) as unknown as HTMLElement;

const MAYA_PHONE = "+1 555 555 0142";
const NEW_PHONE = "+1 555 555 0177";

function person(over: Partial<Person> & Pick<Person, "userId">): Person {
  return {
    name: null,
    handle: null,
    emails: [],
    phone: null,
    textingPhones: [],
    joinedAt: Date.UTC(2026, 10, 1),
    archived: false,
    lastSeenAt: null,
    from: "direct",
    invitedBy: null,
    workspaces: [],
    clients: [],
    aiUsd: 0,
    aiByFeature: [],
    ...over,
  };
}

const maya = () => person({ userId: "u_maya" as Person["userId"], name: "Maya Lindqvist", handle: "maya", phone: MAYA_PHONE, emails: ["maya@example.com"] });

function waitRow(id: string, status: WaitRow["status"], told = true, from: WaitRow["from"] = "waitlist"): WaitRow {
  return { id, who: `${id}@example.com`, email: `${id}@example.com`, phone: null, status, joinedAt: Date.UTC(2026, 10, 2), from, campaign: null, useFor: null, told } as WaitRow;
}

type Options = {
  waitlist?: WaitRow[];
  accounts?: Person[];
  texPhones?: string[];
  tellLeft?: number;
  archiveUndoFails?: string;
  admitFails?: string;
  /** remove refuses from this call on (1-based). */
  removeFailsFrom?: number;
};

/** A fake `d`: every write is recorded, and Tex's list changes as the calls say. `d.tex` is the list as it was at the start. */
function fixture(opts: Options = {}) {
  const calls: Array<[string, unknown]> = [];
  let contacts = (opts.texPhones ?? []).map((phone) => ({ phone, addedAt: null, person: null }));
  const line = (): TexLine => ({ state: "shared", line: "+1 555 555 0100", cap: 20, contacts: contacts.map((c) => ({ ...c })) }) as unknown as TexLine;
  let archiveCalls = 0;
  const m = {
    admit: async (a: { ids: string[] }) => {
      calls.push(["admit", a.ids]);
      if (opts.admitFails) throw { data: { message: opts.admitFails } };
      return { changed: a.ids.length };
    },
    remove: async (a: { ids: string[] }) => {
      calls.push(["remove", a.ids]);
      if (opts.removeFailsFrom && calls.filter(([n]) => n === "remove").length >= opts.removeFailsFrom) throw { data: { message: "Stopped." } };
      return { changed: a.ids.length };
    },
    restore: async (a: { ids: string[] }) => {
      calls.push(["restore", a.ids]);
      return { changed: a.ids.length };
    },
    tell: async (a: { ids: string[] }) => {
      calls.push(["tell", a.ids]);
      return { texted: a.ids.length, left: opts.tellLeft ?? 0 };
    },
    setPhone: async (a: { userId: string; phone: string | null }) => {
      calls.push(["setPhone", a]);
      return a.phone === null ? { status: "removed" } : { status: "saved", phone: a.phone };
    },
    setArchived: async (a: { userId: string; archived: boolean }) => {
      calls.push(["setArchived", a]);
      archiveCalls++;
      if (opts.archiveUndoFails && archiveCalls > 1) throw { data: { message: opts.archiveUndoFails } };
      return { status: "ok" };
    },
    changeTex: async (a: { phone: string; change: "add" | "remove" }) => {
      calls.push(["changeTex", a]);
      const listed = contacts.some((c) => c.phone === a.phone);
      if (a.change === "add") {
        if (listed) return { status: "already", phone: a.phone };
        contacts = [...contacts, { phone: a.phone, addedAt: null, person: null }];
        return { status: "added", phone: a.phone };
      }
      if (!listed) return { status: "absent", phone: a.phone };
      contacts = contacts.filter((c) => c.phone !== a.phone);
      return { status: "removed", phone: a.phone };
    },
    texRefresh: async () => line(),
    addToWaitlist: async () => ({ changed: 0, invalid: [] }),
    revoke: async () => ({ changed: false }),
    setInvitesOff: async () => undefined,
    closeInbox: async (a: { userId: string }) => {
      calls.push(["closeInbox", a]);
      return { changed: true };
    },
  } as unknown as PeopleMutations;
  const people: ConsolePeople = {
    accounts: opts.accounts ?? [],
    waitlist: opts.waitlist ?? [],
    invites: [],
    invitesOff: false,
    truncated: false,
  };
  const d: PeopleData = { people, mailOpen: new Set(), tex: line(), acct: undefined, m };
  return { d, calls, contacts: () => contacts.map((c) => c.phone) };
}

const callsNamed = (calls: Array<[string, unknown]>, name: string) => calls.filter(([n]) => n === name).map(([, a]) => a);

beforeEach(() => {
  S.p = "people";
  S.f = { aud: "all", ans: "0", told: "all", ps: "all", cf: "all", sort: "lastup" };
  S.q = "";
  S.x = null;
  S.sel = new Set();
  S.confirm = null;
  S.adding = false;
  mockToasts.length = 0;
  document.body.innerHTML = "";
});

describe("bulk letin, tell and remove", () => {
  it("letin picks waiting and removed rows, not the let-in ones", async () => {
    const { d, calls } = fixture({ waitlist: [waitRow("w1", "waiting"), waitRow("w2", "removed"), waitRow("w3", "admitted")] });
    S.sel = new Set(["w1", "w2", "w3"]);
    await acts.letin!(el(), d);
    expect(callsNamed(calls, "admit")).toEqual([["w1", "w2"]]);
    expect(lastToast().text).toBe("Let in 2; each got one email or text");
  });

  it("tell picks only the untold let-in rows", async () => {
    const { d, calls } = fixture({ waitlist: [waitRow("w_untold", "admitted", false), waitRow("w_told", "admitted", true), waitRow("w_wait", "waiting")] });
    S.sel = new Set(["w_untold", "w_told", "w_wait"]);
    await acts.tell!(el(), d);
    expect(callsNamed(calls, "tell")).toEqual([["w_untold"]]);
    expect(lastToast().text).toBe("Texted 1 person that they're in");
  });

  it("remove picks only waiting rows, and its Undo restores those same ids", async () => {
    const { d, calls } = fixture({ waitlist: [waitRow("w1", "waiting"), waitRow("w2", "waiting"), waitRow("w_rm", "removed"), waitRow("w_in", "admitted")] });
    S.sel = new Set(["w1", "w2", "w_rm", "w_in"]);
    await acts.remove!(el(), d);
    expect(callsNamed(calls, "remove")).toEqual([["w1", "w2"]]);
    expect(lastToast().text).toBe("Removed 2");
    await lastToast().undo!();
    expect(callsNamed(calls, "restore")).toEqual([["w1", "w2"]]);
  });

  it("sends the picked rows in batches of 200 and sums the results", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => waitRow(`w${i}`, "waiting"));
    const { d, calls } = fixture({ waitlist: rows });
    S.sel = new Set(rows.map((r) => r.id));
    await acts.letin!(el(), d);
    expect(callsNamed(calls, "admit").map((ids) => (ids as string[]).length)).toEqual([200, 200, 50]);
    expect(lastToast().text).toBe("Let in 450; each got one email or text");
  });

  it("splits ids into batches of at most the server's limit", () => {
    expect(batchesOf([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batchesOf([])).toEqual([]);
  });

  it("tell over 200 sums texted and says how many are left", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => waitRow(`t${i}`, "admitted", false));
    const { d, calls } = fixture({ waitlist: rows, tellLeft: 1 });
    S.sel = new Set(rows.map((r) => r.id));
    await acts.tell!(el(), d);
    expect(callsNamed(calls, "tell").map((ids) => (ids as string[]).length)).toEqual([200, 50]);
    expect(lastToast().text).toBe("Texted 250 people that they're in. 2 people left to text.");
  });

  it("a remove that fails partway keeps only the rows not done picked, and undoes the batches that went", async () => {
    const rows = Array.from({ length: 450 }, (_, i) => waitRow(`w${i}`, "waiting"));
    const { d, calls } = fixture({ waitlist: rows, removeFailsFrom: 2 });
    S.sel = new Set(rows.map((r) => r.id));
    S.confirm = "remove";
    await acts.remove!(el(), d);
    expect(S.sel.size).toBe(250);
    expect(S.sel.has("w0")).toBe(false);
    expect(S.sel.has("w200")).toBe(true);
    expect(S.confirm).toBeNull();
    expect(lastToast().text).toBe("Removed 200; the rest failed: Stopped.");
    await lastToast().undo!();
    expect(callsNamed(calls, "restore").map((ids) => (ids as string[]).length)).toEqual([200]);
  });

  it("a server refusal becomes the toast with the server's words", async () => {
    const { d } = fixture({ waitlist: [waitRow("w1", "waiting")], admitFails: "Too many at once." });
    S.sel = new Set(["w1"]);
    await acts.letin!(el(), d);
    expect(lastToast().text).toBe("Let 0 in; the rest failed: Too many at once.");
  });
});

describe("Tex access", () => {
  it("switching off someone with only a texting phone, then Undo puts that number back", async () => {
    const p = { ...maya(), phone: null, textingPhones: ["+1 555 555 0177"] };
    const { d, contacts } = fixture({ accounts: [p], texPhones: ["+1 555 555 0177"] });
    await acts.tex!(el("u_maya"), d);
    expect(contacts()).toEqual([]);
    await lastToast().undo!();
    expect(contacts()).toEqual(["+1 555 555 0177"]);
  });

  it("switching on, then Undo takes the number off the line", async () => {
    const { d, contacts } = fixture({ accounts: [maya()], texPhones: [] });
    await acts.tex!(el("u_maya"), d);
    expect(contacts()).toEqual([MAYA_PHONE]);
    expect(lastToast().text).toBe("Maya Lindqvist can text Tex");
    await lastToast().undo!();
    expect(contacts()).toEqual([]);
  });

  it("switching off, then Undo puts the number back on the line", async () => {
    const { d, contacts } = fixture({ accounts: [maya()], texPhones: [MAYA_PHONE] });
    await acts.tex!(el("u_maya"), d);
    expect(contacts()).toEqual([]);
    expect(lastToast().text).toBe("Maya Lindqvist taken off the Tex line");
    await lastToast().undo!();
    expect(contacts()).toEqual([MAYA_PHONE]);
  });
});

describe("phone edits keep Tex in step", () => {
  it("changing a number on the line moves it to the new number", async () => {
    const { d, calls, contacts } = fixture({ accounts: [maya()], texPhones: [MAYA_PHONE] });
    document.body.innerHTML = `<input id="ph" value="${NEW_PHONE}">`;
    await acts.phonesave!(el("u_maya"), d);
    expect(callsNamed(calls, "setPhone")).toEqual([{ userId: "u_maya", phone: NEW_PHONE }]);
    expect(callsNamed(calls, "changeTex")).toEqual([
      { phone: MAYA_PHONE, change: "remove" },
      { phone: NEW_PHONE, change: "add" },
    ]);
    expect(contacts()).toEqual([NEW_PHONE]);
    expect(lastToast().text).toBe(`Saved ${NEW_PHONE}`);
  });

  it("changing a number that was not on the line leaves the line alone", async () => {
    const { d, calls } = fixture({ accounts: [maya()], texPhones: [] });
    document.body.innerHTML = `<input id="ph" value="${NEW_PHONE}">`;
    await acts.phonesave!(el("u_maya"), d);
    expect(callsNamed(calls, "changeTex")).toEqual([]);
  });

  it("clearing the number takes it off the line", async () => {
    const { d, contacts } = fixture({ accounts: [maya()], texPhones: [MAYA_PHONE] });
    document.body.innerHTML = `<input id="ph" value="">`;
    await acts.phonesave!(el("u_maya"), d);
    expect(contacts()).toEqual([]);
    expect(lastToast().text).toBe("Phone removed");
  });

  it("removing the phone takes it off the line, and Undo restores both", async () => {
    const { d, calls, contacts } = fixture({ accounts: [maya()], texPhones: [MAYA_PHONE] });
    await acts.phonerm!(el("u_maya"), d);
    expect(contacts()).toEqual([]);
    expect(callsNamed(calls, "setPhone")).toEqual([{ userId: "u_maya", phone: null }]);
    await lastToast().undo!();
    expect(callsNamed(calls, "setPhone")).toEqual([
      { userId: "u_maya", phone: null },
      { userId: "u_maya", phone: MAYA_PHONE },
    ]);
    expect(contacts()).toEqual([MAYA_PHONE]);
  });
});

describe("undo failures", () => {
  it("an Undo that fails shows the same failure toast as a write", async () => {
    const { d } = fixture({ accounts: [maya()], archiveUndoFails: "Archive is closed for now." });
    await acts.archive!(el("u_maya"), d);
    expect(lastToast().text).toBe("Maya Lindqvist archived");
    await lastToast().undo!();
    expect(lastToast().text).toBe("Archive is closed for now.");
  });

  it("known senders only has no Undo, and says so", async () => {
    const { d, calls } = fixture({ accounts: [maya()] });
    d.mailOpen = new Set(["u_maya"]);
    await acts.mailclose!(el("u_maya"), d);
    expect(callsNamed(calls, "closeInbox")).toEqual([{ userId: "u_maya" }]);
    expect(lastToast().text).toBe("Mail now only from known senders");
    expect(lastToast().undo).toBeUndefined();
  });
});
