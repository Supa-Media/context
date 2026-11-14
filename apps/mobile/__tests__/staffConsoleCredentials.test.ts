/**
 * @jest-environment jsdom
 */
/**
 * The Credentials page of the staff console (`pages/Credentials.web.tsx`): the artifact's `P.credentials`, its side panel,
 * and the sign-in texts panel. The guard that matters most here is the secret's value: it is read from the password input
 * only inside `savesecret`, handed to `setSecret`, and the input cleared. It must never appear in the page, the side
 * panel, a toast, or an error message.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { credentialsPage } from "../features/admin/console/pages/Credentials.web";
import { toastState } from "../features/admin/console/state";

const SECRET = "sk_test_fake_9f3c";

type Row = { name: string; fingerprint: string; description?: string; updatedAt: number; updatedByEmail?: string };

function fakeData(over: Partial<{ secrets: Row[]; signIn: unknown; setSecret: unknown; deleteSecret: unknown; setSenderId: unknown }> = {}) {
  return {
    secrets: [
      { name: "STRIPE_SECRET_KEY", fingerprint: "77be·19d4", description: "Stripe secret key.", updatedAt: Date.now() - 3 * 86400e3, updatedByEmail: "ops@example.com" },
      { name: "POSTHOG_PERSONAL_API_KEY", fingerprint: "5e11·b0f3", description: "Usage page.", updatedAt: Date.now() - 40 * 86400e3 },
    ] as Row[],
    signIn: { messagingServiceSid: "MG4f2c", fromDeployment: false, saysContext: true },
    setSecret: jest.fn(async (args: { name: string }) => ({ name: args.name, fingerprint: "a91f·0c2e" })),
    deleteSecret: jest.fn(async () => ({ name: "x" })),
    setSenderId: jest.fn(async () => null),
    ...over,
  };
}
/** The fake database handed to the page's render and acts (the real one is the hook's result). */
const asD = (x: unknown) => x as never;
const acts = credentialsPage.acts!;
const el = (id: string, act = "x") => {
  const b = document.createElement("button");
  b.dataset.id = id;
  b.dataset.act = act;
  return b;
};

/** Mount a page's side panel and page slot the way the shell does, so the act can read its fields. */
function mount(props: string | null, page = "") {
  document.body.innerHTML = `<div id="app"><div id="pgin">${page}</div><div id="props"><div class="pp">${props ?? ""}</div></div></div>`;
}

beforeEach(() => {
  document.body.innerHTML = "";
  toastState.text = "";
});

