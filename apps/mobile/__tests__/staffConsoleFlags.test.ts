/**
 * @jest-environment jsdom
 */
/**
 * The Flags page of the staff console (`pages/Flags.web.tsx`): the artifact's `P.flags`, one panel per flag, and the
 * Tester groups panel. The acts are checked against the real mutations' argument shapes: a mode change goes to the flag
 * it was clicked on, the everyone change asks first, and a tester is added by handle or by group name.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { flagsPage } from "../features/admin/console/pages/Flags.web";
import { S, toastState } from "../features/admin/console/state";

const acts = flagsPage.acts!;
const asD = (x: unknown) => x as never;

function fakeListed() {
  return {
    today: "2026-11-14",
    flags: [
      {
        id: "mail.in-notes",
        label: "Mail in notes",
        description: "Copies mail threads into notes.",
        added: "2026-10-01",
        expires: "2027-02-06",
        daysLeft: 84,
        due: false,
        mode: "people" as "off" | "people" | "everyone",
        updatedAt: Date.now() - 6 * 86400e3,
        people: [{ userId: "u_maya", name: "@maya" }],
        groups: [{ groupId: "g_staff", name: "Staff", size: 2 }],
      },
      {
        id: "search.v2",
        label: "Search v2",
        description: "New search.",
        added: "2026-09-01",
        expires: "2026-11-01",
        daysLeft: -13,
        due: true,
        mode: "off" as "off" | "people" | "everyone",
        updatedAt: null,
        people: [],
        groups: [],
      },
    ],
    groups: [
      { groupId: "g_staff", name: "Staff", people: [{ userId: "u_seyi", name: "@seyi" }] },
      { groupId: "g_friends", name: "Friends of Tex", people: [{ userId: "u_noor", name: "<i>noor</i>" }] },
    ],
    retired: [],
  };
}

function fakeData(over: Partial<Record<string, unknown>> = {}) {
  return {
    listed: fakeListed(),
    setMode: jest.fn(async () => null),
    addPerson: jest.fn(async () => null),
    removePerson: jest.fn(async () => null),
    addGroup: jest.fn(async () => null),
    removeGroup: jest.fn(async () => null),
    createGroup: jest.fn(async () => "g_new"),
    addGroupPerson: jest.fn(async () => null),
    removeGroupPerson: jest.fn(async () => null),
    ...over,
  };
}

const el = (dataset: Record<string, string>) => {
  const b = document.createElement("button");
  Object.assign(b.dataset, dataset);
  return b;
};

/** Mount the page the way the shell does, so the act can read its inputs. */
function mount(html: string) {
  document.body.innerHTML = `<div id="app"><div id="pgin">${html}</div></div>`;
}

beforeEach(() => {
  document.body.innerHTML = "";
  toastState.text = "";
  S.confirm = null;
  S.adding = false;
});

