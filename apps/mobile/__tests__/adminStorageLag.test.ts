/**
 * The words staff read for storage keeping up with the file tree
 * (`features/admin/storageLag.ts`), and a move behind the five-hour promise
 * asking for a person in the Indexes table (`filesCell`).
 */

import { describe, expect, test } from "@jest/globals";
import { filesCell, type IndexCell, type MoveRow } from "../features/admin/searchIndexes";
import { lagLine, lateWords, spanWords, timeLeftWords } from "../features/admin/storageLag";

const HOUR = 60 * 60_000;
const lag = { oldestMs: null, catchUpMs: 0, remaining: 0, late: 0, targetMs: 5 * HOUR };

describe("storage lag words", () => {
  test("spans read as a person would say them", () => {
    expect(spanWords(30_000)).toBe("1 minute");
    expect(spanWords(40 * 60_000)).toBe("40 minutes");
    expect(spanWords(3 * HOUR + 10 * 60_000)).toBe("3 hours 10 minutes");
    expect(spanWords(HOUR)).toBe("1 hour");
    expect(spanWords(72 * HOUR)).toBe("3 days");
  });

  test("time left only once a pace is measured", () => {
    expect(timeLeftWords(null)).toBe("");
    expect(timeLeftWords(0)).toBe(" · finishing");
    expect(timeLeftWords(25 * 60_000)).toBe(" · about 25 minutes left");
    expect(lateWords(null)).toBeNull();
    expect(lateWords("slow")).toBe("Behind: on pace to miss 5 hours");
  });

  test("the deployment line", () => {
    expect(lagLine(lag)).toEqual({ text: "Every bucket matches its file tree.", tone: "ok" });
    expect(lagLine({ ...lag, oldestMs: 20 * 60_000, catchUpMs: null, remaining: 1200 })).toEqual({
      text: "Storage: 1,200 files still to copy · oldest move 20 minutes old · measuring the pace.",
      tone: "warn",
    });
    expect(lagLine({ ...lag, oldestMs: 5 * HOUR, catchUpMs: HOUR, remaining: 1, late: 1 }).text).toBe(
      "Storage: 1 file still to copy · oldest move 5 hours old · caught up in about 1 hour · 1 move behind the 5 hours promise.",
    );
  });
});

describe("a move behind the promise", () => {
  const ready: IndexCell = { health: "ok", label: "Ready", figure: "40 files", problem: null } as IndexCell;
  const move = (late: MoveRow["late"]) => ({ stuck: late === "stuck", late, lastError: null }) as MoveRow;

  test("asks for a person, as a stuck one does", () => {
    expect(filesCell(ready, [move("old")])).toMatchObject({ health: "stuck", problem: "A folder move is behind: over 4 hours old" });
    expect(filesCell(ready, [move("slow")])).toMatchObject({ health: "stuck", problem: "A folder move is behind: on pace to miss 5 hours" });
    expect(filesCell(ready, [move(null)])).toMatchObject({ health: "working" });
  });
});
