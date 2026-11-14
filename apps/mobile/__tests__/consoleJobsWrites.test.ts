/**
 * The Jobs page's writes to `ai/` (`features/admin/console/pages/jobs/jobWrites.ts`), run over an
 * in-memory note store: Make it live writes the notes in the order that keeps production honest and
 * puts them back when production's write fails; a case's delete and Undo keep edits made since; a new
 * experiment takes the next free number and never overwrites a note. Fixtures are fake.
 */
import { describe, expect, jest, test } from "@jest/globals";
import type { Candidate, JobPage } from "../features/admin/aiModel";
import { makeJobWrites, RUN_TESTS_URL, type NoteIo } from "../features/admin/console/pages/jobs/jobWrites";
import { parseTestList } from "../features/admin/testList";

const LIVE_SETUP = ["---", "job: heartbeat", "status: live", "change: the first", "made_by: seyi", "---", "", "Check in gently."].join("\n");
const CHECKIN_V7 = ["---", "job: heartbeat", "status: live", "made_by: seyi", "---", "", "Check in gently."].join("\n");
const QUIET = ["---", "job: heartbeat", "status: candidate", "change: stay quiet", "made_by: improver", "---", "", "Stay quiet unless asked."].join("\n");

const TESTS = [
  "---",
  "job: heartbeat",
  "---",
  "",
  "# Staying quiet",
  "",
  "## 1. Quiet morning",
  "",
  "- kind: task",
  "- must not: text them",
  "",
  "## 2. Evening check",
  "",
  "- kind: task",
  "- must: ask first",
  "",
].join("\n");

const PATHS = {
  production: "ai/production/heartbeat.md",
  checkin: "ai/setups/heartbeat/checkin-v7.md",
  quiet: "ai/setups/heartbeat/quiet-mornings.md",
  tests: "ai/tests/heartbeat.md",
};

/** An in-memory note store with the io shape `makeJobWrites` takes; records each write call's path in order. */
function fakeIo(files: Record<string, string>, failOn: string[] = []) {
  const store = new Map(Object.entries(files));
  const writes: string[] = [];
  const io: NoteIo = {
    read: jest.fn(async (path: string) => {
      const text = store.get(path);
      if (text === undefined) throw new Error(`no note ${path}`);
      return text;
    }) as NoteIo["read"],
    write: jest.fn(async (path: string, change: (text: string | null) => string | null) => {
      writes.push(path);
      if (failOn.includes(path)) throw new Error(`cannot write ${path}`);
      const next = change(store.get(path) ?? null);
      if (next !== null) store.set(path, next);
    }) as NoteIo["write"],
    open: jest.fn(async (_url: string) => true) as NoteIo["open"],
  };
  return { io, store, writes };
}

const candidate = (name: string, path: string, status: Candidate["status"] = "not run"): Candidate =>
  ({ name, status, row: { path }, score: null, liveScore: null, run: null, rounds: [], passed: null, livePassed: null, gap: null, size: null, baseSize: null }) as unknown as Candidate;

/** A JobPage-like object for heartbeat, built by hand as `adminAiCompareModel.test.ts` does. */
function pageOf(over: Partial<JobPage> = {}): JobPage {
  const page = {} as JobPage;
  page.row = { setup: { path: PATHS.production, name: "heartbeat" }, tests: [{ name: "heartbeat", title: "Check-in", path: PATHS.tests }] } as unknown as JobPage["row"];
  page.live = "checkin-v7";
  page.job = { key: "heartbeat" } as JobPage["job"];
  page.candidates = [candidate("checkin-v7", PATHS.checkin, "live"), candidate("quiet-mornings", PATHS.quiet)];
  page.retired = [];
  page.runs = [];
  return Object.assign(page, over);
}

const TODAY = "2026-11-14";
const today = () => TODAY;