describe("Flags page: render", () => {
  it("draws no panel the artifact lacks while loading: a Loading line, then Tester groups", () => {
    const html = flagsPage.render!(undefined);
    expect(html).not.toContain("Features");
    expect(html).not.toContain('data-k="fl-flags"');
    expect(html).toContain("Tester groups");
    expect(html.match(/class="empty">Loading…/g)?.length).toBe(2);
  });

  it("draws one panel per real flag, keyed by its id, with its label and expiry in the artifact's words", () => {
    const html = flagsPage.render!(asD(fakeData()));
    expect(html).toContain('data-k="fl-mail.in-notes"');
    expect(html).toContain('data-k="fl-search.v2"');
    expect(html).toContain("Mail in notes");
    expect(html).toContain("expires Feb 6, 2027, in 84 days");
    expect(html).toContain("expired 13 days ago, Nov 1, 2026: launch it or remove it");
    expect(html).toContain("· changed 6d ago");
  });

  it("gives every mode button its flag's id and the artifact's mode words", () => {
    const html = flagsPage.render!(asD(fakeData()));
    expect(html).toContain('aria-pressed="true" data-act="flagmode" data-id="mail.in-notes" data-v="people">Testers');
    expect(html).toContain('data-act="flagmode" data-id="search.v2" data-v="everyone">Everyone');
  });

  it("lists the testers as chips, with each one's remove button carrying its kind and key", () => {
    const html = flagsPage.render!(asD(fakeData()));
    expect(html).toContain('data-act="rmtester" data-id="mail.in-notes" data-v="group:g_staff"');
    expect(html).toContain("group: Staff");
    expect(html).toContain('data-act="rmtester" data-id="mail.in-notes" data-v="person:u_maya"');
    expect(html).toContain('data-tadd="mail.in-notes"');
  });

  it("says testers are kept when a flag is on for everyone, and shows no tester chips or add box", () => {
    const d = fakeData();
    d.listed.flags[0]!.mode = "everyone";
    const html = flagsPage.render!(asD(d));
    expect(html).toContain("Testers are kept for if you switch back.");
    expect(html).not.toContain('data-act="rmtester" data-id="mail.in-notes"');
    expect(html).not.toContain('data-tadd="mail.in-notes"');
  });

  it("shows nothing for testers when a flag is off, not even the kept note", () => {
    const d = fakeData();
    // search.v2 is off; give it testers so their absence is the mode's doing, not an empty list.
    d.listed.flags[1]!.people = [{ userId: "u_maya", name: "@maya" }];
    d.listed.flags[1]!.groups = [{ groupId: "g_staff", name: "Staff", size: 2 }];
    const html = flagsPage.render!(asD(d));
    expect(html).not.toContain('data-act="rmtester" data-id="search.v2"');
    expect(html).not.toContain('data-tadd="search.v2"');
    expect(html).not.toContain("Testers are kept for if you switch back.");
    expect(html).toContain('data-act="flagmode" data-id="search.v2" data-v="off"');
  });

  it("lists the tester groups with their people and an add box per group", () => {
    const html = flagsPage.render!(asD(fakeData()));
    expect(html).toContain('data-k="fl-groups"');
    expect(html).toContain('data-act="rmgp" data-id="g_staff" data-v="u_seyi"');
    expect(html).toContain('data-act="addgp" data-id="g_staff"');
    expect(html).toContain('data-act="addppl">New group');
  });

  it("escapes names from the database", () => {
    const html = flagsPage.render!(asD(fakeData()));
    expect(html).not.toContain("<i>noor</i>");
    expect(html).toContain("&lt;i&gt;noor&lt;/i&gt;");
  });

  it("asks for the everyone confirm only on the flag that is being switched", () => {
    S.confirm = "flagall" + "search.v2";
    const html = flagsPage.render!(asD(fakeData()));
    expect(html).toContain('data-act="flagall" data-id="search.v2"');
    expect(html).toContain("Turn Search v2 on for every account?");
    expect(html.match(/data-act="flagall"/g)?.length).toBe(1);
  });

  it("opens the group form when adding, and not the New group button", () => {
    S.adding = true;
    const html = flagsPage.render!(asD(fakeData()));
    expect(html).toContain('id="gname"');
    expect(html).toContain('data-act="newgroup"');
    expect(html).not.toContain('data-act="addppl">New group');
  });
});