describe("Credentials page: render", () => {
  it("draws the three panels with the artifact's titles while loading", () => {
    const html = credentialsPage.render!(undefined);
    expect(html).toContain("Not set");
    expect(html).toContain("Sign-in texts");
    expect(html.match(/class="empty">Loading…/g)?.length).toBe(3);
  });

  it("lists the names the code expects that are not set, with what breaks", () => {
    const html = credentialsPage.render!(asD(fakeData()));
    expect(html).toContain("SEARCH_D1_API_TOKEN");
    expect(html).toContain('data-id="set-RESEND_API_KEY_TRANSACTIONAL"');
    expect(html).toContain("Transactional mail is not sent.");
    // Stripe is set, so the Not-set panel does not offer it (the Set panel's Replace button does, by design).
    const notSet = html.slice(0, html.indexOf('data-k="cr-set"'));
    expect(notSet).not.toContain('data-id="set-STRIPE_SECRET_KEY"');
  });

  it("says so when every expected name is set", () => {
    const all = Array.from(
      new Set(["SEARCH_D1_API_TOKEN", "SEARCH_D1_ACCOUNT_ID", "STRIPE_SECRET_KEY", "MANAGED_R2_API_TOKEN", "RESEND_API_KEY_TRANSACTIONAL"]),
    ).map((name) => ({ name, fingerprint: "0000·0000", updatedAt: Date.now() }));
    const html = credentialsPage.render!(asD(fakeData({ secrets: all })));
    expect(html).toContain("Everything the code expects is set.");
  });

  it("shows fingerprints, never a value, with Replace and Delete per row", () => {
    const html = credentialsPage.render!(asD(fakeData()));
    expect(html).toContain("77be·19d4");
    expect(html).toContain('data-act="sel" data-id="set-STRIPE_SECRET_KEY">Replace');
    expect(html).toContain('data-act="askdel" data-id="STRIPE_SECRET_KEY"');
    expect(html).toContain('data-id="set-new">Add');
    expect(html).toContain("by ops@example.com");
  });

  it("asks to delete with the known name's consequence, when confirming", () => {
    const d = fakeData();
    acts.askdel!(el("STRIPE_SECRET_KEY"), asD(d));
    const html = credentialsPage.render!(asD(d));
    expect(html).toContain('data-act="delsecret" data-id="STRIPE_SECRET_KEY"');
    expect(html).toContain("Nothing can be charged.");
  });

  it("escapes a database value rather than rendering it as markup", () => {
    const hostile = fakeData({
      secrets: [{ name: "<script>alert(1)</script>", fingerprint: "<img src=x>", description: "<b>x</b>", updatedAt: Date.now() }],
    });
    const html = credentialsPage.render!(asD(hostile));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
  });

  it("draws the sign-in texts field with the stored Messaging Service and the artifact's words", () => {
    const html = credentialsPage.render!(asD(fakeData()));
    expect(html).toContain('id="mg"');
    expect(html).toContain('value="MG4f2c"');
    expect(html).toContain("Codes read “123456 is your Context code.”");
    expect(html).toContain('data-act="asksms">Clear');
  });

  it("hides the field when the deployment sets the sender itself", () => {
    const html = credentialsPage.render!(asD(fakeData({ signIn: { messagingServiceSid: null, fromDeployment: true, saysContext: true } })));
    expect(html).not.toContain('id="mg"');
    expect(html).toContain("The deployment sets the Messaging Service itself");
  });
});

describe("Credentials page: side panel", () => {
  it("is null for anything that is not a set- address", () => {
    expect(credentialsPage.props!(asD(fakeData()), "maya")).toBeNull();
  });

  it("opens Set for a name not yet set, Replace for one that is, and Add for a new one", () => {
    const d = asD(fakeData());
    expect(credentialsPage.props!(d, "set-SEARCH_D1_API_TOKEN")).toContain("Set <span");
    expect(credentialsPage.props!(d, "set-STRIPE_SECRET_KEY")).toContain("Replace <span");
    const add = credentialsPage.props!(d, "set-new")!;
    expect(add).toContain("Add a credential");
    expect(add).toContain('id="sn"');
  });

  it("renders the value field empty and never a value", () => {
    const panel = credentialsPage.props!(asD(fakeData()), "set-STRIPE_SECRET_KEY")!;
    expect(panel).toContain('id="sv" type="password"');
    expect(panel).not.toMatch(/id="sv"[^>]*value=/);
    expect(panel).toContain('data-act="savesecret" data-id="STRIPE_SECRET_KEY"');
  });

  it("escapes the name it puts in the title", () => {
    const panel = credentialsPage.props!(asD(fakeData()), "set-<img src=x onerror=1>")!;
    expect(panel).not.toContain("<img src=x");
  });
});

