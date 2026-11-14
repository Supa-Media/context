/**
 * The staff console's Search page (`features/admin/console/pages/Search.web.tsx`): the artifact's
 * two views rendered from real report shapes, the Indexes side panel, escaping of what the database
 * wrote, and that each act calls the right Convex mutation with the right arguments.
 */
import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { searchPage } from "../features/admin/console/pages/Search.web";
import { S, go, setRoutes, toastState } from "../features/admin/console/state";

beforeAll(() => {
  // The toast keeps a timer; faked, so the run does not wait on it.
  jest.useFakeTimers();
  setRoutes({
    pages: ["home", "search"],
    windowed: new Set(["search"]),
    filters: { idx: ["attention", ["search"]], from: ["all", ["search"]] },
  });
});

beforeEach(() => {
  go("search", []);
  S.f.idx = "attention";
  S.f.from = "all";
});

const at = Date.UTC(2026, 10, 14, 10, 0, 0);

function meaningRow(over: Record<string, unknown>) {
  const slug = over.slug as string;
  return {
    workspaceId: `ws_${slug}`,
    slug,
    kind: "personal",
    enabled: true,
    status: "ready",
    errorCode: null,
    errorCause: null,
    notesIndexed: 412,
    notesPending: 0,
    priorities: null,
    fastSearch: { status: "ready", notesIndexed: 412, notesPending: 0, priorities: null },
    updatedAt: at,
    archived: false,
    ...over,
  };
}

const facts = (over: Record<string, unknown> = {}) => ({ ready: true, running: false, retrying: 0, retryKind: null, retryPasses: 0, ...over });

const meaning = {
  rows: [
    meaningRow({ slug: "maya" }),
    meaningRow({
      slug: "studio-ops",
      status: "failed",
      errorCode: "RATE_LIMITED",
      errorCause: "http_429",
      notesIndexed: 340,
      notesPending: 864,
      fastSearch: { status: "failed", notesIndexed: null, notesPending: null, priorities: null },
    }),
    meaningRow({ slug: "band-notes", enabled: false }),
  ],
  truncated: false,
};

const migration = {
  phase: 1,
  paused: false,
  changedAt: null,
  rows: [
    { workspaceId: "ws_maya", slug: "maya", archived: false, facts: facts() },
    { workspaceId: "ws_studio-ops", slug: "studio-ops", archived: false, facts: facts({ ready: false, running: true, retrying: 3, retryKind: "other", retryPasses: 5 }) },
    { workspaceId: "ws_band-notes", slug: "band-notes", archived: false, facts: facts() },
  ],
  truncated: false,
};

const view = (over: Record<string, unknown> = {}) => ({ n: 1000, found: 60, pos: [40, 10, 5, 3, 2], next: [25, 15], ms: [180, 620], foundBefore: 57, ...over });
const series = Array.from({ length: 30 }, (_, i) => ({ found: 50 + i, first: 30 + i, p50: 200, p95: 800 }));
const quality = {
  all: view(),
  app: view({ n: 300 }),
  ai: view({ n: 500 }),
  tex: view({ n: 200 }),
  series: { all: series, app: series, ai: series, tex: series },
  byIndex: [{ answeredBy: "fast", share: 58, found: 82, first: 51, p50: 160 }],
  misses: [
    { workspaceId: "ws_studio-ops", slug: "studio-ops", n: 212, found: 58, why: "index failed" },
    { workspaceId: "ws_evil", slug: "<script>x</script>", n: 5, found: 10, why: "" },
    { workspaceId: "ws_quote", slug: 'a"b', n: 3, found: 0, why: "index failed" },
  ],
};

/** A `useData` result as the shell hands it over (the page reads it as `unknown`). */
function data(over: Record<string, unknown> = {}) {
  return { report: { quality }, meaning, migration, restartFast: jest.fn(), restartMeaning: jest.fn(), setPaused: jest.fn(), ...over } as never;
}

