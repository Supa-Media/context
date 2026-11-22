/**
 * @jest-environment jsdom
 */

/**
 * A Lab test chat on a pull request's code (Dev2, 2026-11-22: "run on PR #N's code"): the picker's Code field names a
 * pull request, the open carries it, and the dock knows the test chat runs on that preview and is starting until the
 * preview has opened it. The gateway here is a stand-in; every id is invented.
 *
 * Sabotage record (applied, run, observed failing, reverted, 2026-11-22): openSandbox dropping `code` -> "the open
 * carries the pull request" fails; take() keeping `starting` once an answer has no `preview` -> "starting until the preview answers" fails.
 */
import { expect, test } from "@jest/globals";
import { openSandbox, sandbox, setSandboxCall, setSandboxCode } from "@context/lab/app/engine/sandbox";

test("the Code field takes main or a pull request, and refuses anything else", () => {
  expect(setSandboxCode("#4012")).toBe("#4012");
  expect(setSandboxCode("pr12")).toBe("#12");
  expect(sandbox.code).toBe("#12");
  expect(setSandboxCode("feature/x")).toBeNull();
  expect(sandbox.code).toBe("#12");
  expect(setSandboxCode("")).toBe("main");
});

test("the open carries the pull request; starting until the preview answers", async () => {
  const asked: Array<[string, Record<string, unknown>]> = [];
  let open = false;
  setSandboxCall(async (op, body) => {
    asked.push([op, body]);
    if (op === "open") return { sandboxId: "0123456789abcdef", code: "#12", people: [], rows: [], preview: { pr: 12, starting: true } };
    return open ? { rows: [], code: "#12" } : { rows: [], code: "#12", preview: { pr: 12, starting: true } };
  });
  setSandboxCode("#12");
  await openSandbox({ kind: "maya" }, "main");
  expect(asked[0][0]).toBe("open");
  expect(asked[0][1].code).toBe("#12");
  expect(sandbox.preview).toEqual({ pr: 12, starting: true });
  open = true;
  await new Promise((r) => setTimeout(r, 3000));
  expect(sandbox.preview).toEqual({ pr: 12, starting: false });
  setSandboxCode("main");
  asked.length = 0;
  await openSandbox({ kind: "maya" }, "main");
  expect(asked.find(([op]) => op === "open")?.[1].code).toBeUndefined();
  setSandboxCall(null);
});
