/** @jest-environment jsdom */
/**
 * The third sweep of the staff console's AI and Platform pages against the approved artifact:
 * the words, empty tables and states the artifact has, checked page by page.
 */
import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { ago } from "../features/admin/console/pages/ago";
import { credentialsPage } from "../features/admin/console/pages/Credentials.web";
import { storagePage, type StorageData } from "../features/admin/console/pages/Storage.web";
import { settingsPage, type SettingsData } from "../features/admin/console/pages/Settings.web";
import { qualityHtml, type SearchQuality } from "../features/admin/console/pages/searchQuality.web";
import { indexProps, stateWord } from "../features/admin/console/pages/searchIndexesView.web";
import type { IndexCell, WorkspaceIndexes } from "../features/admin/searchIndexes";
import { S } from "../features/admin/console/state";

const DAY = 86_400_000;
const asD = (x: unknown) => x as never;

beforeAll(() => {
  jest.useFakeTimers();
});

beforeEach(() => {
  S.d = "30";
  S.f = { ws: "all", from: "all", idx: "attention" };
  S.confirm = null;
  S.adding = false;
});

describe("ago: the artifact counts in days, never months", () => {
  const now = Date.UTC(2026, 10, 14, 12);
  it.each([
    [now - 10_000, "just now"],
    [now - 4 * 60_000, "4m ago"],
    [now - 2 * 3_600_000, "2h ago"],
    [now - 6 * DAY, "6d ago"],
    [now - 34 * DAY, "34d ago"],
    [now - 400 * DAY, "400d ago"],
  ])("%p reads %p", (at, words) => {
    expect(ago(at, now)).toBe(words);
  });

  it("is what Credentials shows for a secret set 52 days ago", () => {
    const html = credentialsPage.render!(
      asD({ secrets: [{ name: "RESEND_API_KEY_TRANSACTIONAL", fingerprint: "d2c4·7a90", description: "Mail.", updatedAt: Date.now() - 52 * DAY }], signIn: undefined }),
    );
    expect(html).toContain("52d ago");
    expect(html).not.toContain("mo ago");
  });
});

describe("Credentials: an empty Set table says so", () => {
  it("draws a row saying nothing is set, never a bare header", () => {
    const html = credentialsPage.render!(asD({ secrets: [], signIn: undefined }));
    expect(html).toContain('<td colspan="4" class="empty">Nothing is set yet</td>');
  });
});

const storageData = (workspaces: unknown[]): StorageData => ({
  report: { counts: { object: 0, dual: 0, bucket: workspaces.length, total: workspaces.length }, workspaces } as never,
  rollout: undefined,
  moveHome: jest.fn(async () => null),
  retry: jest.fn(async () => null),
  pause: jest.fn(async () => null),
  resume: jest.fn(async () => null),
});

describe("Storage: the moving table", () => {
  it("says there are no workspaces rather than drawing a bare header", () => {
    expect(storagePage.render!(storageData([]))).toContain('class="empty">No workspaces yet</td>');
    S.f.ws = "dual";
    expect(storagePage.render!(storageData([]))).toContain('class="empty">No workspace is on dual</td>');
  });

  it("puts the last try's reason above its button, as every other move state does", () => {
    const html = storagePage.render!(
      storageData([
        { workspaceId: "w1", slug: "leo", kind: "personal", home: "bucket", notes: null, since: null, lastMove: { to: "dual", state: "failed", reason: null, at: 0 } },
      ]),
    );
    const reason = html.indexOf("Last try: the move failed");
    const button = html.indexOf('data-act="askmove" data-id="w1"');
    expect(reason).toBeGreaterThan(-1);
    expect(reason).toBeLessThan(button);
  });
});

describe("Settings: an empty links table says so", () => {
  it("draws a row saying there are no links", () => {
    const d: SettingsData = {
      alerts: { on: true, email: "staff@example.com" },
      links: [],
      setAlerts: jest.fn(async () => null),
      saveLink: jest.fn(async () => null),
      deleteLink: jest.fn(async () => null),
    };
    expect(settingsPage.render!(d)).toContain('<td colspan="5" class="empty">No community links yet</td>');
  });
});

const zero = { n: 0, found: 0, pos: [0, 0, 0, 0, 0], next: [0, 0], ms: [0, 0], foundBefore: 0 };
const quality = (over: Partial<SearchQuality> = {}): SearchQuality =>
  ({ all: zero, app: zero, ai: zero, tex: zero, series: [], byIndex: [], misses: [], ...over }) as SearchQuality;

describe("Search: speed and quality", () => {
  it("says no search opened nothing when there were no searches", () => {
    const html = qualityHtml("", quality(), false);
    expect(html).toContain('<span class="meta">0% of searches</span>');
    expect(html).not.toContain(">100%<");
  });

  it("leaves the open-nothing share out while the figures load", () => {
    const html = qualityHtml("", null, true);
    expect(html).not.toContain("% of searches");
  });

  it("writes a miss's searches as the artifact does, with no separator", () => {
    const html = qualityHtml(
      "",
      quality({ all: { ...zero, n: 5000, found: 50, pos: [30, 10, 5, 3, 2] }, misses: [{ workspaceId: "w1", slug: "studio-ops", n: 2120, found: 58, why: "index failed" }] as SearchQuality["misses"] }),
      false,
    );
    expect(html).toContain('<td class="r">2120</td>');
  });
});

const cell = (over: Partial<IndexCell>): IndexCell => ({ health: "ok", label: "Ready", figure: null, progress: null, problem: null, tiers: null, ...over });
const row = (over: Partial<WorkspaceIndexes>): WorkspaceIndexes => ({
  workspaceId: "w1",
  slug: "studio-ops",
  files: cell({}),
  fast: cell({}),
  meaning: cell({}),
  archived: false,
  changedAt: null,
  meaningRow: null,
  migrationRow: null,
  unreadable: null,
  ...over,
});

describe("Search: indexes in the artifact's words", () => {
  it("keeps Catching up as its own state, as the artifact's table does", () => {
    expect(stateWord(cell({ health: "working", label: "Catching up" }))).toBe("Catching up");
    expect(stateWord(cell({ health: "working", label: "Filling" }))).toBe("Indexing");
  });

  it("names a stuck index's last error, and says a ready file tree covers every note", () => {
    const html = indexProps(row({ meaning: cell({ health: "stuck", label: "Failed", problem: "The embedding call timed out" }) }));
    expect(html).toContain("Last error: The embedding call timed out");
    expect(html).toContain("Facts for every note");
    expect(html).not.toContain('<div class="sub"></div>');
  });

  it("does not call a file tree's unreadable notes an error", () => {
    const html = indexProps(row({ files: cell({ health: "stuck", label: "Can't read", problem: "3 notes keep failing to read." }) }));
    expect(html).toContain("3 notes keep failing to read.");
    expect(html).not.toContain("Last error: 3 notes");
  });
});

describe("Storage: Pause asks why with the field focused, as the artifact does", () => {
  it("focuses #why after the redraw, though the clicked button is gone", () => {
    document.body.innerHTML = '<div id="pgin"><input id="why"></div>';
    const gone = document.createElement("button");
    storagePage.acts!.askpause(gone, storageData([]));
    expect(S.confirm).toBe("pause");
    jest.runOnlyPendingTimers();
    expect(document.activeElement?.id).toBe("why");
  });
});