const html = (d: unknown) => searchPage.render!(d as never);
const el = (dataset: Record<string, string>, text = "") => ({ dataset, textContent: text }) as unknown as HTMLElement;

describe("Search: speed and quality", () => {
  it("draws the tabs, the who-searched choice and the four tiles from the quality figures", () => {
    const h = html(data());
    expect(h).toContain("Speed and quality");
    expect(h).toContain("Who searched");
    expect(h).toContain("Found what they wanted");
    expect(h).toContain("1,000");
    expect(h).toContain("60%");
    // Took the first result: 40 of the 60 that found something.
    expect(h).toContain("67%");
    // Found 60 against 57 before: a rise of three points.
    expect(h).toContain("+3 pts");
    expect(h).toContain("180 ms");
  });

  it("switches the figures to the chosen searcher, and marks the choice", () => {
    S.f.from = "tex";
    const h = html(data({ report: { quality: { ...quality, tex: view({ n: 200 }) } } }));
    expect(h).toMatch(/aria-pressed="true" data-act="from" data-v="tex"/);
    expect(h).toContain(">200<");
  });

  it("draws zeros, not NaN, when the server has not sent the quality field yet", () => {
    const h = html(data({ report: { truncated: false } }));
    expect(h).toContain("Speed and quality");
    expect(h).not.toContain("NaN");
    expect(h).toContain("0%");
  });

  it("keeps the panels and shows Loading in their bodies while the report loads", () => {
    const h = html(undefined);
    expect(h).toContain("Which result they open");
    expect(h).toContain('<div class="empty">Loading…</div>');
    expect(h).not.toContain("NaN");
  });

  it("makes a miss clickable only when its reason says the index failed, and escapes the workspace name", () => {
    const h = html(data());
    expect(h).toMatch(/data-act="goidx" data-id="studio-ops"/);
    expect(h).toContain("@studio-ops");
    expect(h).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(h).not.toContain("<script>x</script>");
    // A clickable miss carries its slug in data-id, so a quote in it must not end the attribute.
    expect(h).toMatch(/data-act="goidx" data-id="a&quot;b"/);
    expect(h).not.toContain('data-id="a"b"');
    expect(h.match(/data-act="goidx"/g)).toHaveLength(2);
  });
});

describe("Search: indexes", () => {
  beforeEach(() => {
    go("search", ["indexes"]);
  });

  it("lists only the workspaces that need attention by default, with the artifact's state words", () => {
    const h = html(data());
    expect(h).toContain("Needs attention");
    expect(h).toContain("@studio-ops");
    expect(h).not.toContain("@maya");
    expect(h).toContain("Can&#39;t read");
    expect(h).toContain("Failed");
    expect(h).toContain("Restart 1 failed");
    expect(h).toContain("1 workspace");
  });

  it("shows every workspace under All, with Off by owner for one the owner turned off", () => {
    S.f.idx = "all";
    const h = html(data());
    expect(h).toContain("@maya");
    expect(h).toContain("Off by owner");
    expect(h).toContain("3 workspaces");
  });

  it("escapes a slug the database holds", () => {
    S.f.idx = "all";
    const meanings = { rows: [...meaning.rows, meaningRow({ slug: "<img src=x>" })], truncated: false };
    const h = html(data({ meaning: meanings, migration: { ...migration, rows: [...migration.rows, { workspaceId: "ws_<img src=x>", slug: "<img src=x>", archived: false, facts: facts() }] } }));
    expect(h).toContain("@&lt;img src=x&gt;");
    expect(h).not.toContain("<img src=x>");
  });

  it("draws the side panel for one index, with a restart button for the failed ones only", () => {
    const panel = searchPage.props!(data(), "studio-ops");
    expect(panel).toContain("<h3 tabindex=\"-1\">@studio-ops</h3>");
    expect(panel).toContain('data-act="restart" data-id="studio-ops" data-i="2">Restart fast search');
    expect(panel).toContain('data-act="restart" data-id="studio-ops" data-i="3">Restart meaning');
    expect(panel).toContain("Cloudflare rate limited us (http_429)");
    const healthy = searchPage.props!(data(), "maya");
    expect(healthy).not.toContain("data-act=\"restart\"");
    expect(searchPage.props!(data(), "nobody")).toBeNull();
    expect(searchPage.props!(undefined, "maya")).toBeNull();
  });

  it("is windowed on the quality view only", () => {
    expect((searchPage.windowed as () => boolean)()).toBe(false);
    go("search", []);
    expect((searchPage.windowed as () => boolean)()).toBe(true);
  });
});

