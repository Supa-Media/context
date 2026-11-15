/**
 * @jest-environment jsdom
 */
/**
 * The Lines page of the staff console (`pages/Lines.web.tsx`): Tex's old number. The switch and the two fields are what
 * Save sends, a draft typed in a field survives the switch being flipped, and "Tell everyone" opens the run form only
 * after the confirm, while the dry run opens it with Send left off.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { forgetLinesDraft, linesPage, TELL_NEW_NUMBER_URL, type LinesData } from "../features/admin/console/pages/Lines.web";
import { S, toastState } from "../features/admin/console/state";

const acts = linesPage.acts!;
const asD = (x: unknown) => x as never;

const saved = { mode: "off" as "off" | "redirect", number: null as string | null, archiveOn: null as string | null, updatedAt: null as number | null, updatedBy: null as string | null };

function fakeData(over: Partial<LinesData> & { setting?: unknown } = {}): LinesData {
  return {
    setting: saved,
    save: jest.fn(async () => null),
    ...over,
  } as unknown as LinesData;
}

const el = (dataset: Record<string, string> = {}) => {
  const b = document.createElement("button");
  Object.assign(b.dataset, dataset);
  return b;
};

/** Mount the page the way the shell does, so an act can read what was typed. */
function mount(html: string) {
  document.body.innerHTML = `<div id="app"><div id="pgin">${html}</div></div>`;
}

const field = (id: string, value: string) => {
  const input = document.querySelector<HTMLInputElement>(`#pgin #${id}`);
  if (input === null) throw new Error(`no ${id}`);
  input.value = value;
};

beforeEach(() => {
  document.body.innerHTML = "";
  toastState.text = "";
  S.confirm = null;
  forgetLinesDraft();
});

describe("Lines page: render", () => {
  it("draws the switch off, the new number and archive day fields, Save, and both tell buttons", () => {
    const html = linesPage.render!(asD(fakeData()));
    expect(html).toContain("Old number");
    expect(html).toContain('role="switch" aria-checked="false" aria-label="Text the new number instead" data-act="lnmode"');
    expect(html).toContain('id="lnnum"');
    expect(html).toContain('id="lnday" type="date"');
    expect(html).toContain('data-act="lnsave">Save');
    expect(html).toContain('data-act="lndry">Tell everyone (dry run)');
    expect(html).toContain('data-act="lnask">Tell everyone');
  });

  it("draws the saved redirect, number and day, escaping what is typed", () => {
    const html = linesPage.render!(asD(fakeData({ setting: { ...saved, mode: "redirect", number: "+18133350746", archiveOn: "2026-12-01", updatedAt: Date.now() - 3600e3 } as never })));
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('value="+18133350746"');
    expect(html).toContain('value="2026-12-01"');
    expect(html).toContain("changed");
  });

  it("shows Loading until the setting answers", () => {
    const html = linesPage.render!(asD(fakeData({ setting: undefined } as never)));
    expect(html).toContain("Loading…");
    expect(html).not.toContain("data-act=\"lnsave\"");
  });

  it("asks before telling everyone, and not for the dry run", () => {
    S.confirm = "lntell";
    const html = linesPage.render!(asD(fakeData()));
    expect(html).toContain("Open the run form");
    expect(html).toContain('data-act="lnsend"');
    expect(html).not.toContain('data-act="lnask"');
    expect(html).toContain('data-act="lndry"');
  });
});

