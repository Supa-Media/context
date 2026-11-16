/**
 * A page is read once it has loaded, not the moment a step ends (the owner,
 * 2026-11-16). A job on an old ASP.NET vendor portal read "(no text)" and
 * "(nothing)" to press on a page that had its full menus when read again
 * later, so it wandered the menus. "It's not about speed for jobs."
 *
 * Sabotage record:
 *   `readWhenLoaded` reading once and returning → "waits for a blank page to fill" fails
 *   the limit ignored → "a page still blank after the limit says so" fails (it never ends)
 *   a wait step charged to the steps after it → "a wait step waits" fails on the click
 */
import { describe, expect, it } from "vitest";
import { SNAPSHOT_SOURCE, parseBrowseRequest, runSteps, type BrowsePage } from "./browse";
import { CHAT_CONTENT_WAIT_MS, MAX_CONTENT_WAIT_MS, LOAD_STATE_SOURCE, contentWaitOf, readWhenLoaded } from "./patience";

/** A page that reads blank until `fillsAt` (ms on the fake clock), and is "loading" until `readyAt`. */
function slowPage(clock: { t: number }, { fillsAt = 0, readyAt = 0, drawn = false, href = "https://portal.example.com/Default.aspx" } = {}) {
  const seen = { reads: 0, clicks: 0 };
  const page: BrowsePage = {
    async goto() {},
    async evaluate<T>(source: string) {
      if (source === SNAPSHOT_SOURCE) {
        seen.reads += 1;
        const filled = clock.t >= fillsAt;
        return {
          url: href,
          title: "Portal",
          text: filled ? "Timesheets\nInvoices\nReports" : "",
          elements: filled ? [{ ref: 1, kind: "link", label: "Reports", href: `${href}?page=reports` }] : [],
        } as T;
      }
      if (source === LOAD_STATE_SOURCE) return { state: clock.t >= readyAt ? "complete" : "loading", drawn } as T;
      if (source.includes("location.hostname")) return { href, host: new URL(href).hostname, origin: new URL(href).origin } as T;
      if (source.includes('!!document.querySelector(\'[data-tex-ref="1"]\')')) return true as T;
      return undefined as T;
    },
    async click() {
      seen.clicks += 1;
    },
    async type() {},
    async select() {
      return [];
    },
    async goBack() {},
    keyboard: { async press() {} },
    mouse: { async click() {} },
    async screenshot() {
      return "";
    },
    async waitForNetworkIdle() {},
  };
  return { page, seen };
}

const fakeTime = (clock: { t: number }) => ({ now: () => clock.t, pause: async (ms: number) => void (clock.t += ms) });

describe("readWhenLoaded", () => {
  it("waits for a blank page to fill, polling about once a second", async () => {
    const clock = { t: 0 };
    const { page, seen } = slowPage(clock, { fillsAt: 4_500 });
    const reading = await readWhenLoaded(page, 60_000, fakeTime(clock));
    expect(reading.text).toContain("Invoices");
    expect(reading.elements).toHaveLength(1);
    expect(reading.loading).toBeUndefined();
    expect(reading.waited).toBe(5);
    expect(seen.reads).toBe(6);
  });

  it("a page still blank after the limit says so, and the wait ends at the limit", async () => {
    const clock = { t: 0 };
    const { page } = slowPage(clock, { fillsAt: Infinity });
    const reading = await readWhenLoaded(page, CHAT_CONTENT_WAIT_MS, fakeTime(clock));
    expect(reading.text).toBe("");
    expect(reading.loading).toBe(8);
    expect(clock.t).toBe(CHAT_CONTENT_WAIT_MS);
  });

  it("a page with words that is still loading is given a little longer to finish", async () => {
    const clock = { t: 0 };
    const { page } = slowPage(clock, { readyAt: 2_000 });
    const reading = await readWhenLoaded(page, 60_000, fakeTime(clock));
    expect(clock.t).toBe(2_000);
    expect(reading.waited).toBe(2);
    // One that never finishes is read with what it has, well before the job's limit.
    const forever = { t: 0 };
    const never = slowPage(forever, { readyAt: Infinity });
    const got = await readWhenLoaded(never.page, 60_000, fakeTime(forever));
    expect(got.text).toContain("Reports");
    expect(forever.t).toBeLessThanOrEqual(10_000);
  });

  it("does not wait at all with no limit, nor on a page not yet opened", async () => {
    const clock = { t: 0 };
    const { page } = slowPage(clock, { fillsAt: Infinity });
    const reading = await readWhenLoaded(page, 0, fakeTime(clock));
    expect(clock.t).toBe(0);
    expect(reading.loading).toBeUndefined();
    const blankTab = slowPage(clock, { fillsAt: Infinity, href: "about:blank" });
    await readWhenLoaded(blankTab.page, 60_000, fakeTime(clock));
    expect(clock.t).toBe(0);
  });

  it("does not wait on a page drawn rather than written (a PDF's viewer, a canvas app), and says so", async () => {
    const clock = { t: 0 };
    const { page } = slowPage(clock, { fillsAt: Infinity, drawn: true });
    const reading = await readWhenLoaded(page, 60_000, fakeTime(clock));
    expect(clock.t).toBe(0);
    expect(reading.drawn).toBe(true);
    expect(reading.loading).toBeUndefined();
  });
});