describe("makeLive", () => {
  test("writes the candidate, then the old live, then production; the notes say what changed", async () => {
    const { io, store, writes } = fakeIo({ [PATHS.production]: LIVE_SETUP, [PATHS.checkin]: CHECKIN_V7, [PATHS.quiet]: QUIET });
    const writer = makeJobWrites(io, "seyi", today);
    await writer.makeLive(pageOf(), pageOf().candidates[1]!);

    expect(writes).toEqual([PATHS.quiet, PATHS.checkin, PATHS.production]);
    expect(store.get(PATHS.quiet)).toContain("status: live");
    expect(store.get(PATHS.quiet)).not.toContain("status: candidate");
    expect(store.get(PATHS.checkin)).toContain("status: retired");
    expect(store.get(PATHS.checkin)).not.toContain("status: live");
    expect(store.get(PATHS.production)).toBe(
      [
        "---",
        "job: heartbeat",
        "from: quiet-mornings",
        "live_since: 2026-11-14",
        "promoted_by: seyi",
        "---",
        "",
        "Stay quiet unless asked.",
      ].join("\n"),
    );
    // Production is what the candidate says, with the setup-only keys taken out.
    expect(store.get(PATHS.production)).toContain("from: quiet-mornings");
  });

  test("when production's write fails, the candidate and old live go back to their exact original text, and the error is rethrown", async () => {
    const { io, store } = fakeIo({ [PATHS.production]: LIVE_SETUP, [PATHS.checkin]: CHECKIN_V7, [PATHS.quiet]: QUIET }, [PATHS.production]);
    const writer = makeJobWrites(io, "seyi", today);
    await expect(writer.makeLive(pageOf(), pageOf().candidates[1]!)).rejects.toThrow("cannot write ai/production/heartbeat.md");
    expect(store.get(PATHS.quiet)).toBe(QUIET);
    expect(store.get(PATHS.checkin)).toBe(CHECKIN_V7);
    expect(store.get(PATHS.production)).toBe(LIVE_SETUP);
  });

  test("with no production note it throws 'Nothing is live' and writes nothing", async () => {
    const { io, writes } = fakeIo({ [PATHS.quiet]: QUIET, [PATHS.checkin]: CHECKIN_V7 });
    const writer = makeJobWrites(io, "seyi", today);
    const page = pageOf({ row: { setup: null, tests: [] } as unknown as JobPage["row"] });
    await expect(writer.makeLive(page, page.candidates[1]!)).rejects.toThrow("Nothing is live");
    expect(writes).toEqual([]);
  });
});

describe("delete and Undo", () => {
  test("an edit to another case between the delete and the Undo is kept, and the deleted case comes back", async () => {
    const { io, store } = fakeIo({ [PATHS.tests]: TESTS });
    const writer = makeJobWrites(io, "seyi", today);

    const block = await writer.deleteCase(PATHS.tests, 1);
    expect(block[0]).toBe("## 1. Quiet morning");
    expect(parseTestList(store.get(PATHS.tests)!).cases.map((item) => item.number)).toEqual([2]);

    await writer.saveCase(PATHS.tests, 2, { name: "Evening check, edited", when: "", rules: [{ kind: "must", text: "ask first, always" }] });
    await writer.restoreCase(PATHS.tests, block);

    const list = parseTestList(store.get(PATHS.tests)!);
    expect(list.cases.map((item) => [item.number, item.title])).toEqual([
      [1, "Quiet morning"],
      [2, "Evening check, edited"],
    ]);
    expect(list.cases[0]!.rules.map((line) => line.value)).toEqual(["text them"]);
    expect(list.cases[1]!.rules.map((line) => [line.key, line.value])).toEqual([["must", "ask first, always"]]);
  });
});

describe("newExperiment", () => {
  test("creates ai/setups/heartbeat/experiment-3.md, based on live", async () => {
    const { io, store } = fakeIo({ [PATHS.production]: LIVE_SETUP });
    const writer = makeJobWrites(io, "seyi", today);
    const name = await writer.newExperiment(pageOf());
    expect(name).toBe("experiment-3");
    const made = store.get("ai/setups/heartbeat/experiment-3.md")!;
    expect(made).toContain("based_on: checkin-v7");
    expect(made).toContain("made_by: seyi");
    expect(made).toContain("job: heartbeat");
    expect(made).toContain("Check in gently.");
  });

  test("skips a number a candidate or a retired setup already has", async () => {
    const { io, store } = fakeIo({ [PATHS.production]: LIVE_SETUP });
    const writer = makeJobWrites(io, "seyi", today);
    const page = pageOf({
      candidates: [...pageOf().candidates, candidate("experiment-3", "ai/setups/heartbeat/experiment-3.md")],
      retired: [candidate("experiment-4", "ai/setups/heartbeat/experiment-4.md", "retired")],
    });
    expect(await writer.newExperiment(page)).toBe("experiment-5");
    expect(store.has("ai/setups/heartbeat/experiment-5.md")).toBe(true);
  });

  test("never overwrites an existing note, and says so instead of claiming a copy", async () => {
    const existing = "---\njob: heartbeat\n---\n\nSomebody's work.";
    const { io, store } = fakeIo({ [PATHS.production]: LIVE_SETUP, "ai/setups/heartbeat/experiment-3.md": existing });
    const writer = makeJobWrites(io, "seyi", today);
    await expect(writer.newExperiment(pageOf())).rejects.toThrow("already exists");
    expect(store.get("ai/setups/heartbeat/experiment-3.md")).toBe(existing);
  });
});

describe("runBoth", () => {
  test("returns what io.open returned, for the bench's own URL", async () => {
    const { io } = fakeIo({});
    const writer = makeJobWrites(io, "seyi", today);
    expect(await writer.runBoth()).toBe(true);
    expect(io.open).toHaveBeenCalledWith(RUN_TESTS_URL);

    (io.open as jest.Mock<(url: string) => Promise<boolean>>).mockResolvedValueOnce(false);
    expect(await writer.runBoth()).toBe(false);
  });
});