describe("Credentials page: acts", () => {
  it("savesecret reads the value once, hands it to setSecret, clears the input, and never toasts it", async () => {
    const d = fakeData();
    mount(credentialsPage.props!(asD(d), "set-SEARCH_D1_API_TOKEN"));
    const input = document.querySelector<HTMLInputElement>("#props #sv")!;
    input.value = SECRET;

    await acts.savesecret!(el("SEARCH_D1_API_TOKEN", "savesecret"), asD(d));

    expect(d.setSecret).toHaveBeenCalledTimes(1);
    const args = (d.setSecret as jest.Mock).mock.calls[0]![0] as { name: string; value: string };
    expect(args.name).toBe("SEARCH_D1_API_TOKEN");
    expect(args.value).toBe(SECRET);
    expect(input.value).toBe("");
    expect(toastState.text).toContain("SEARCH_D1_API_TOKEN set, fingerprint a91f·0c2e");
    expect(toastState.text).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("savesecret on a new name checks it is in capitals and does not call setSecret otherwise", async () => {
    const d = fakeData();
    mount(credentialsPage.props!(asD(d), "set-new"));
    document.querySelector<HTMLInputElement>("#props #sn")!.value = "lower case";
    document.querySelector<HTMLInputElement>("#props #sv")!.value = SECRET;
    await acts.savesecret!(el("new", "savesecret"), asD(d));
    expect(d.setSecret).not.toHaveBeenCalled();
    expect(toastState.text).toBe("Name it in capitals, like SEARCH_D1_API_TOKEN");
    expect(toastState.text).not.toContain(SECRET);
  });

  it("savesecret upper-cases a typed new name before saving it", async () => {
    const d = fakeData();
    mount(credentialsPage.props!(asD(d), "set-new"));
    document.querySelector<HTMLInputElement>("#props #sn")!.value = " search_d1_token ";
    document.querySelector<HTMLInputElement>("#props #sv")!.value = SECRET;
    await acts.savesecret!(el("new", "savesecret"), asD(d));
    expect((d.setSecret as jest.Mock).mock.calls[0]![0]).toMatchObject({ name: "SEARCH_D1_TOKEN" });
  });

  it("savesecret refuses an empty value without calling setSecret", async () => {
    const d = fakeData();
    mount(credentialsPage.props!(asD(d), "set-STRIPE_SECRET_KEY"));
    await acts.savesecret!(el("STRIPE_SECRET_KEY", "savesecret"), asD(d));
    expect(d.setSecret).not.toHaveBeenCalled();
    expect(toastState.text).toBe("Paste the value first");
  });

  it("savesecret on a failure toasts the server's message, not the arguments", async () => {
    const failing = jest.fn(async () => {
      throw Object.assign(new Error("boom"), { data: { message: "The key was refused." }, args: { value: SECRET } });
    });
    const d = fakeData({ setSecret: failing });
    mount(credentialsPage.props!(asD(d), "set-STRIPE_SECRET_KEY"));
    document.querySelector<HTMLInputElement>("#props #sv")!.value = SECRET;
    await acts.savesecret!(el("STRIPE_SECRET_KEY", "savesecret"), asD(d));
    expect(toastState.text).toBe("The key was refused.");
    expect(toastState.text).not.toContain(SECRET);
  });

  it("savesecret on a failure with no server message falls back to a flat sentence", async () => {
    const d = fakeData({ setSecret: jest.fn(async () => { throw new Error(SECRET); }) });
    mount(credentialsPage.props!(asD(d), "set-STRIPE_SECRET_KEY"));
    document.querySelector<HTMLInputElement>("#props #sv")!.value = SECRET;
    await acts.savesecret!(el("STRIPE_SECRET_KEY", "savesecret"), asD(d));
    expect(toastState.text).toBe("That did not work. Check the name and try again.");
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it("delsecret calls deleteSecret with the name and toasts the artifact's wording", async () => {
    const d = fakeData();
    await acts.delsecret!(el("POSTHOG_PERSONAL_API_KEY", "delsecret"), asD(d));
    expect(d.deleteSecret).toHaveBeenCalledWith({ name: "POSTHOG_PERSONAL_API_KEY" });
    expect(toastState.text).toBe("POSTHOG_PERSONAL_API_KEY deleted");
  });

  it("smssave refuses an ID that does not start with MG and saves a valid one", async () => {
    const d = fakeData();
    mount(null, '<input id="mg" value="AC123">');
    await acts.smssave!(el(""), asD(d));
    expect(d.setSenderId).not.toHaveBeenCalled();
    expect(toastState.text).toBe("A Messaging Service ID starts with MG");

    document.querySelector<HTMLInputElement>("#pgin #mg")!.value = "MG9999";
    await acts.smssave!(el(""), asD(d));
    expect(d.setSenderId).toHaveBeenCalledWith({ messagingServiceSid: "MG9999" });
    expect(toastState.text).toBe("Saved");
  });

  it("smsclear saves an empty sender and says codes go through Verify", async () => {
    const d = fakeData();
    await acts.smsclear!(el(""), asD(d));
    expect(d.setSenderId).toHaveBeenCalledWith({ messagingServiceSid: "" });
    expect(toastState.text).toBe("Cleared; codes go through Twilio Verify");
  });
});