describe("Search: acts", () => {
  it("restarts fast search for the workspace the row names", async () => {
    const d = data();
    await searchPage.acts!.restart!(el({ id: "studio-ops", i: "2" }, "Restart fast search"), d);
    expect((d as { restartFast: jest.Mock }).restartFast).toHaveBeenCalledWith({ workspaceId: "ws_studio-ops" });
    expect(toastState.text).toBe("Restart fast search for @studio-ops");
  });

  it("restarts search by meaning for the workspace the row names", async () => {
    const d = data();
    await searchPage.acts!.restart!(el({ id: "studio-ops", i: "3" }, "Restart meaning"), d);
    expect((d as { restartMeaning: jest.Mock }).restartMeaning).toHaveBeenCalledWith({ workspaceId: "ws_studio-ops" });
    expect(toastState.text).toBe("Restart meaning for @studio-ops");
  });

  it("pauses the facts when they run, and resumes them when paused", async () => {
    const d = data();
    await searchPage.acts!.restart!(el({ id: "studio-ops", i: "1" }, "Pause facts"), d);
    expect((d as { setPaused: jest.Mock }).setPaused).toHaveBeenLastCalledWith({ paused: true });
    expect(toastState.text).toBe("Pause facts for @studio-ops");
    const paused = data({ migration: { ...migration, paused: true } });
    await searchPage.acts!.restart!(el({ id: "studio-ops", i: "1" }, "Resume facts"), paused);
    expect((paused as { setPaused: jest.Mock }).setPaused).toHaveBeenLastCalledWith({ paused: false });
  });

  it("restarts every failed or filling meaning index and says how many", async () => {
    const d = data();
    (d as { restartMeaning: jest.Mock }).restartMeaning.mockImplementation(async () => ({ restarted: 2 }));
    await searchPage.acts!.restartall!(el({}), d);
    expect((d as { restartMeaning: jest.Mock }).restartMeaning).toHaveBeenCalledWith({});
    expect(toastState.text).toBe("Restarted 2");
  });

  it("toasts the error's message when a restart throws", async () => {
    const d = data();
    (d as { restartFast: jest.Mock }).restartFast.mockImplementation(async () => {
      throw new Error("The index is busy");
    });
    await searchPage.acts!.restart!(el({ id: "studio-ops", i: "2" }, "Restart fast search"), d);
    expect(toastState.text).toBe("The index is busy");
  });

  it("opens an index from a failed miss, with every filter but the index's showing all", () => {
    searchPage.acts!.goidx!(el({ id: "studio-ops" }), undefined);
    expect(S.p).toBe("search");
    expect(S.subs).toEqual(["indexes"]);
    expect(S.x).toBe("studio-ops");
    expect(S.f.idx).toBe("all");
  });

  it("moves between the two views and the attention filter", () => {
    searchPage.acts!.srch!(el({ v: "indexes" }), undefined);
    expect(S.subs).toEqual(["indexes"]);
    searchPage.acts!.srch!(el({ v: "quality" }), undefined);
    expect(S.subs).toEqual([]);
    searchPage.acts!.idxf!(el({ v: "all" }), undefined);
    expect(S.f.idx).toBe("all");
    searchPage.acts!.from!(el({ v: "ai" }), undefined);
    expect(S.f.from).toBe("ai");
  });
});
