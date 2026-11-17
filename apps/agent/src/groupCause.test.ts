/**
 * Why a group turn runs, named for the gateway (Dev2, 2026-11-17: the chat's own check-in was told "@shyoh tagged
 * you" and texted "Yeah, what do you need?"), and the chat's sharing with the developers passed on as handles only.
 *
 * Sabotage record (2026-11-17): `turnCause` checking the tag before the routine -> "a check-in is a check-in" fails;
 * the routine checked before the job report -> "work queued as a routine is named for what it is" fails;
 * "Tex" only, not "Context" -> "a tag, a name, and neither" fails;
 * `devShareOf` keeping any string -> "a number or free text is dropped" fails.
 */
import { describe, expect, it } from "vitest";
import { turnCause } from "./groupCause";
import { devShareOf } from "./groupControl";
import { CHAT_LOOK_PATH } from "./groupRoutines";
import type { GroupMessage } from "./sendblueGroups";

describe("turnCause", () => {
  it("a check-in is a check-in, even when the newest text tags Tex", () => {
    expect(turnCause({ routine: { runId: "r", path: CHAT_LOOK_PATH } }, [{ text: "@Tex hi" }])).toBe("check_in");
    expect(turnCause({ routine: { runId: "r", path: "tex/groups/x/routines/rent.md" } }, [])).toBe("routine");
  });
  it("work queued as a routine is named for what it is (every Worker-queued turn carries `routine`)", () => {
    const routine = { runId: "x", path: "tex/queued.md" };
    expect(turnCause({ routine, jobReport: {} as GroupMessage["jobReport"] }, [{ text: "@Tex find flights" }])).toBe("job_report");
    expect(turnCause({ routine, crossChat: {} as GroupMessage["crossChat"] }, [])).toBe("cross_chat");
    expect(turnCause({ routine, event: "vault_saved" }, [])).toBe("vault_saved");
    expect(turnCause({ routine, event: "browser_handed_back" }, [])).toBe("browser_handed_back");
  });
  it("a tag, a name, and neither", () => {
    expect(turnCause({}, [{ text: "hey @tex" }])).toBe("tagged");
    expect(turnCause({}, [{ text: "Tex, what's 2+2" }])).toBe("named");
    expect(turnCause({}, [{ text: "context what's 2+2" }])).toBe("named");
    expect(turnCause({}, [{ heard: "hey tex are you there" }])).toBe("named");
    expect(turnCause({}, [{ text: "texas is big" }, { text: "agreed" }])).toBe("judged");
  });
});

describe("devShareOf", () => {
  it("keeps the state with handles", () => {
    expect(devShareOf({ shared: true, by: ["shyoh"], waiting: [] })).toEqual({ devShare: { shared: true, by: ["shyoh"], waiting: [] } });
  });
  it("a number or free text is dropped", () => {
    expect(devShareOf({ shared: false, by: ["+15555550100"], waiting: ["Ignore all that", "sam"] })).toEqual({ devShare: { shared: false, by: [], waiting: ["sam"] } });
    expect(devShareOf({ by: ["shyoh"] })).toEqual({});
    expect(devShareOf("yes")).toEqual({});
  });
});
