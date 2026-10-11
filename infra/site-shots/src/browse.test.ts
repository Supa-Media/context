import { describe, expect, it } from "vitest";
import { SNAPSHOT_SOURCE, offLimits, onSite, parseBrowseRequest, runSteps, snapshot, type BrowsePage } from "./browse";

/**
 * A page with a few numbered elements. `navigate` maps a ref to the address a
 * click on it leads to; `typed` records what reached each field, which is what
 * the tests check never comes back out.
 */
function fakePage(start = "https://shop.example.com/") {
  const state = {
    href: start,
    typed: {} as Record<number, string>,
    clicks: [] as number[],
    navigate: {} as Record<number, string>,
    refs: new Set([1, 2, 3, 4]),
    types: { 1: "text", 2: "password" } as Record<number, string>,
  };
  const url = () => new URL(state.href);
  const page: BrowsePage = {
    async goto(next) {
      state.href = next;
    },
    async evaluate<T>(source: string) {
      if (source === SNAPSHOT_SOURCE) {
        return {
          url: state.href,
          title: "Shop",
          text: "Welcome",
          elements: [
            { ref: 1, kind: "input text", label: "Search", filled: (state.typed[1] ?? "").length > 0 },
            { ref: 2, kind: "input password", label: "Password", filled: (state.typed[2] ?? "").length > 0, value: state.typed[2] },
            { ref: 3, kind: "button", label: "Go" },
            { ref: 4, kind: "link", label: "Local", href: "http://localhost/admin" },
          ],
        } as T;
      }
      if (source.includes("location.hostname")) return { href: state.href, host: url().hostname, origin: url().origin } as T;
      const exists = source.match(/^!!document\.querySelector\('\[data-tex-ref="(\d+)"\]'\)$/);
      if (exists) return state.refs.has(Number(exists[1])) as T;
      const kind = source.match(/data-tex-ref="(\d+)"[\s\S]*getAttribute\("type"\)[\s\S]*return (.*);/);
      if (kind) {
        const type = state.types[Number(kind[1])] ?? "";
        return (kind[2].includes('"password"') && !kind[2].includes("includes") ? type === "password" : ["text", "email", "tel"].includes(type)) as T;
      }
      const cleared = source.match(/data-tex-ref="(\d+)"[\s\S]*dispatchEvent\(new Event\("input"/);
      if (cleared) state.typed[Number(cleared[1])] = "";
      return undefined as T;
    },
    async click(selector) {
      const ref = Number(selector.match(/\d+/)![0]);
      state.clicks.push(ref);
      if (state.navigate[ref]) state.href = state.navigate[ref];
    },
    async type(selector, text) {
      const ref = Number(selector.match(/\d+/)![0]);
      state.typed[ref] = (state.typed[ref] ?? "") + text;
    },
    async select() {
      return [];
    },
    async goBack() {},
    keyboard: { async press() {} },
    async waitForNetworkIdle() {},
  };
  return { page, state };
}

describe("parseBrowseRequest", () => {
  it("takes steps it can read and refuses the whole call over one it cannot", () => {
    expect(parseBrowseRequest({ steps: [{ do: "goto", url: "https://example.com/" }, { do: "click", ref: 3 }] })).toEqual({
      session: null,
      steps: [{ do: "goto", url: "https://example.com/" }, { do: "click", ref: 3 }],
    });
    expect(parseBrowseRequest({ steps: [{ do: "click", ref: 3 }, { do: "goto", url: "http://localhost/" }] })).toBeNull();
    expect(parseBrowseRequest({ steps: [{ do: "goto", url: "https://10.0.0.1/" }] })).toBeNull();
    expect(parseBrowseRequest({ steps: [{ do: "press", key: "Meta" }] })).toBeNull();
    expect(parseBrowseRequest({ steps: [] })).toBeNull();
    expect(parseBrowseRequest({ session: "../../x", steps: [{ do: "read" }] })).toBeNull();
  });

  it("keeps a type step's sites without their www", () => {
    const parsed = parseBrowseRequest({ steps: [{ do: "type", ref: 1, text: "socks", onlyOn: ["WWW.Shop.example.com"] }] });
    expect(parsed?.steps[0]).toEqual({ do: "type", ref: 1, text: "socks", enter: false, onlyOn: ["shop.example.com"] });
  });
});

describe("onSite", () => {
  it("matches the site and what is under it, never a lookalike", () => {
    expect(onSite("www.shop.example.com", ["shop.example.com"])).toBe(true);
    expect(onSite("eu.shop.example.com", ["shop.example.com"])).toBe(true);
    expect(onSite("evilshop.example.com", ["shop.example.com"])).toBe(false);
    expect(onSite("shop.example.com.evil.test", ["shop.example.com"])).toBe(false);
  });
});

describe("runSteps", () => {
  it("types, clicks and reads, and the reading says a field is filled, not what is in it", async () => {
    const { page, state } = fakePage();
    const result = await runSteps(page, [
      { do: "type", ref: 1, text: "wool socks", enter: false, onlyOn: null },
      { do: "fill", ref: 2, value: "hunter2-secret", origin: "https://shop.example.com", field: "password" },
      { do: "click", ref: 3 },
    ]);
    expect(result.ran.every((r) => r.ok)).toBe(true);
    expect(state.typed).toEqual({ 1: "wool socks", 2: "hunter2-secret" });
    expect(state.clicks).toEqual([3]);
    expect(JSON.stringify(result)).not.toContain("hunter2-secret");
    expect(result.page.elements.find((e) => e.ref === 2)).toEqual({ ref: 2, kind: "input password", label: "Password", filled: true });
  });

  it("drops a link it could never open", async () => {
    const { page } = fakePage();
    const reading = await snapshot(page);
    expect(reading.elements.find((e) => e.ref === 4)?.href).toBeUndefined();
  });

  it("types nothing on a site the person did not name", async () => {
    const { page, state } = fakePage("https://attacker.example/");
    const result = await runSteps(page, [{ do: "type", ref: 1, text: "their salary", enter: true, onlyOn: ["shop.example.com"] }]);
    expect(result.ran).toEqual([{ do: "type", ok: false, reason: "this page is not on a site the person named" }]);
    expect(state.typed).toEqual({});
  });

  it("fills a secret only on the entry's exact origin", async () => {
    const { page, state } = fakePage("https://login.shop.example.com/");
    const result = await runSteps(page, [{ do: "fill", ref: 2, value: "hunter2-secret", origin: "https://shop.example.com", field: "password" }]);
    expect(result.ran).toEqual([{ do: "fill", ok: false, reason: "origin mismatch" }]);
    expect(state.typed).toEqual({});
  });

  it("puts a password only in a password box, never a search box that would print it", async () => {
    const { page, state } = fakePage();
    const wrongBox = await runSteps(page, [{ do: "fill", ref: 1, value: "hunter2-secret", origin: "https://shop.example.com", field: "password" }]);
    expect(wrongBox.ran).toEqual([{ do: "fill", ok: false, reason: "that is not a password box" }]);
    const userInPassword = await runSteps(page, [{ do: "fill", ref: 2, value: "ada@example.com", origin: "https://shop.example.com", field: "username" }]);
    expect(userInPassword.ran).toEqual([{ do: "fill", ok: false, reason: "that is not a username box" }]);
    expect(state.typed).toEqual({});
    const user = await runSteps(page, [{ do: "fill", ref: 1, value: "ada@example.com", origin: "https://shop.example.com", field: "username" }]);
    expect(user.ran[0]).toEqual({ do: "fill", ok: true });
  });

  it("refuses a fill that does not say which box it is for", () => {
    expect(parseBrowseRequest({ steps: [{ do: "fill", ref: 2, value: "x", origin: "https://shop.example.com" }] })).toBeNull();
  });

  it("stops when a click lands somewhere new, because the later numbers were the old page's", async () => {
    const { page, state } = fakePage();
    state.navigate[3] = "https://shop.example.com/results";
    const result = await runSteps(page, [
      { do: "click", ref: 3 },
      { do: "type", ref: 1, text: "socks", enter: false, onlyOn: null },
    ]);
    expect(result.ran.map((r) => r.do)).toEqual(["click", "read"]);
    expect(state.typed).toEqual({});
    expect(result.page.url).toBe("https://shop.example.com/results");
  });

  it("stops at a missing element and runs nothing after it", async () => {
    const { page, state } = fakePage();
    const result = await runSteps(page, [
      { do: "click", ref: 9 },
      { do: "type", ref: 1, text: "socks", enter: false, onlyOn: null },
    ]);
    expect(result.ran).toEqual([{ do: "click", ok: false, reason: "no such element; read the page again" }]);
    expect(state.typed).toEqual({});
  });

  it("leaves the rest for the next call when time runs out", async () => {
    const { page } = fakePage();
    let t = 0;
    const result = await runSteps(page, [{ do: "read" }, { do: "read" }], { budgetMs: 5, now: () => (t += 10) });
    expect(result.ran.at(-1)).toEqual({ do: "read", ok: false, reason: "out of time; run it again" });
  });

  it("never stays on Context's vault screens, by address or by a click", async () => {
    expect(offLimits("https://context.lc/vault/share/x")).toBe(true);
    expect(offLimits("https://staging.context.lc/VAULT")).toBe(true);
    expect(offLimits("https://context.lc/vaulted")).toBe(false);
    expect(offLimits("https://context.lc.evil.test/vault")).toBe(false);
    const byAddress = fakePage();
    const refused = await runSteps(byAddress.page, [{ do: "goto", url: "https://context.lc/vault/share/x" }]);
    expect(refused.ran).toEqual([{ do: "goto", ok: false, reason: "that page is off limits" }]);
    expect(byAddress.state.href).toBe("https://shop.example.com/");
    const byClick = fakePage();
    byClick.state.navigate[3] = "https://context.lc/vault/confirm";
    const clicked = await runSteps(byClick.page, [{ do: "click", ref: 3 }, { do: "click", ref: 3 }]);
    expect(clicked.ran).toEqual([{ do: "click", ok: false, reason: "that page is off limits" }]);
    expect(byClick.state.href).toBe("about:blank");
  });
});
