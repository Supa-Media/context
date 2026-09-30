import { describe, expect, test } from "@jest/globals";
import {
  canStart,
  clockLabel,
  encryptionCardView,
  failureLine,
  scopeOptions,
  startCount,
  startLabel,
  workspaceFiles,
  workspaceStatePill,
  type RolloutStatus,
} from "../features/admin/encryption";

/**
 * The staff console's managed-encryption card, as words.
 *
 * Every state on the approved artboard (Boards 1 to 3) is decided by
 * `encryptionCardView`, so these pin what each state says and which one button
 * it offers. The rules worth a red test rather than a rendering detail:
 *
 *  - a failed walk is "Failed check", offers Retry per workspace and "Resume
 *    the others", and says nothing was deleted;
 *  - "off" after some workspaces were done never says they went back to plain;
 *  - "complete" offers "Stop starting new workspaces…" only while new ones are
 *    actually being taken on;
 *  - the start button says how many, never just "Start".
 */

const NOW = new Date(2026, 8, 29, 12, 0).getTime();
const AT_0912 = new Date(2026, 8, 29, 9, 12).getTime();

function status(over: Partial<RolloutStatus> = {}): RolloutStatus {
  return {
    state: "off",
    managedTotal: 14,
    counts: { waiting: 0, encrypting: 0, checking: 0, encrypted: 0, failed: 0, notStarted: 14 },
    files: { done: 0, total: 0 },
    workspaces: [],
    ...over,
  };
}

