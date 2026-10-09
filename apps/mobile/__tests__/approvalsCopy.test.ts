import { describe, expect, test } from "@jest/globals";
import {
  argsText,
  askedLine,
  clientLine,
  decisionNotice,
  expiryLine,
  pendingCount,
} from "../features/approvals/copy";

/**
 * WHAT THE APPROVALS SCREEN SAYS ABOUT EACH HELD CALL.
 *
 * The question on each row is "should this go ahead", and the answer depends on
 * three things the row has to say plainly: who asked, when, and how long the
 * answer is still good for. A row that says "2 h ago" for a call that expires in
 * four minutes, or that names a client it does not know, has got the one thing
 * the person is deciding on wrong.
 *
 * `now` is a parameter everywhere, so the wording is a fact about two
 * timestamps rather than about the clock the test happens to run on.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `expiryLine` ignoring `now` and always saying "Expires in 10 min".
 *     → **1 fails**: `an expired call says so`.
 *  2. `clientLine` returning "Claude Desktop" as a fallback for an unnamed client.
 *     → **1 fails**: `an unnamed client is not given a name`.
 *  3. `decisionNotice` calling an approval that did not run "Approved. It ran".
 *     → **1 fails**: `an approval that did not run does not say it did`.
 */

const MINUTE = 60_000;
const NOW = 1_700_000_000_000;

describe("who asked", () => {
  test("a named client is named", () => {
    expect(clientLine("Claude Desktop")).toBe("Asked by Claude Desktop");
  });

  test("an unnamed client is not given a name", () => {
    expect(clientLine(null)).toBe("Asked by an app you connected");
    expect(clientLine(null)).not.toContain("Claude");
  });
});

describe("when it was asked", () => {
  test("a minute or less is just now", () => {
    expect(askedLine(NOW, NOW)).toBe("Asked just now");
    expect(askedLine(NOW - 30_000, NOW)).toBe("Asked just now");
  });

  test("minutes, then hours", () => {
    expect(askedLine(NOW - 5 * MINUTE, NOW)).toBe("Asked 5 min ago");
    expect(askedLine(NOW - 3 * 60 * MINUTE, NOW)).toBe("Asked 3 h ago");
  });

  test("older than a day is a date, not a count of hours", () => {
    const line = askedLine(NOW - 3 * 24 * 60 * MINUTE, NOW);
    expect(line.startsWith("Asked on ")).toBe(true);
    expect(line).not.toContain(" h ago");
  });

  test("a timestamp in the future is not shown as a negative age", () => {
    expect(askedLine(NOW + 5 * MINUTE, NOW)).toBe("Asked just now");
  });
});

describe("how long the answer is good for", () => {
  test("minutes left, rounded up so a live call never reads as expired", () => {
    expect(expiryLine(NOW + 14 * MINUTE, NOW)).toBe("Expires in 14 min");
    expect(expiryLine(NOW + 14 * MINUTE + 1, NOW)).toBe("Expires in 15 min");
    expect(expiryLine(NOW + 20_000, NOW)).toBe("Expires in 1 min");
  });

  test("an expired call says so", () => {
    expect(expiryLine(NOW, NOW)).toBe("Expired");
    expect(expiryLine(NOW - MINUTE, NOW)).toBe("Expired");
  });
});

describe("what the notice says after a decision", () => {
  test("a denial says nothing ran", () => {
    expect(decisionNotice({ status: "denied", summary: "x" })).toEqual({
      tone: "ok",
      text: "Denied. Nothing ran.",
    });
  });

  test("an approval that ran says so", () => {
    expect(
      decisionNotice({ status: "approved", summary: "x", ok: true, result: "Shared." }),
    ).toEqual({ tone: "ok", text: "Approved. It ran as asked." });
  });

  /**
   * "Approved" is what the person pressed. "It ran" is what the gateway said.
   * An approval whose call failed must not be shown as success, and the tool's
   * own words about why are the useful part of the notice.
   */
  test("an approval that did not run does not say it did", () => {
    const notice = decisionNotice({ status: "approved", summary: "x", ok: false, result: "Not found." });
    expect(notice.tone).toBe("warn");
    expect(notice.text).not.toContain("It ran");
    expect(notice.text).toContain("did not run");
    expect(notice.text).toContain("Not found.");
  });

  test("a tool's answer is one line, however long it is", () => {
    const long = `line one\n${"x".repeat(500)}`;
    const notice = decisionNotice({ status: "approved", summary: null, ok: false, result: long });
    expect(notice.text).not.toContain("\n");
    expect(notice.text.length).toBeLessThan(260);
  });
});

describe("what the tab counts", () => {
  test("the count is the number waiting, and nothing when none are", () => {
    expect(pendingCount(0)).toBe("");
    expect(pendingCount(1)).toBe("1");
    expect(pendingCount(12)).toBe("12");
  });
});

describe("what the arguments read as", () => {
  test("the arguments are shown as the JSON that was sent", () => {
    expect(argsText({ path: "1-projects/plan.md" })).toBe('{\n  "path": "1-projects/plan.md"\n}');
  });

  test("an absent argument is shown as null, never as nothing", () => {
    expect(argsText(null)).toBe("null");
    expect(argsText(undefined)).toBe("null");
  });

  test("a value JSON cannot write is shown as a word, not a crash", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(argsText(cyclic)).toBe("(not shown)");
  });
});
