import { describe, expect, it } from "vitest";
import { type Uploads, MAX_UPLOAD_CHARS, SNAPSHOT_SOURCE, offLimits, onSite, parseBrowseRequest, runSteps, snapshot, uploadSource, wordsSource, type BrowsePage } from "./browse";

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
    tags: {} as Record<number, string>,
    selected: {} as Record<number, string>,
    options: {} as Record<number, string[]>,
    marked: [] as number[],
    hidden: 0,
    points: [] as Array<[number, number]>,
    ratio: 2,
    uploaded: [] as string[],
    uploadAnswer: "input",
    hooks: [] as string[],
    pickerAnswer: "none",
    dropped: [] as string[],
    marks: [] as string[],
    filledMarked: [] as string[],
    moveOnMark: null as string | null,
    markedSize: 9,
    // ./popups.ts: whether a cover sits over an element, what a box holds after typing, and what a close finds.
    covered: false,
    domClicks: 0,
    held: undefined as number | undefined,
    setDirectly: [] as string[],
    popup: false,
    closeAnswer: "none",
    hideAnswer: "none",
    closeTried: [] as string[],
    moveOnType: null as string | null,
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
      if (source.includes("return !!layerAt(")) return state.popup as T;
      if (source.includes("hit.contains(el)")) return state.covered as T;
      if (source.includes("el.click();") && source.includes("el.focus()")) {
        state.domClicks += 1;
        return true as T;
      }
      if (source.includes("return typeof el.value === \"string\" ? el.value.length")) return state.held as T;
      if (source.includes("const value = ") && source.includes("set.set.call(el, value)")) {
        state.setDirectly.push(source);
        return true as T;
      }
      if (source.includes('return "pressed";')) {
        state.closeTried.push(source.includes("!true &&") ? "frame" : "page");
        return state.closeAnswer as T;
      }
      if (source.includes('return hid > 0 ? "hid" : "none"')) return state.hideAnswer as T;
      if (source.includes("devicePixelRatio")) return { ratio: state.ratio, width: 640, height: 430 } as T;
      if (source.includes("location.hostname")) return { href: state.href, host: url().hostname, origin: url().origin } as T;
      const exists = source.match(/^!!document\.querySelector\('\[data-tex-ref="(\d+)"\]'\)$/);
      if (exists) return state.refs.has(Number(exists[1])) as T;
      if (source.includes("window.__texPicker = state")) {
        state.hooks.push(source);
        return undefined as T;
      }
      if (source.startsWith("new Promise((done)") && source.includes("__texPicker")) return state.pickerAnswer as T;
      if (source.includes("box.files[0].size")) return state.markedSize as T;
      if (source.includes(`document.querySelector('[data-tex-file-box=`)) {
        state.filledMarked.push(source);
        return true as T;
      }
      if (source.includes('setAttribute("data-tex-file-box"')) {
        state.marks.push(source);
        if (state.moveOnMark !== null) state.href = state.moveOnMark;
        return state.uploadAnswer as T;
      }
      if (source.includes("new DragEvent(")) {
        state.dropped.push(source);
        return true as T;
      }
      if (source.includes("new DataTransfer()")) {
        state.uploaded.push(source);
        return state.uploadAnswer as T;
      }
      // `fieldIs`: which kind of box the element is, read from the source's own list.
      const kind = source.match(/data-tex-ref="(\d+)"[\s\S]*tagName === "SELECT"\) return ([^;]+);[\s\S]*return (\[[^\]]*\])\.includes\(type\)/);
      if (kind) {
        const ref = Number(kind[1]);
        if (!state.refs.has(ref)) return null as T;
        if (state.tags[ref] === "SELECT") return (kind[2].includes('"select"') ? "select" : null) as T;
        return ((JSON.parse(kind[3]) as string[]).includes(state.types[ref] ?? "") ? "input" : null) as T;
      }
      const marked = source.match(/data-tex-ref="(\d+)"[\s\S]*setAttribute\("data-context-card"/);
      if (marked) {
        state.marked.push(Number(marked[1]));
        return undefined as T;
      }
      if (source.includes("context-hide-cards")) {
        state.hidden += 1;
        return undefined as T;
      }
      const pick = source.match(/data-tex-ref="(\d+)"[\s\S]*const want = "(\d+)"/);
      if (pick && source.includes("el.options")) {
        const ref = Number(pick[1]);
        const want = pick[2];
        const found = (state.options[ref] ?? []).find((o) => o === want || String(Number(o)) === String(Number(want)) || (want.length === 4 && o === want.slice(2)));
        if (found === undefined) return false as T;
        state.selected[ref] = found;
        return true as T;
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
      if (state.moveOnType !== null) state.href = state.moveOnType;
    },
    async select() {
      return [];
    },
    async goBack() {},
    keyboard: { async press() {} },
    mouse: {
      async click(x, y) {
        state.points.push([x, y]);
      },
    },
    async screenshot() {
      return "SHOT";
    },
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

  it("fills a card's parts only into boxes of their kind, and a menu only for the expiry", async () => {
    const { page, state } = fakePage("https://pay.shop.example.com/");
    const origin = "https://pay.shop.example.com";
    state.refs = new Set([1, 2, 5, 6, 7]);
    state.types = { 1: "text", 2: "password", 5: "tel" };
    state.tags = { 6: "SELECT", 7: "SELECT" };
    state.options = { 6: ["01", "08", "12"], 7: ["2028", "2029"] };
    const run = (steps: Parameters<typeof runSteps>[1]) => runSteps(page, steps);
    expect((await run([{ do: "fill", ref: 5, value: "4242424242424242", origin, field: "cc-number" }])).ran[0]).toEqual({ do: "fill", ok: true });
    expect((await run([{ do: "fill", ref: 6, value: "08", origin, field: "cc-exp-month" }])).ran[0]).toEqual({ do: "fill", ok: true });
    expect((await run([{ do: "fill", ref: 7, value: "2029", origin, field: "cc-exp-year" }])).ran[0]).toEqual({ do: "fill", ok: true });
    expect(state.selected).toEqual({ 6: "08", 7: "2029" });
    // A number is never chosen in a menu, and an expiry with no option is refused, not guessed.
    expect((await run([{ do: "fill", ref: 6, value: "4242424242424242", origin, field: "cc-number" }])).ran[0]).toEqual({ do: "fill", ok: false, reason: "that is not a cc-number box" });
    expect((await run([{ do: "fill", ref: 7, value: "2031", origin, field: "cc-exp-year" }])).ran[0]).toEqual({ do: "fill", ok: false, reason: "that menu has no option for the card's expiry" });
    expect(state.typed[5]).toBe("4242424242424242");
    expect(state.marked).toEqual(expect.arrayContaining([5, 6, 7]));
    // The site is still checked exactly.
    expect((await runSteps(page, [{ do: "fill", ref: 5, value: "4242", origin: "https://shop.example.com", field: "cc-number" }])).ran[0]).toEqual({ do: "fill", ok: false, reason: "origin mismatch" });
  });

  it("blanks a filled card's boxes before every look", async () => {
    const { page, state } = fakePage();
    await runSteps(page, [{ do: "look" }]);
    expect(state.hidden).toBe(1);
  });

  it("refuses a fill for a box kind it does not know", () => {
    expect(parseBrowseRequest({ steps: [{ do: "fill", ref: 2, value: "x", origin: "https://shop.example.com", field: "ssn" }] })).toBeNull();
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

  /*
    Chapter OS's category picker, 2026-10-20: its options are boxes with a
    click handler and no role, so a reading numbered none of them and Tex said
    its browser could not press them. The reading now numbers a hand-cursor
    box (checked in real Chromium by hand: SNAPSHOT_SOURCE needs a layout),
    and a click can name the words on the thing instead of a number.
  */
  it("clicks what shows the words it names, and says so when nothing does", async () => {
    const { page } = fakePage();
    const clicked: string[] = [];
    let shown = true;
    const byWords: BrowsePage = {
      ...page,
      async evaluate<T>(source: string) {
        if (source === wordsSource("Education")) return shown as T;
        return page.evaluate<T>(source);
      },
      async click(selector) {
        clicked.push(selector);
      },
    };
    const found = await runSteps(byWords, [{ do: "click", text: "Education" }]);
    expect(found.ran).toEqual([{ do: "click", ok: true }]);
    expect(clicked).toEqual(["[data-tex-words]"]);
    shown = false;
    const absent = await runSteps(byWords, [{ do: "click", text: "Education" }, { do: "read" }]);
    expect(absent.ran).toEqual([{ do: "click", ok: false, reason: "nothing on the page shows those words; read the page again" }]);
    expect(clicked).toHaveLength(1);
  });

  it("takes a click by words, the arrows and Space, and nothing longer or stranger", () => {
    expect(parseBrowseRequest({ steps: [{ do: "click", text: "  Education " }] })?.steps).toEqual([{ do: "click", text: "Education" }]);
    expect(parseBrowseRequest({ steps: [{ do: "click", text: "" }] })).toBeNull();
    expect(parseBrowseRequest({ steps: [{ do: "click", text: "x".repeat(201) }] })).toBeNull();
    for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Space"]) {
      expect(parseBrowseRequest({ steps: [{ do: "press", key }] })?.steps).toEqual([{ do: "press", key }]);
    }
    expect(parseBrowseRequest({ steps: [{ do: "press", key: "Control" }] })).toBeNull();
  });

  it("numbers a box only the hand cursor marks, once and never around a link", () => {
    expect(SNAPSHOT_SOURCE).toContain('getComputedStyle(el).cursor === "pointer"');
    expect(SNAPSHOT_SOURCE).toContain("!pointer(el.parentElement) && !el.querySelector(query)");
    expect(SNAPSHOT_SOURCE).toContain("[role=option]");
  });

  /* Dev, 2026-10-20: "if a human can do it, tex should be able to do it as well". */
  it("looks at the page as a picture, and clicks a point on it in the picture's own pixels", async () => {
    const { page, state } = fakePage();
    const seen = await runSteps(page, [{ do: "look" }]);
    expect(seen.page.shot).toEqual({ data: "SHOT", width: 1280, height: 860 });
    const plain = await runSteps(page, [{ do: "read" }]);
    expect(plain.page.shot).toBeUndefined();
    const tapped = await runSteps(page, [{ do: "click", x: 400, y: 300 }]);
    expect(tapped.ran).toEqual([{ do: "click", ok: true }]);
    expect(state.points).toEqual([[200, 150]]);
  });

  it("takes a point inside the picture and refuses one that is not a number", () => {
    expect(parseBrowseRequest({ steps: [{ do: "look" }, { do: "click", x: 12.5, y: 40 }] })?.steps).toEqual([{ do: "look" }, { do: "click", x: 12.5, y: 40 }]);
    expect(parseBrowseRequest({ steps: [{ do: "click", x: -1, y: 40 }] })).toBeNull();
    expect(parseBrowseRequest({ steps: [{ do: "click", x: "10", y: 40 }] })).toBeNull();
    expect(parseBrowseRequest({ steps: [{ do: "click", x: 10 }] })).toBeNull();
  });
});

