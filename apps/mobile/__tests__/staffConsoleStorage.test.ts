/**
 * The staff console's Storage page (`pages/Storage.web.tsx`): the artifact's `P.storage` drawn from
 * the real storage report and encryption rollout, and each act calling the right mutation.
 */
import { beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { RolloutStatus } from "../features/admin/encryption";
import { storagePage, type StorageData } from "../features/admin/console/pages/Storage.web";
import { S, toastState } from "../features/admin/console/state";

const el = (dataset: Record<string, string>, fields: Record<string, string> = {}) =>
  ({
    dataset,
    closest: () => ({
      querySelector: (sel: string) => (sel in fields ? { value: fields[sel], focus: () => undefined } : null),
    }),
  }) as unknown as HTMLElement;

const report = {
  counts: { object: 1, dual: 1, bucket: 2, total: 4 },
  workspaces: [
    { workspaceId: "w1", slug: "maya", kind: "personal" as const, home: "object" as const, notes: 2318, since: Date.UTC(2026, 10, 2, 12) },
    { workspaceId: "w2", slug: "<script>x</script>", kind: "shared" as const, home: "dual" as const, notes: null, since: null },
    { workspaceId: "w3", slug: "studio-ops", kind: "shared" as const, home: "bucket" as const, notes: 1560, since: null },
    { workspaceId: "w4", slug: "leo", kind: "personal" as const, home: "bucket" as const, notes: 96, since: null },
  ],
};

const rollout = {
  state: "paused",
  managedTotal: 3,
  counts: { waiting: 1, encrypting: 1, checking: 0, encrypted: 1, failed: 1, notStarted: 0 },
  files: { done: 2404, total: 3880 },
  workspaces: [{ workspaceId: "w3", slug: "studio-ops", state: "failed", filesDone: 3, updatedAt: 0, errorCode: "STALLED" }],
  changedBy: "staff",
  updatedAt: 0,
  pauseReason: "checking",
} as unknown as RolloutStatus;

function data(over: Partial<StorageData> = {}): StorageData {
  return {
    report,
    rollout,
    moveHome: jest.fn(async () => ({ queued: true })),
    retry: jest.fn(async () => null),
    pause: jest.fn(async () => null),
    resume: jest.fn(async () => null),
    ...over,
  };
}

const page = storagePage;
const acts = page.acts!;

beforeAll(() => {
  jest.useFakeTimers();
});

beforeEach(() => {
  S.f.ws = "all";
  S.confirm = null;
  toastState.text = "";
});

describe("Storage render", () => {
  it("draws the artifact's three home tiles and the moving table from the real report", () => {
    const html = page.render!(data());
    expect(html).toContain('data-act="wsf" data-v="object" aria-pressed="false"');
    expect(html).toContain('<div class="l">object');
    expect(html).toContain('<div class="v">1</div>');
    expect(html).toContain("Moving to workspace objects");
    expect(html).toContain("1 of 4 done");
    expect(html).toContain("@maya");
    expect(html).toContain("2,318");
    expect(html).toContain("Nov 2");
    expect(html).toContain('data-act="askmove" data-id="w3">Start moving');
    expect(html).toContain('data-act="askmove" data-id="w2">Switch reads');
  });

  it("escapes a workspace slug from the database", () => {
    const html = page.render!(data());
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("@&lt;script&gt;x&lt;/script&gt;");
  });

  it("filters the table by home and offers Show all", () => {
    S.f.ws = "bucket";
    const html = page.render!(data());
    expect(html).toContain("@studio-ops");
    expect(html).toContain("@leo");
    expect(html).not.toContain("@maya");
    expect(html).toContain('data-act="wsf" data-v="all">Show all');
  });

  it("draws the encryption rollout: pill, key, files done, the failed workspace's Retry", () => {
    const html = page.render!(data());
    expect(html).toContain("Backup encryption");
    expect(html).toContain('pill warn">Paused');
    expect(html).toContain("Encrypted 1");
    expect(html).toContain("Needs attention 1");
    expect(html).toContain("2,404 of 3,880");
    expect(html).toContain("@studio-ops: Kept stopping partway. Retry picks up where it left off");
    expect(html).toContain('data-act="retry" data-id="w3">Retry');
    expect(html).toContain('data-act="resume">Resume');
  });

  it("shows Loading in both panels until the queries answer", () => {
    const html = page.render!(data({ report: undefined, rollout: undefined }));
    expect(html.match(/Loading…/g)).toHaveLength(2);
    expect(html).toContain('<div class="v">…</div>');
  });
});

describe("Storage acts", () => {
  it("askmove opens the confirm for that workspace, by its id", () => {
    acts.askmove(el({ id: "w3" }), data());
    expect(S.confirm).toBe("mvw3");
  });

  it("move calls moveWorkspaceHome to the next home and toasts the artifact's words", async () => {
    const d = data();
    await acts.move(el({ id: "w3" }), d);
    expect(d.moveHome).toHaveBeenCalledWith({ workspaceId: "w3", to: "dual" });
    expect(toastState.text).toBe("@studio-ops is copying to its object; reads stay on the bucket");
    expect(S.confirm).toBeNull();
  });

  it("move from dual to object toasts the switched words", async () => {
    const d = data();
    await acts.move(el({ id: "w2" }), d);
    expect(d.moveHome).toHaveBeenCalledWith({ workspaceId: "w2", to: "object" });
    expect(toastState.text).toBe("Switching @<script>x</script>'s reads to its object");
  });

  it("a move in flight shows progress instead of the button, and a refusal says why", () => {
    const at = Date.UTC(2026, 10, 14);
    const busy = {
      ...report,
      workspaces: [
        { ...report.workspaces[2], lastMove: { to: "dual" as const, state: "running" as const, reason: null, at } },
        { ...report.workspaces[1], lastMove: { to: "object" as const, state: "refused" as const, reason: "PARITY_DIFFERS", at } },
        { ...report.workspaces[3], lastMove: { to: "dual" as const, state: "refused" as const, reason: "<b>odd</b>", at } },
      ],
    };
    const html = page.render!(data({ report: busy }));
    expect(html).toContain('<span class="sub">Copying…</span>');
    expect(html).not.toContain('data-act="askmove" data-id="w3"');
    expect(html).toContain("Last try: its object and bucket differ");
    expect(html).toContain("Last try: &lt;b&gt;odd&lt;/b&gt;");
  });

  it("a stopped move says so and offers Try again to its own target; a copy with gaps says so and offers Copy again", () => {
    const at = Date.UTC(2026, 10, 14);
    const stopped = {
      ...report,
      workspaces: [
        { ...report.workspaces[2], lastMove: { to: "dual" as const, state: "stale" as const, reason: null, at } },
        { ...report.workspaces[1], lastMove: { to: "dual" as const, state: "incomplete" as const, reason: null, at } },
      ],
    };
    const html = page.render!(data({ report: stopped }));
    expect(html).toContain("Stopped, try again");
    expect(html).toContain('data-act="again" data-id="w3" data-to="dual">Try again');
    expect(html).not.toContain('data-act="askmove" data-id="w3"');
    expect(html).toContain("Copied with gaps");
    expect(html).toContain('data-act="again" data-id="w2" data-to="dual">Copy again');
    expect(html).not.toContain('data-act="askmove" data-id="w2"');
  });

  it("a failed copy on dual offers Copy again, not a Switch reads the server would refuse", () => {
    const at = Date.UTC(2026, 10, 14);
    const failed = {
      ...report,
      workspaces: [{ ...report.workspaces[1], lastMove: { to: "dual" as const, state: "failed" as const, reason: "FAILED", at } }],
    };
    const html = page.render!(data({ report: failed }));
    expect(html).toContain("Last try: the move failed");
    expect(html).toContain('data-act="again" data-id="w2" data-to="dual">Copy again');
    expect(html).not.toContain('data-act="askmove" data-id="w2"');
  });

  it("a stopped switch offers Try again to the object, not the copy", () => {
    const at = Date.UTC(2026, 10, 14);
    const html = page.render!(
      data({
        report: {
          ...report,
          workspaces: [{ ...report.workspaces[1], lastMove: { to: "object" as const, state: "stale" as const, reason: null, at } }],
        },
      }),
    );
    expect(html).toContain('data-act="again" data-id="w2" data-to="object">Try again');
  });

  it("a refused move under its button shows why, with the button for the next step", () => {
    const at = Date.UTC(2026, 10, 14);
    const html = page.render!(
      data({
        report: {
          ...report,
          workspaces: [{ ...report.workspaces[1], lastMove: { to: "object" as const, state: "refused" as const, reason: "NOT_BACKFILLED", at } }],
        },
      }),
    );
    expect(html).toContain("Last try: not copied yet");
    expect(html).toContain('data-act="askmove" data-id="w2">Switch reads');
    expect(html).not.toContain("Copied with gaps");
  });

  it("again moves the workspace to the target the button names, and toasts it", async () => {
    const d = data();
    await acts.again(el({ id: "w3", to: "dual" }), d);
    expect(d.moveHome).toHaveBeenCalledWith({ workspaceId: "w3", to: "dual" });
    expect(toastState.text).toBe("Copying @studio-ops again");

    await acts.again(el({ id: "w2", to: "object" }), d);
    expect(d.moveHome).toHaveBeenLastCalledWith({ workspaceId: "w2", to: "object" });
    expect(toastState.text).toBe("Switching @<script>x</script>'s reads to its object");
  });

  it("move toasts a thrown error's message, short", async () => {
    const d = data({ moveHome: jest.fn(async () => Promise.reject(Object.assign(new Error("x"), { data: { message: "Nope" } }))) });
    await acts.move(el({ id: "w3" }), d);
    expect(toastState.text).toBe("Nope");
  });

  it("retry calls retryWorkspace with the workspace id and toasts Retrying", async () => {
    const d = data();
    await acts.retry(el({ id: "w3" }), d);
    expect(d.retry).toHaveBeenCalledWith({ workspaceId: "w3" });
    expect(toastState.text).toBe("Retrying @studio-ops");
  });

  it("pause refuses without a reason, and pauses with the reason typed", async () => {
    const d = data();
    await acts.pause(el({}, { "#why": "   " }), d);
    expect(d.pause).not.toHaveBeenCalled();
    expect(toastState.text).toBe("Say why, in one line");

    await acts.pause(el({}, { "#why": " backup lag " }), d);
    expect(d.pause).toHaveBeenCalledWith({ reason: "backup lag" });
    expect(toastState.text).toBe("Encryption paused");
  });

  it("resume calls resumeRollout and toasts Encryption resumed", async () => {
    const d = data();
    await acts.resume(el({}), d);
    expect(d.resume).toHaveBeenCalledWith({});
    expect(toastState.text).toBe("Encryption resumed");
  });

  it("wsf and askpause set the console state the artifact sets", () => {
    acts.askpause(el({}), data());
    expect(S.confirm).toBe("pause");
  });
});
