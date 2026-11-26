import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./memoryStorage.testing";
import { CHAT_KEY } from "./inbox";
import { readAsides, takeCrossAside } from "./crossChat";
import { readJobUpdate } from "./jobs";
import { roomReadOf } from "./roomRead";
import { reportOf } from "./jobTexts";
import { agentAnswer } from "./clients";

/**
 * The Room check's half in the Worker (`packages/tex/gateway/agent/roomCheck.js`; Dev2, 2026-11-26: what someone in a
 * group can't open never goes to the group unasked). A group job's reads from a workspace someone there can't open ride
 * its answer (`roomRead`) to its update and its report, so the chat's turn checks the report's words; an answer held from
 * the group goes to the asker's own 1:1 as a held aside, its draft whole.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-26):
 *   `readAsides`'s `held` dropped → "a held aside keeps its mark and its whole draft" fails.
 *   `reportOf`'s `roomRead` dropped → "a job's report carries what it read" fails.
 */
describe("a group job's closed reads and a held answer", () => {
  it("reads the slugs strictly", () => {
    expect(roomReadOf(["events-team", "events-team", "Bad Slug", 3])).toEqual(["events-team"]);
    expect(roomReadOf("events-team")).toEqual([]);
  });

  it("the gateway's answer carries them", () => {
    const answer = agentAnswer(200, { answer: "Done.", roomRead: ["events-team"] });
    expect(answer.kind === "answer" && answer.roomRead).toEqual(["events-team"]);
  });

  it("a job's report carries what it read", () => {
    const update = readJobUpdate({ id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", state: "done", texts: ["Marcus owns Field Day"], roomRead: ["events-team"] });
    expect(update?.roomRead).toEqual(["events-team"]);
    const report = reportOf({ id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", title: "Action items", state: "done", startedAt: 1 } as never, update!);
    expect(report?.roomRead).toEqual(["events-team"]);
    expect(reportOf({ id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", title: "Action items", state: "done", startedAt: 1 } as never, { id: "1b4e28ba-2fa1-11d2-883f-0016d3cca427", state: "done", texts: ["x"] })?.roomRead).toBeUndefined();
  });

  it("a held aside keeps its mark and its whole draft", async () => {
    const long = "Marcus owns Field Day. ".repeat(100);
    const [aside] = readAsides([{ what: "{}", texts: [long], held: true }]);
    expect(aside.held).toBe(true);
    expect(aside.texts[0].length).toBeGreaterThan(1_200);
    const [plain] = readAsides([{ what: "a code", texts: [long] }]);
    expect(plain.held).toBeUndefined();
    expect(plain.texts[0].length).toBe(1_200);
    const storage = new MemoryStorage();
    await storage.put(CHAT_KEY, { chatId: "chat-1", at: 1 });
    expect(await takeCrossAside(storage, { id: "x12345678ab", what: "{}", texts: [long], held: true, asker: "+15550100000", from: "a group chat they're in" }, 1)).toBe("queued");
  });
});