describe("popups (./popups.ts)", () => {
  it("reads close_popup, and a reading says when something covers the page", async () => {
    expect(parseBrowseRequest({ steps: [{ do: "close_popup" }] })?.steps).toEqual([{ do: "close_popup" }]);
    const { page, state } = fakePage();
    expect((await runSteps(page, [{ do: "read" }])).page.popup).toBeUndefined();
    state.popup = true;
    expect((await runSteps(page, [{ do: "read" }])).page.popup).toBe(true);
  });

  it("presses an element a cover sits over from inside the page, and says so", async () => {
    const { page, state } = fakePage();
    const plain = await runSteps(page, [{ do: "click", ref: 3 }]);
    expect(plain.ran[0]).toEqual({ do: "click", ok: true });
    expect(state.clicks).toEqual([3]);
    state.covered = true;
    const covered = await runSteps(page, [{ do: "click", ref: 3 }]);
    expect(state.clicks).toEqual([3]);
    expect(state.domClicks).toBe(1);
    expect(covered.ran[0].reason).toMatch(/covered it/);
  });

  it("puts typed words in directly only when the box ended up empty", async () => {
    const { page, state } = fakePage();
    state.held = 6;
    const took = await runSteps(page, [{ do: "type", ref: 1, text: "Seyi O", enter: false, onlyOn: null }]);
    expect(took.ran[0]).toEqual({ do: "type", ok: true });
    expect(state.setDirectly).toEqual([]);
    state.held = 0;
    const lost = await runSteps(page, [{ do: "type", ref: 1, text: "Seyi O", enter: false, onlyOn: null }]);
    expect(lost.ran[0].reason).toMatch(/put in directly/);
    expect(state.setDirectly).toHaveLength(1);
    // A value is never read back: only how long it is.
    expect(JSON.stringify(lost.page)).not.toContain("Seyi O");
  });

  it("never puts a secret in directly on a page that moved while it was typed", async () => {
    const { page, state } = fakePage();
    state.held = 0;
    const fill = { do: "fill" as const, ref: 2, value: "hunter2-secret", origin: "https://shop.example.com", field: "password" as const };
    await runSteps(page, [fill]);
    expect(state.setDirectly).toHaveLength(1);
    state.moveOnType = "https://evil.example.net/";
    await runSteps(page, [fill]);
    expect(state.setDirectly).toHaveLength(1);
  });

  it("closes a popup by its own button first, and hides it only when it has none", async () => {
    const { page, state } = fakePage();
    state.closeAnswer = "pressed";
    expect((await runSteps(page, [{ do: "close_popup" }])).ran[0]).toEqual({ do: "close_popup", ok: true, reason: "pressed its close button" });
    state.closeAnswer = "none";
    state.hideAnswer = "hid";
    expect((await runSteps(page, [{ do: "close_popup" }])).ran[0].reason).toMatch(/hidden/);
    state.hideAnswer = "none";
    expect((await runSteps(page, [{ do: "close_popup" }])).ran[0].ok).toBe(false);
  });
});