describe("runSteps with patience", () => {
  it("an opened page is read once it has filled, inside a job's wait", async () => {
    const clock = { t: 0 };
    const { page } = slowPage(clock, { fillsAt: 20_000 });
    const result = await runSteps(page, [{ do: "goto", url: "https://portal.example.com/Default.aspx" }], { ...fakeTime(clock), waitMs: 70_000 });
    expect(result.ran).toEqual([{ do: "goto", ok: true }]);
    expect(result.page.text).toContain("Timesheets");
    expect(result.page.loading).toBeUndefined();
  });

  it("a wait step waits, and the steps after it still run", async () => {
    const clock = { t: 0 };
    const { page, seen } = slowPage(clock);
    const parsed = parseBrowseRequest({ steps: [{ do: "wait", seconds: 30 }, { do: "click", ref: 1 }] });
    expect(parsed?.steps[0]).toEqual({ do: "wait", seconds: 30 });
    const result = await runSteps(page, parsed!.steps, { ...fakeTime(clock), waitMs: 70_000 });
    expect(result.ran.map((r) => r.ok)).toEqual([true, true]);
    expect(seen.clicks).toBe(1);
    expect(clock.t).toBeGreaterThanOrEqual(30_000);
    // An open after a wait is not turned away for the time the wait took.
    const after = await runSteps(page, [{ do: "wait", seconds: 20 }, { do: "goto", url: "https://portal.example.com/Default.aspx" }], { ...fakeTime(clock), waitMs: 70_000 });
    expect(after.ran.map((r) => r.ok)).toEqual([true, true]);
  });

  it("a wait step never outlasts the call's own wait", async () => {
    const clock = { t: 0 };
    const { page } = slowPage(clock);
    const result = await runSteps(page, [{ do: "wait", seconds: 60 }], { ...fakeTime(clock), waitMs: CHAT_CONTENT_WAIT_MS });
    expect(result.ran[0]).toMatchObject({ do: "wait", ok: true });
    expect(result.ran[0].reason).toMatch(/8 seconds/);
    expect(clock.t).toBeLessThanOrEqual(CHAT_CONTENT_WAIT_MS + 1_000);
  });

  it("takes a wait step of 1 to 60 seconds and nothing else", () => {
    for (const seconds of [0, 61, -1, "5", null, Number.NaN]) expect(parseBrowseRequest({ steps: [{ do: "wait", seconds }] })).toBeNull();
    expect(parseBrowseRequest({ steps: [{ do: "wait", seconds: 2.4 }] })?.steps[0]).toEqual({ do: "wait", seconds: 2 });
  });
});

describe("contentWaitOf", () => {
  it("a chat's wait unless the gateway says otherwise, and never past the most", () => {
    expect(contentWaitOf({})).toBe(CHAT_CONTENT_WAIT_MS);
    expect(contentWaitOf({ waitMs: 70_000 })).toBe(70_000);
    expect(contentWaitOf({ waitMs: 10 * 60_000 })).toBe(MAX_CONTENT_WAIT_MS);
    expect(contentWaitOf({ waitMs: 0 })).toBe(0);
    expect(contentWaitOf({ waitMs: "lots" })).toBe(CHAT_CONTENT_WAIT_MS);
    expect(contentWaitOf(null)).toBe(CHAT_CONTENT_WAIT_MS);
  });
});
