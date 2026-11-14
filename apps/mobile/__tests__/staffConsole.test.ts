/**
 * The redesigned staff console's address and stylesheet (`features/admin/console`): a place
 * survives a trip through its hash, filters stay on the pages that own them, old `/admin/<tab>`
 * bookmarks land on the page each became, and no rule of the ported stylesheet escapes `.sc`.
 */
import { CONSOLE_CSS } from "../features/admin/console/consoleCss";
import { esc, seg } from "../features/admin/console/kit";
import { hashForOldPath } from "../features/admin/console/oldPaths";
import { S, go, hashOf, placeOf, setRoutes } from "../features/admin/console/state";

beforeAll(() => {
  setRoutes({
    pages: ["home", "people", "search", "turns"],
    windowed: new Set(["home", "search", "turns"]),
    filters: { ps: ["all", ["people"]], cf: ["all", ["people"]], from: ["all", ["search"]], end: ["all", ["turns"]] },
    alias: (parts) => (parts[0] === "waitlist" ? ["people", "ps-waiting", ...parts.slice(1)] : parts),
  });
});

describe("console address", () => {
  it("round-trips page, view, filters, search words, picked thing and window", () => {
    const h = hashOf("people", [], "maya", { d: "7", f: { ps: "waiting", cf: "friend", from: "all", end: "all" }, q: "Maya L" });
    expect(h).toMatch(/^#[a-z0-9-]+$/);
    // People has no window, so d7 stays out; search words are hex so the hash stays letters, digits and hyphens.
    expect(h).toBe("#people--ps-waiting--cf-friend--q-4d617961204c--x-maya");
    expect(placeOf(h)).toEqual({ p: "people", subs: [], x: "maya", d: "30", f: { ps: "waiting", cf: "friend", from: "all", end: "all" }, q: "Maya L" });
  });

  it("keeps a filter on the page that owns it", () => {
    expect(hashOf("search", ["indexes"], null, { d: "90", f: { ps: "waiting", from: "tex", cf: "all", end: "all" }, q: "" })).toBe("#search--indexes--from-tex--d90");
  });

  it("opens Home for a page that does not exist, and reads old aliases", () => {
    expect(placeOf("#nope--x-1").p).toBe("home");
    expect(placeOf("#waitlist").f.ps).toBe("waiting");
    expect(placeOf("").p).toBe("home");
    expect(placeOf("#%E0%A4%A").p).toBe("home");
  });

  it("go() moves the state without a browser, and leaving a page drops its filters", () => {
    go("people", [], null, { f: { ps: "in", cf: "all", from: "all", end: "all" } });
    expect(S.p).toBe("people");
    expect(S.f.ps).toBe("in");
    go("turns");
    expect(S.f.ps).toBe("all");
  });
});

describe("old console bookmarks", () => {
  it.each([
    ["/admin/growth", "#growth"],
    ["/admin/estate", "#storage"],
    ["/admin/activity", "#usage"],
    ["/admin/agent/abc", "#turns"],
    ["/admin/aiCosts", "#costs"],
    ["/admin/ai/x", "#jobs"],
    ["/admin/features", "#flags"],
    ["/admin/waitlist", "#people--ps-waiting"],
    ["/admin/waitlist/let-in", "#people--ps-in"],
    ["/admin/waitlist/friends", "#people--ps-invited"],
    ["/admin", null],
    ["/admin/unknown", null],
  ])("%s → %s", (path, hash) => {
    expect(hashForOldPath(path)).toBe(hash);
  });
});

describe("console kit", () => {
  it("escapes what people wrote", () => {
    expect(esc(`<img src=x onerror="a('b')">&`)).toBe("&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
  });
  it("draws a segmented control the artifact's way", () => {
    expect(seg("Window", [["7", "7d"], ["30", "30d", 3]], "30", "win")).toBe(
      '<div class="seg" role="group" aria-label="Window"><button aria-pressed="false" data-act="win" data-v="7">7d</button><button aria-pressed="true" data-act="win" data-v="30">30d <span class="n">3</span></button></div>',
    );
  });
});

describe("console stylesheet", () => {
  it("scopes every rule under .sc", () => {
    const css = CONSOLE_CSS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, "");
    const selectors: string[] = [];
    const walk = (text: string) => {
      let i = 0;
      while (i < text.length) {
        const j = text.indexOf("{", i);
        if (j < 0) break;
        const head = text.slice(i, j).trim();
        let depth = 0,
          k = j;
        for (; k < text.length; k++) {
          if (text[k] === "{") depth++;
          else if (text[k] === "}" && --depth === 0) break;
        }
        if (head.startsWith("@")) walk(text.slice(j + 1, k));
        else selectors.push(...head.split(","));
        i = k + 1;
      }
    };
    walk(css);
    expect(selectors.length).toBeGreaterThan(100);
    const loose = selectors.map((s) => s.trim()).filter((s) => !/^\.sc(\s|$|[:.[])/.test(s));
    expect(loose).toEqual([]);
  });
});
