import { describe, expect, it } from "vitest";
import type { GroupAction } from "./groupRun";
import { GROUP_RUN_LINES, runTheGroup } from "./groupRunTurn";

const PLACE = { line: "+15550000001", groupId: "photon-group:x" };

function line(fail = false) {
  const ran: GroupAction[] = [];
  return {
    ran,
    runGroup: async (_place: unknown, action: GroupAction) => {
      if (fail) throw new Error("refused");
      ran.push(action);
    },
  };
}

describe("runTheGroup", () => {
  it("runs each line's action before the words and keeps each text in its place", async () => {
    const l = line();
    const out = await runTheGroup(["(name the chat) Lisbon trip", "Done!"], { text: "call it Lisbon trip" }, l, PLACE);
    expect(l.ran).toEqual([{ kind: "name", name: "Lisbon trip" }]);
    expect(out).toEqual({ texts: ["", "Done!"], told: null, done: [{ kind: "name", name: "Lisbon trip" }] });
  });

  it("tells the chat when someone was not added, and adds nobody", async () => {
    const l = line();
    const out = await runTheGroup(["(add to the chat) +15550100199\nAdded Mom!"], { text: "add Mom" }, l, PLACE);
    expect(l.ran).toEqual([]);
    expect(out.told).toBe(GROUP_RUN_LINES.addNotTheirs);
  });

  it("says so when the line cannot, or the app refused", async () => {
    expect((await runTheGroup(["(name the chat) A"], { text: "" }, {}, PLACE)).told).toBe(GROUP_RUN_LINES.cannot);
    expect((await runTheGroup(["(name the chat) A"], { text: "" }, line(true), PLACE)).told).toBe(GROUP_RUN_LINES.failed);
  });

  it("leaves a turn with no lines as it was", async () => {
    const l = line();
    expect(await runTheGroup(["hi", "there"], { text: "x" }, l, PLACE)).toEqual({ texts: ["hi", "there"], told: null, done: [] });
  });
});