describe("upload", () => {
  const file = { name: "receipt.pdf", type: "application/pdf", data: "JVBERi0xLjQK" };

  it("puts the person's file into the page, and the reading says the page takes one", async () => {
    const { page, state } = fakePage();
    const result = await runSteps(page, [{ do: "upload", ref: null, file, onlyOn: null }]);
    expect(result.ran).toEqual([{ do: "upload", ok: true }]);
    expect(state.uploaded).toHaveLength(1);
    expect(state.uploaded[0]).toContain('"receipt.pdf"');
    expect(state.uploaded[0]).toContain('"JVBERi0xLjQK"');
  });

  it("uploads nothing on a site the person did not name", async () => {
    const { page, state } = fakePage("https://attacker.example/");
    const result = await runSteps(page, [{ do: "upload", ref: null, file, onlyOn: ["shop.example.com"] }]);
    expect(result.ran).toEqual([{ do: "upload", ok: false, reason: "this page is not on a site the person named" }]);
    expect(state.uploaded).toEqual([]);
  });

  it("says so when the page has nowhere to put a file", async () => {
    const { page, state } = fakePage();
    state.uploadAnswer = "none";
    const result = await runSteps(page, [{ do: "upload", ref: null, file, onlyOn: null }]);
    expect(result.ran).toEqual([{ do: "upload", ok: false, reason: "this page has no box that takes a file; name the button that asks for one" }]);
  });

  it("presses a button that makes its file box only when pressed, and that box gets the file", async () => {
    const { page, state } = fakePage();
    state.uploadAnswer = "button";
    state.pickerAnswer = "attached";
    const result = await runSteps(page, [{ do: "upload", ref: 3, file, onlyOn: null }]);
    expect(result.ran).toEqual([{ do: "upload", ok: true }]);
    expect(state.clicks).toEqual([3]);
    expect(state.hooks).toHaveLength(1);
    expect(state.hooks[0]).toContain('"receipt.pdf"');
    expect(state.dropped).toEqual([]);
  });

  it("drops the file onto it when pressing opened no box, and says to look", async () => {
    const { page, state } = fakePage();
    state.uploadAnswer = "button";
    const result = await runSteps(page, [{ do: "upload", ref: 3, file, onlyOn: null }]);
    expect(result.ran).toEqual([
      { do: "upload", ok: true, reason: "pressing it opened no file box, so the file was dropped onto it; look to check the page took it" },
    ]);
    expect(state.dropped).toHaveLength(1);
  });

  it("a click that opens a file picker opens none, and says an upload step attaches the file", async () => {
    const { page, state } = fakePage();
    state.pickerAnswer = "asked";
    const result = await runSteps(page, [{ do: "click", ref: 3 }]);
    expect(result.ran).toEqual([
      { do: "click", ok: true, reason: "that asks for a file: an upload step naming the same element attaches one of the person's" },
    ]);
    expect(state.hooks).toHaveLength(1);
    expect(state.hooks[0]).not.toContain("new DataTransfer()");
  });

  it("takes a named file of a plain type, and nothing malformed or too big", () => {
    const step = (f: unknown, extra = {}) => parseBrowseRequest({ steps: [{ do: "upload", file: f, ...extra }] });
    expect(step(file)?.steps[0]).toEqual({ do: "upload", ref: null, file, onlyOn: null });
    expect(step(file, { ref: 3, onlyOn: ["www.chapteros.example"] })?.steps[0]).toEqual({ do: "upload", ref: 3, file, onlyOn: ["chapteros.example"] });
    expect(step({ ...file, name: "../etc/passwd" })).toBeNull();
    expect(step({ ...file, type: "text/html; charset=utf-8" })).toBeNull();
    expect(step({ ...file, data: "not base64!" })).toBeNull();
    expect(step({ ...file, data: "A".repeat(MAX_UPLOAD_CHARS + 4) })).toBeNull();
    expect(step(file, { onlyOn: [] })).toBeNull();
    expect(step(undefined)).toBeNull();
  });

  /**
   * A browser that takes a real file (./upload.ts): `stage` answers where the
   * file is on its disk, the page's `setFiles` records what it set, and with
   * `arrives` false the box reports an empty file, as when the copy is missing.
   */
  function realFiles({ page, state }: ReturnType<typeof fakePage>, arrives = true) {
    const put: Array<{ selector: string; name: string }> = [];
    const said: string[] = [];
    state.markedSize = arrives ? 9 : 0;
    page.setFiles = async (selector, paths) => {
      put.push({ selector, name: paths[0]!.slice("/tmp/.uploads/".length) });
      return true;
    };
    const uploads: Uploads = { async stage(f) { return `/tmp/.uploads/${f.name}`; }, said: (via) => said.push(via) };
    return { put, said, uploads };
  }

  it("with a browser that takes a real file, marks the box and has the browser set it, writing no file into the page", async () => {
    const fake = fakePage();
    const { page, state } = fake;
    const real = realFiles(fake);
    const result = await runSteps(page, [{ do: "upload", ref: null, file, onlyOn: null }], { uploads: real.uploads });
    expect(result.ran).toEqual([{ do: "upload", ok: true }]);
    expect(state.marks).toHaveLength(1);
    expect(state.marks[0]).not.toContain("new DataTransfer()");
    const mark = /setAttribute\("data-tex-file-box", "([a-z0-9]+)"\)/.exec(state.marks[0])![1];
    expect(mark).toMatch(/^[a-f0-9]{32}$/);
    expect(real.put).toEqual([{ selector: `[data-tex-file-box="${mark}"]`, name: "receipt.pdf" }]);
    expect(state.uploaded).toEqual([]);
    expect(state.filledMarked).toEqual([]);
    expect(real.said).toEqual(["browser"]);
  });

  it("gives a page that cannot take a file from the browser (Cloudflare's) the file from the page, as before", async () => {
    const { page, state } = fakePage();
    const said: string[] = [];
    const uploads: Uploads = { async stage() { throw new Error("never"); }, said: (via) => said.push(via) };
    const result = await runSteps(page, [{ do: "upload", ref: null, file, onlyOn: null }], { uploads });
    expect(result.ran).toEqual([{ do: "upload", ok: true }]);
    expect(state.uploaded).toHaveLength(1);
    expect(state.marks).toEqual([]);
    expect(said).toEqual([]);
  });

  it("marks each step's box afresh, so a mark a page wrote itself is never the one filled", async () => {
    const fake = fakePage();
    const { page, state } = fake;
    const real = realFiles(fake);
    await runSteps(page, [{ do: "upload", ref: null, file, onlyOn: null }, { do: "upload", ref: null, file, onlyOn: null }], { uploads: real.uploads });
    expect(real.put).toHaveLength(2);
    expect(real.put[0]!.selector).not.toBe(real.put[1]!.selector);
    expect(state.marks).toHaveLength(2);
  });

  it("puts the file in from the page when the browser could not set it", async () => {
    const fake = fakePage();
    const { page, state } = fake;
    const real = realFiles(fake, false);
    const result = await runSteps(page, [{ do: "upload", ref: null, file, onlyOn: null }], { uploads: real.uploads });
    expect(result.ran).toEqual([{ do: "upload", ok: true }]);
    expect(real.put).toHaveLength(1);
    expect(state.filledMarked).toHaveLength(1);
    expect(state.filledMarked[0]).toContain('"JVBERi0xLjQK"');
    expect(state.filledMarked[0]).toContain(real.put[0]!.selector);
    expect(real.said).toEqual(["page"]);
  });

  it("sets nothing when the page moved to another site while the box was being marked", async () => {
    const fake = fakePage();
    const { page, state } = fake;
    state.moveOnMark = "https://attacker.example/";
    const real = realFiles(fake);
    const result = await runSteps(page, [{ do: "upload", ref: null, file, onlyOn: ["shop.example.com"] }], { uploads: real.uploads });
    expect(result.ran[0]).toEqual({ do: "upload", ok: false, reason: "this page is not on a site the person named" });
    expect(real.put).toEqual([]);
    expect(state.filledMarked).toEqual([]);
  });

  it("presses a button that makes its box only when pressed, and the browser sets the file on that box", async () => {
    const fake = fakePage();
    const { page, state } = fake;
    state.uploadAnswer = "button";
    state.pickerAnswer = "attached";
    const real = realFiles(fake);
    const result = await runSteps(page, [{ do: "upload", ref: 3, file, onlyOn: null }], { uploads: real.uploads });
    expect(result.ran).toEqual([{ do: "upload", ok: true }]);
    expect(state.clicks).toEqual([3]);
    expect(state.hooks).toHaveLength(1);
    expect(state.hooks[0]).toContain('setAttribute("data-tex-file-box"');
    expect(state.hooks[0]).not.toContain("new DataTransfer()");
    expect(real.put).toHaveLength(1);
  });

  it("writes the file's name and bytes into the page as data, never as code", () => {
    const source = uploadSource(2, { name: 'a"); alert(1); ("', type: "image/png", data: "QQ==" });
    expect(source).toContain(JSON.stringify('a"); alert(1); ("'));
    expect(source).toContain(`document.querySelector('[data-tex-ref="2"]')`);
  });
});
