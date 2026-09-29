import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { splitWebsiteCast } from "@context/shared";
import { createSharedDoc, seedSharedDoc } from "../features/console/presence/sharedDoc";
import type { PresenceMember } from "../features/console/presence/protocol";
import { LIVELY, openTask, playCast, type CastMoment } from "../features/home/cast/castRun";
import { describeStep } from "../features/studio/studioScript";

/*
  The steps a film needs beyond the homepage's (Dev2, 2026-09-29, cast promo
  videos): somebody coming in and going, clicking a face, ticking a task.
*/

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

const PAGE = "# Launch\n\n- [ ] write the post\n- [x] send the invoice\n- [ ] send the invoice again\n\n```cast\nCAST\n```\n";

describe("the grammar", () => {
  test("joins, leaves, clicks and ticks parse, and say what they do", () => {
    const { steps, problems } = splitWebsiteCast(
      PAGE.replace("CAST", "@ana joins\nClaude comes in\n@ana clicks @jon's Claude\n@ana clicks on Claude\n@ana ticks: send the invoice\n@ana leaves"),
    );
    expect(problems).toEqual([]);
    expect(steps).toEqual([
      { kind: "join", actor: { name: "@ana", kind: "person" } },
      { kind: "join", actor: { name: "Claude", kind: "agent" } },
      { kind: "click", actor: { name: "@ana", kind: "person" }, target: "@jon's Claude" },
      { kind: "click", actor: { name: "@ana", kind: "person" }, target: "Claude" },
      { kind: "tick", actor: { name: "@ana", kind: "person" }, quote: "send the invoice" },
      { kind: "leave", actor: { name: "@ana", kind: "person" } },
    ]);
    expect(steps.map(describeStep)).toEqual([
      "comes in",
      "comes in",
      "clicks @jon's Claude",
      "clicks Claude",
      "ticks “send the invoice”",
      "leaves",
    ]);
  });

  test("a tick finds the first open task with the words, never a done one or another line", () => {
    expect(PAGE.slice(openTask(PAGE, "send the invoice")! - 3, openTask(PAGE, "send the invoice")! + 2)).toBe("- [ ]");
    expect(PAGE.slice(openTask(PAGE, "SEND THE INVOICE")!).startsWith(" ] send the invoice again")).toBe(true);
    expect(openTask(PAGE, "Launch")).toBeNull();
    expect(openTask(PAGE, "nothing like this")).toBeNull();
    expect(openTask("1. [ ] numbered", "numbered")).toBe(4);
  });
});

describe("playing them", () => {
  function stage(script: string) {
    const { markdown, steps } = splitWebsiteCast(PAGE.replace("CAST", script));
    const shared = createSharedDoc({});
    seedSharedDoc(shared, markdown);
    const rooms: PresenceMember[][] = [];
    const clicked: string[] = [];
    const cues: CastMoment[] = [];
    playCast(steps, shared, {
      schedule: (ms, run) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      },
      instant: () => false,
      pageNamed: () => null,
      addNote: (name) => `${name}.md`,
      agentDid: () => {},
      room: (members) => rooms.push(members),
      clicked: (name) => clicked.push(name),
      cue: (moment) => cues.push(moment),
    });
    const names = () => (rooms[rooms.length - 1] ?? []).map((member) => member.name);
    return { shared, names, clicked, cues, text: () => shared.text.toString() };
  }

  test("a join brings a face in, a leave takes it away, and nothing is written", () => {
    const show = stage("@ana joins\nClaude joins\n@ana leaves");
    const before = show.text();
    jest.advanceTimersByTime(LIVELY.startMs);
    expect(show.names()).toEqual(["@ana"]);
    jest.advanceTimersByTime(LIVELY.gapMs);
    expect(show.names()).toEqual(["@ana", "Claude"]);
    jest.advanceTimersByTime(LIVELY.gapMs);
    expect(show.names()).toEqual(["Claude"]);
    expect(show.text()).toBe(before);
    expect(show.cues).toEqual(["join", "agent"]);
  });

  test("a click opens the list on the face clicked, and makes its sound", () => {
    const show = stage("@ana clicks @jon");
    jest.advanceTimersByTime(LIVELY.startMs);
    expect(show.clicked).toEqual(["@jon"]);
    expect(show.cues).toEqual(["join", "click"]);
  });

  test("a tick checks the task off in the note, and only that one", () => {
    const show = stage("@ana ticks: send the invoice\n@ana ticks: not a task here");
    jest.advanceTimersByTime(LIVELY.startMs);
    expect(show.text()).toContain("- [ ] write the post\n- [x] send the invoice\n- [x] send the invoice again\n");
    jest.advanceTimersByTime(LIVELY.gapMs * 2);
    expect(show.cues).toEqual(["join", "click"]);
  });
});