describe("encryptionCardView", () => {
  test("off: plain files, customers untouched, Start encrypting…", () => {
    const view = encryptionCardView(status(), NOW);
    expect(view.kind).toBe("off");
    expect(view.pill).toEqual({ label: "Off", tone: "neutral" });
    expect(view.summary).toBe(
      "14 managed workspaces store plain files. Customer-owned buckets are never touched.",
    );
    expect(view.action).toBe("start");
    expect(view.table).toBe(false);
  });

  test("no managed workspaces yet", () => {
    const view = encryptionCardView(status({ managedTotal: 0, counts: { ...status().counts, notStarted: 0 } }), NOW);
    expect(view.kind).toBe("empty");
    expect(view.summary).toBe(
      "No managed workspaces yet. New ones will be encrypted from their first file once this is on.",
    );
    expect(view.action).toBe("start");
  });

  test("running: the bar, the figures, Pause, and who started it", () => {
    const view = encryptionCardView(
      status({
        state: "running",
        scope: "all",
        startedBy: "seyi@example.invalid",
        startedAt: AT_0912,
        counts: { waiting: 3, encrypting: 1, checking: 1, encrypted: 9, failed: 0, notStarted: 0 },
        files: { done: 31480, total: 41300 },
      }),
      NOW,
    );
    expect(view.kind).toBe("running");
    expect(view.pill.label).toBe("Running");
    expect(view.bar?.map((part) => [part.label, part.count])).toEqual([
      ["encrypted", 9],
      ["encrypting or checking", 2],
      ["waiting", 3],
      ["need attention", 0],
    ]);
    expect(view.figures).toEqual(["14 managed workspaces", "31,480 of 41,300 files done"]);
    expect(view.byline).toBe("Started by seyi@example.invalid, today 09:12 · Every managed workspace");
    expect(view.action).toBe("pause");
    expect(view.table).toBe(true);
  });

  test("paused: counts, reassurance, and the reason in quotes", () => {
    const view = encryptionCardView(
      status({
        state: "paused",
        changedBy: "seyi@example.invalid",
        pauseReason: "checking read times",
        updatedAt: new Date(2026, 8, 29, 10, 2).getTime(),
        counts: { waiting: 3, encrypting: 2, checking: 0, encrypted: 9, failed: 0, notStarted: 0 },
      }),
      NOW,
    );
    expect(view.pill).toEqual({ label: "Paused", tone: "warn" });
    expect(view.summary).toBe(
      "9 encrypted, 2 stopped partway, 3 waiting. Everything still opens. Saves to encrypted workspaces stay encrypted.",
    );
    expect(view.byline).toBe('Paused by seyi@example.invalid, today 10:02: "checking read times"');
    expect(view.action).toBe("resume");
  });

  test("failed: Failed check, nothing deleted, Retry per workspace, Resume the others", () => {
    const northwind = {
      workspaceId: "w1",
      slug: "northwind",
      state: "failed" as const,
      filesDone: 1240,
      filesTotal: 3112,
      errorCode: "KEY_UNAVAILABLE",
      updatedAt: NOW,
    };
    const view = encryptionCardView(
      status({
        state: "failed",
        counts: { waiting: 3, encrypting: 0, checking: 0, encrypted: 10, failed: 1, notStarted: 0 },
        workspaces: [
          northwind,
          { workspaceId: "w2", slug: "supa", state: "encrypted", filesDone: 9604, filesTotal: 9604, updatedAt: NOW },
        ],
      }),
      NOW,
    );
    expect(view.pill).toEqual({ label: "Failed check", tone: "crit" });
    expect(view.summary).toBe(
      "1 workspace failed its check, so the rollout paused itself. Its files still open. Nothing has been deleted.",
    );
    expect(view.failed).toEqual([northwind]);
    expect(view.action).toBe("resumeOthers");
  });

  test("failed, plural", () => {
    const view = encryptionCardView(
      status({ state: "failed", counts: { ...status().counts, failed: 2 } }),
      NOW,
    );
    expect(view.summary).toBe(
      "2 workspaces failed their check, so the rollout paused itself. Their files still open. Nothing has been deleted.",
    );
  });

  test("complete over every workspace offers to stop taking on new ones", () => {
    const view = encryptionCardView(
      status({
        state: "complete",
        acceptsNew: true,
        updatedAt: new Date(2026, 8, 29, 11, 40).getTime(),
        counts: { waiting: 0, encrypting: 0, checking: 0, encrypted: 14, failed: 0, notStarted: 0 },
      }),
      NOW,
    );
    expect(view.pill).toEqual({ label: "Complete", tone: "ok" });
    expect(view.summary).toBe(
      "All 14 managed workspaces are encrypted and checked. New managed workspaces are encrypted from their first file.",
    );
    expect(view.byline).toBe("Finished today 11:40");
    expect(view.action).toBe("stopNew");
  });

  test("complete over only our own does not claim all, and offers to widen", () => {
    const view = encryptionCardView(
      status({
        state: "complete",
        acceptsNew: false,
        counts: { waiting: 0, encrypting: 0, checking: 0, encrypted: 3, failed: 0, notStarted: 11 },
      }),
      NOW,
    );
    expect(view.summary).toBe("3 of 14 managed workspaces are encrypted and checked.");
    expect(view.action).toBe("start");
  });

  test("off again after some were done: they stay encrypted", () => {
    const view = encryptionCardView(
      status({
        state: "off",
        changedBy: "seyi@example.invalid",
        updatedAt: new Date(2026, 8, 29, 12, 30).getTime(),
        counts: { waiting: 0, encrypting: 0, checking: 0, encrypted: 3, failed: 0, notStarted: 11 },
      }),
      new Date(2026, 8, 29, 13, 0).getTime(),
    );
    expect(view.kind).toBe("offSomeDone");
    expect(view.summary).toBe("3 workspaces stay encrypted. 11 aren't started.");
    expect(view.byline).toBe("Turned off by seyi@example.invalid, today 12:30");
    expect(view.action).toBe("start");
    expect(view.summary).not.toMatch(/plain/);
  });

  test("the system is never named as the person who did it", () => {
    const view = encryptionCardView(
      status({ state: "complete", changedBy: "system", counts: { ...status().counts, encrypted: 14, notStarted: 0 } }),
      NOW,
    );
    expect(view.byline ?? "").not.toMatch(/system/);
  });

  test("no copy uses an em dash", () => {
    const states: RolloutStatus["state"][] = ["off", "running", "paused", "failed", "complete"];
    for (const state of states) {
      const view = encryptionCardView(status({ state, scope: "ours", startedAt: AT_0912, updatedAt: AT_0912 }), NOW);
      expect(`${view.summary ?? ""} ${view.byline ?? ""}`).not.toContain("—");
    }
  });
});