describe("Flags page: acts", () => {
  it("flagmode sets the mode on the flag its button names", async () => {
    const d = fakeData();
    await acts.flagmode!(el({ id: "search.v2", v: "people" }), asD(d));
    expect(d.setMode).toHaveBeenCalledWith({ flagId: "search.v2", mode: "people" });
    expect(toastState.text).toBe("Search v2: testers");
  });

  it("flagmode to everyone asks first and does not change the flag", async () => {
    const d = fakeData();
    await acts.flagmode!(el({ id: "search.v2", v: "everyone" }), asD(d));
    expect(d.setMode).not.toHaveBeenCalled();
    expect(S.confirm).toBe("flagall" + "search.v2");
  });

  it("flagall sets the flag it was confirmed for, and only that one", async () => {
    const d = fakeData();
    S.confirm = "flagall" + "search.v2";
    await acts.flagall!(el({ id: "search.v2" }), asD(d));
    expect(d.setMode).toHaveBeenCalledTimes(1);
    expect(d.setMode).toHaveBeenCalledWith({ flagId: "search.v2", mode: "everyone" });
    expect(toastState.text).toBe("Search v2 is on for everyone");
    expect(S.confirm).toBeNull();
  });

  it("rmtester removes a group or a person by the kind in data-v", async () => {
    const d = fakeData();
    await acts.rmtester!(el({ id: "mail.in-notes", v: "group:g_staff" }), asD(d));
    expect(d.removeGroup).toHaveBeenCalledWith({ flagId: "mail.in-notes", groupId: "g_staff" });
    await acts.rmtester!(el({ id: "mail.in-notes", v: "person:u_maya" }), asD(d));
    expect(d.removePerson).toHaveBeenCalledWith({ flagId: "mail.in-notes", userId: "u_maya" });
  });

  it("addtester adds a handle as a person, and a group's name as the group, then clears the box", async () => {
    const d = fakeData();
    mount('<input data-tadd="mail.in-notes" value="  @jordan ">');
    await acts.addtester!(el({ id: "mail.in-notes" }), asD(d));
    expect(d.addPerson).toHaveBeenCalledWith({ flagId: "mail.in-notes", who: "@jordan" });
    expect(document.querySelector<HTMLInputElement>('input[data-tadd="mail.in-notes"]')!.value).toBe("");

    document.querySelector<HTMLInputElement>('input[data-tadd="mail.in-notes"]')!.value = "friends of tex";
    await acts.addtester!(el({ id: "mail.in-notes" }), asD(d));
    expect(d.addGroup).toHaveBeenCalledWith({ flagId: "mail.in-notes", groupId: "g_friends" });
  });

  it("addtester with an empty box does nothing", async () => {
    const d = fakeData();
    mount('<input data-tadd="mail.in-notes" value="   ">');
    await acts.addtester!(el({ id: "mail.in-notes" }), asD(d));
    expect(d.addPerson).not.toHaveBeenCalled();
    expect(d.addGroup).not.toHaveBeenCalled();
  });

  it("addtester toasts the server's message when nobody matches", async () => {
    const d = fakeData({
      addPerson: jest.fn(async () => {
        throw Object.assign(new Error("x"), { data: { message: "Nobody has that handle, email or phone." } });
      }),
    });
    mount('<input data-tadd="mail.in-notes" value="@nobody">');
    await acts.addtester!(el({ id: "mail.in-notes" }), asD(d));
    expect(toastState.text).toBe("Nobody has that handle, email or phone.");
  });

  it("addgp adds a person to the group whose box it came from", async () => {
    const d = fakeData();
    mount('<input data-gid="g_friends" value="@rosa">');
    await acts.addgp!(el({ id: "g_friends" }), asD(d));
    expect(d.addGroupPerson).toHaveBeenCalledWith({ groupId: "g_friends", who: "@rosa" });
  });

  it("rmgp removes a person from a group", async () => {
    const d = fakeData();
    await acts.rmgp!(el({ id: "g_staff", v: "u_seyi" }), asD(d));
    expect(d.removeGroupPerson).toHaveBeenCalledWith({ groupId: "g_staff", userId: "u_seyi" });
  });

  it("addppl opens the group form and addcancel closes it", () => {
    acts.addppl!(el({}), asD(fakeData()));
    expect(S.adding).toBe(true);
    acts.addcancel!(el({}), asD(fakeData()));
    expect(S.adding).toBe(false);
  });

  it("newgroup makes a group with the typed name, and asks for one when it is empty", async () => {
    const d = fakeData();
    mount('<input id="gname" value="">');
    await acts.newgroup!(el({}), asD(d));
    expect(d.createGroup).not.toHaveBeenCalled();
    expect(toastState.text).toBe("Name the group");

    S.adding = true;
    mount('<input id="gname" value="  Beta testers ">');
    await acts.newgroup!(el({}), asD(d));
    expect(d.createGroup).toHaveBeenCalledWith({ name: "Beta testers" });
    expect(S.adding).toBe(false);
  });
});
