/**
 * The Nightly page's Run now (Dev2, 2026-11-20: "I want to be able to be like, okay, like let's run it now"): it opens
 * a test chat of your own 1:1 with Tex on the version open in the Lab, then asks the gateway's `/tex-lab/sandbox` for
 * op `nightly`, and shows the run's rows. The gateway here is a stand-in. Every value is invented; the repository is public.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-20):
 *  1. `runNightlyNow` opening the chat with source "maya" -> "it opens a test chat of your own 1:1 first" fails;
 *  2. "nightly" left out of the draft ops -> "an unsaved draft runs as drawn" fails.
 */
import { afterEach, describe, expect, test } from "@jest/globals";
import { resetSandboxState, runNightlyNow, sandbox, setSandboxCall } from "../app/engine/sandbox";
import { lab } from "../app/engine/state";

const calls: Array<{ op: string; body: Record<string, unknown> }> = [];
const rows = [
  { id: "n1", who: "Lab", text: "Run the nightly dream now" },
  { id: "n1r", reply: "n1", who: "Tex", text: "About me: 14,100 → 12,000 characters.", steps: [{ node: "dream", out: "outcome: dreamed", ms: 9 }] },
];
function fake() {
  setSandboxCall(async (op, body) => {
    calls.push({ op, body });
    if (op === "open") return { sandboxId: "sb1", rows: [], people: ["You"], chat: { kind: "one" } };
    if (op === "nightly") return { msgId: "n1", ran: ["nightly", "dream"], about: { before: 14100, after: 12000, added: [], removed: [] } };
    if (op === "get") return { sandboxId: "sb1", rows };
    return {};
  });
}
afterEach(() => {
  calls.length = 0;
  setSandboxCall(null);
  resetSandboxState();
});

describe("Run now on the Nightly page", () => {
  test("it opens a test chat of your own 1:1 first, then runs the nightly there and shows its rows", async () => {
    fake();
    await runNightlyNow("main");
    const ops = calls.map((c) => c.op).filter((op) => op !== "get" || calls.some((c) => c.op === "nightly"));
    expect(ops.slice(0, 2)).toEqual(["open", "nightly"]);
    expect(calls[0].body).toMatchObject({ source: "chat", chatId: "me", versionId: "main" });
    expect(calls[1].body).toMatchObject({ sandboxId: "sb1", run: "dream", versionId: "main" });
    expect(sandbox.rows.map((r) => r.id)).toEqual(["n1", "n1r"]);
  });

  test("an open test chat of your own 1:1 on the same version is used as it is; housekeeping is asked by name", async () => {
    fake();
    await runNightlyNow("main");
    calls.length = 0;
    await runNightlyNow("main", "housekeeping");
    expect(calls[0]).toMatchObject({ op: "nightly", body: { run: "housekeeping" } });
    expect(calls.some((c) => c.op === "open")).toBe(false);
  });

  test("an unsaved draft runs as drawn", async () => {
    fake();
    const was = { cur: lab.cur, dirty: lab.dirty };
    lab.cur = { ...lab.cur, id: "draft1" };
    lab.dirty = true;
    try {
      await runNightlyNow("draft1");
    } finally {
      lab.cur = was.cur;
      lab.dirty = was.dirty;
    }
    const nightly = calls.find((c) => c.op === "nightly");
    expect(typeof nightly?.body.graph).toBe("string");
  });
});
