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