describe("Lines page: acts", () => {
  it("flips the switch and keeps what was typed in the fields", () => {
    mount(linesPage.render!(asD(fakeData())));
    field("lnnum", "+18133350746");
    field("lnday", "2026-12-01");
    acts.lnmode(el(), asD(fakeData()));
    expect(S.confirm).toBeNull();
    const html = linesPage.render!(asD(fakeData()));
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('value="+18133350746"');
    expect(html).toContain('value="2026-12-01"');
  });

  it("saves the mode, the number and the day, with nothing sent for a blank field", async () => {
    const d = fakeData();
    mount(linesPage.render!(asD(d)));
    field("lnnum", "+18133350746");
    field("lnday", "");
    await acts.lnsave(el(), asD(d));
    expect(d.save).toHaveBeenCalledWith({ mode: "off", number: "+18133350746", archiveOn: null });
    expect(toastState.text).toBe("Saved");
  });

  it("shows the server's words when a save is refused", async () => {
    const d = fakeData({ save: jest.fn(async () => Promise.reject(Object.assign(new Error("x"), { data: { message: "Redirecting needs a number to send people to." } }))) } as never);
    mount(linesPage.render!(asD(d)));
    await acts.lnsave(el(), asD(d));
    expect(toastState.text).toBe("Redirecting needs a number to send people to.");
  });

  it("the dry run opens the tell-everyone run form, with no confirm", () => {
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    acts.lndry(el(), asD(fakeData()));
    expect(open).toHaveBeenCalledWith(TELL_NEW_NUMBER_URL, "_blank", "noopener");
    expect(TELL_NEW_NUMBER_URL).toBe("https://github.com/Supa-Media/context/actions/workflows/tell-texters-new-number.yml");
    open.mockRestore();
  });

  it("Tell everyone asks first, and only the confirm opens the run form", () => {
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    acts.lnask(el(), asD(fakeData()));
    expect(S.confirm).toBe("lntell");
    expect(open).not.toHaveBeenCalled();
    acts.lnsend(el(), asD(fakeData()));
    expect(S.confirm).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });
});

describe("Lines page: move chats one at a time", () => {
  const moves = {
    people: [
      { phone: "+15555550100", name: "Ada", move: null },
      { phone: "+15555550101", name: "Bo", move: { status: "told", detail: null, askedAt: 1, toldAt: 2, movedAt: null, updatedAt: 2 } },
      { phone: "+15555550102", name: "<Cy>", move: { status: "failed", detail: "send_failed", askedAt: 1, toldAt: null, movedAt: null, updatedAt: 2 } },
      { phone: "+15555550103", name: "Di", move: { status: "moved", detail: null, askedAt: 1, toldAt: 2, movedAt: 3, updatedAt: 3 } },
    ],
    groups: [{ groupKey: "a".repeat(64), name: "Book club", people: 3, lastSeenAt: 1, move: null }],
  };

  it("lists every person and group with a switch and their move, names escaped", () => {
    const html = linesPage.render!(asD(fakeData({ moves: moves as never, setting: { ...saved, number: "+15555550142" } as never })));
    expect(html).toContain("Move chats");
    expect(html).toContain("1 moved");
    expect(html).toContain('aria-checked="false" aria-label="Move Ada" data-act="lnmv" data-id="person:+15555550100"');
    expect(html).toContain('aria-checked="true" aria-label="Move Bo"');
    expect(html).toContain("waiting for their first text on the new number");
    expect(html).toContain("the old line refused the text");
    expect(html).toContain("&lt;Cy&gt;");
    expect(html).not.toContain("<Cy>");
    expect(html).toContain("Book club");
    expect(html).toContain(`aria-label="Move Book club" data-act="lnmv" data-id="group:${"a".repeat(64)}"`);
    expect(html).toContain("…0100");
    expect(html).not.toContain("+15555550100</");
  });

  it("asks only after the confirm, with the chat's kind and key", async () => {
    const askMove = jest.fn(async () => null);
    const d = fakeData({ moves: moves as never, askMove });
    acts.lnmv(el({ id: "person:+15555550100" }), asD(d));
    expect(S.confirm).toBe("lnmvperson:+15555550100");
    expect(askMove).not.toHaveBeenCalled();
    expect(linesPage.render!(asD(d))).toContain('data-act="lnmvgo" data-id="person:+15555550100"');
    await acts.lnmvgo(el({ id: "person:+15555550100" }), asD(d));
    expect(askMove).toHaveBeenCalledWith({ kind: "person", key: "+15555550100" });
    expect(S.confirm).toBeNull();
    expect(toastState.text).toContain("within a minute");
  });

  it("shows the server's refusal", async () => {
    const askMove = jest.fn(async () => {
      throw Object.assign(new Error("x"), { data: { message: "Save the new number on this page first, under Old number." } });
    });
    await acts.lnmvgo(el({ id: "person:+15555550100" }), asD(fakeData({ askMove })));
    expect(toastState.text).toContain("Save the new number");
  });
});
