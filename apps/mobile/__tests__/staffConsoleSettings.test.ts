/**
 * The staff console's Settings page (`pages/Settings.web.tsx`): the signup-email switch and the
 * community links, each act calling its real mutation with the right arguments.
 */
import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { settingsPage, type SettingsData } from "../features/admin/console/pages/Settings.web";
import { S, toastState } from "../features/admin/console/state";

const el = (dataset: Record<string, string>, fields: Record<string, string> = {}) =>
  ({
    dataset,
    closest: () => ({
      querySelector: (sel: string) => (sel in fields ? { value: fields[sel], focus: () => undefined } : null),
    }),
  }) as unknown as HTMLElement;

const links = [
  { id: "k1", kind: "discord", label: "Context <b>community</b>", url: "https://discord.example.com/context", audience: "members" as const, position: 0 },
  { id: "k2", kind: "newsletter", label: "Monthly notes", url: "https://news.example.com/context", audience: "everyone" as const, position: 1 },
];

function data(over: Partial<SettingsData> = {}): SettingsData {
  return {
    alerts: { on: true, email: "staff@example.com" },
    links,
    setAlerts: jest.fn(async () => null),
    saveLink: jest.fn(async () => null),
    deleteLink: jest.fn(async () => null),
    ...over,
  };
}

const page = settingsPage;
const acts = page.acts!;

beforeAll(() => {
  jest.useFakeTimers();
});

beforeEach(() => {
  S.adding = false;
  S.confirm = null;
  toastState.text = "";
});

describe("Settings render", () => {
  it("draws the signup switch from the real setting and the links table", () => {
    const html = page.render!(data());
    expect(html).toContain("For you");
    expect(html).toContain('role="switch" aria-checked="true" aria-label="Signup emails" data-act="alerts"');
    expect(html).toContain("Community links");
    expect(html).toContain('<span class="meta">2</span>');
    expect(html).toContain("Signed-in only");
    expect(html).toContain("Everyone");
    expect(html).toContain('data-act="askrmlink" data-id="k1"');
    expect(html).toContain('data-act="addppl">Add link');
  });

  it("escapes a link's label", () => {
    const html = page.render!(data());
    expect(html).not.toContain("<b>community</b>");
    expect(html).toContain("Context &lt;b&gt;community&lt;/b&gt;");
  });

  it("draws the add form when adding, with the artifact's fields", () => {
    S.adding = true;
    const html = page.render!(data());
    expect(html).toContain('id="lu"');
    expect(html).toContain('data-act="addlink">Add');
    expect(html).toContain('data-act="addcancel">Cancel');
    expect(html).not.toContain('data-act="addppl"');
  });

  it("asks before deleting a link", () => {
    S.confirm = "rlk2";
    const html = page.render!(data());
    expect(html).toContain("Delete Monthly notes?");
    expect(html).toContain('data-act="rmlink" data-id="k2"');
  });

  it("shows Loading in both panels until the queries answer", () => {
    const html = page.render!(data({ alerts: undefined, links: undefined }));
    expect(html.match(/Loading…/g)).toHaveLength(2);
  });
});

describe("Settings acts", () => {
  it("alerts flips the real setting", async () => {
    const d = data();
    await acts.alerts(el({ id: "x" }), d);
    expect(d.setAlerts).toHaveBeenCalledWith({ on: false });
  });

  it("askrmlink and rmlink delete the picked link by id", async () => {
    acts.askrmlink(el({ id: "k1" }), data());
    expect(S.confirm).toBe("rlk1");
    const d = data();
    await acts.rmlink(el({ id: "k1" }), d);
    expect(d.deleteLink).toHaveBeenCalledWith({ id: "k1" });
    expect(toastState.text).toBe("Link deleted");
    expect(S.confirm).toBeNull();
  });

  it("addppl opens the form and addcancel closes it", () => {
    acts.addppl(el({}), data());
    expect(S.adding).toBe(true);
    acts.addcancel(el({}), data());
    expect(S.adding).toBe(false);
  });

  it("addlink refuses an address that is not https", async () => {
    S.adding = true;
    const d = data();
    await acts.addlink(el({}, { "#lu": "http://insecure.example" }), d);
    expect(d.saveLink).not.toHaveBeenCalled();
    expect(toastState.text).toBe("Links must start with https://");
  });

  it("addlink saves the typed link with its kind and audience, then closes the form", async () => {
    S.adding = true;
    const d = data();
    await acts.addlink(
      el({}, { "#lk": "x", "#ll": "Our feed", "#lu": "https://x.example/context", "#la": "everyone" }),
      d,
    );
    expect(d.saveLink).toHaveBeenCalledWith({ kind: "x", label: "Our feed", url: "https://x.example/context", audience: "everyone" });
    expect(toastState.text).toBe("Link added");
    expect(S.adding).toBe(false);
  });

  it("addlink uses the address as the label when none is typed, and keeps the form open on error", async () => {
    S.adding = true;
    const d = data({ saveLink: jest.fn(async () => Promise.reject(Object.assign(new Error("x"), { data: { message: "Too many links" } }))) });
    await acts.addlink(el({}, { "#lk": "other", "#ll": "", "#lu": "https://a.example", "#la": "members" }), d);
    expect(d.saveLink).toHaveBeenCalledWith({ kind: "other", label: "https://a.example", url: "https://a.example", audience: "members" });
    expect(toastState.text).toBe("Too many links");
    expect(S.adding).toBe(true);
  });
});