describe("the workspaces table", () => {
  test("state pills", () => {
    expect(workspaceStatePill("encrypted")).toEqual({ label: "Encrypted", tone: "ok" });
    expect(workspaceStatePill("encrypting").label).toBe("Encrypting");
    expect(workspaceStatePill("checking").label).toBe("Checking");
    expect(workspaceStatePill("waiting").label).toBe("Waiting");
    expect(workspaceStatePill("failed")).toEqual({ label: "Failed check", tone: "crit" });
  });

  test("files", () => {
    const base = { workspaceId: "w", slug: "s", updatedAt: 0 };
    expect(workspaceFiles({ ...base, state: "encrypting", filesDone: 1240, filesTotal: 3112 })).toBe("1,240 / 3,112");
    expect(workspaceFiles({ ...base, state: "checking", filesDone: 812, filesTotal: 812 })).toBe("812 / 812");
    expect(workspaceFiles({ ...base, state: "encrypted", filesDone: 9604, filesTotal: 9604 })).toBe("9,604");
    expect(workspaceFiles({ ...base, state: "waiting", filesDone: 0, filesTotal: 2050 })).toBe("— / 2,050");
    expect(workspaceFiles({ ...base, state: "waiting", filesDone: 0 })).toBe("— / —");
  });

  test("a failure is told in words, and an unknown code is shown as it is", () => {
    expect(failureLine("KEY_UNAVAILABLE")).toBe("Its key couldn't be opened");
    expect(failureLine("WALK_FAILED")).toBe("Stopped on an error");
    expect(failureLine("STALLED")).toBe("Kept stopping partway. Retry picks up where it left off");
    expect(failureLine("SOMETHING_NEW")).toBe("Stopped on SOMETHING_NEW");
  });
});

describe("starting", () => {
  const candidates = [
    { workspaceId: "a", slug: "context-lc", ours: true },
    { workspaceId: "b", slug: "jon", ours: false },
    { workspaceId: "c", slug: "seyi", ours: true },
    { workspaceId: "d", slug: "supa", ours: true },
  ];

  test("the three scopes, with the counts they name", () => {
    expect(scopeOptions(candidates)).toEqual([
      { value: "ours", label: "Our own workspaces first", detail: "@context-lc, @seyi, @supa · 3 workspaces" },
      { value: "picked", label: "Workspaces I pick", detail: "Choose from the 4 managed workspaces" },
      { value: "all", label: "Every managed workspace", detail: "4 now, plus every new one" },
    ]);
  });

  test("the button says how many", () => {
    expect(startCount("ours", candidates, new Set())).toBe(3);
    expect(startCount("picked", candidates, new Set(["b"]))).toBe(1);
    expect(startCount("all", candidates, new Set())).toBe(4);
    expect(startLabel("ours", 3)).toBe("Start with 3");
    expect(startLabel("all", 0)).toBe("Start");
  });

  test("picking nobody cannot start; every workspace can, even with none yet", () => {
    expect(canStart("picked", 0)).toBe(false);
    expect(canStart("ours", 0)).toBe(false);
    expect(canStart("all", 0)).toBe(true);
  });

  test("clock labels", () => {
    expect(clockLabel(AT_0912, NOW)).toBe("today 09:12");
    expect(clockLabel(new Date(2026, 8, 4, 7, 5).getTime(), NOW)).toBe("4 Sep 07:05");
  });
});
