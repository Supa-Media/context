import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import {
  STEP_LABELS,
  afterAgents,
  afterBootstrap,
  afterStorage,
  afterStructure,
  stepProgress,
  stepTitle,
  stepsFor,
  storageWarning,
  type StepKey,
} from "../features/onboarding/flow";
import {
  describeCreateFailure,
  describeStructureFailure,
} from "../features/onboarding/errors";

describe("the shape of the run", () => {
  test("connecting storage offers a vault import before layout, tools, and bootstrap", () => {
    expect(stepsFor({ storage: "connected" })).toEqual([
      "name",
      "storage",
      "vault",
      "structure",
      "agents",
      "bootstrap",
      "done",
    ]);
  });

  test("skipping storage drops the layout step, because there is nowhere to put it", () => {
    expect(stepsFor({ storage: "skipped" })).toEqual(["name", "storage", "done"]);
  });

  test("and drops the tools and bootstrap steps with it, because the prompts would fail on contact", () => {
    // The tools step hands over an instruction telling an AI client to write
    // notes; the bootstrap step hands over a second one asking the same
    // client to seed the context. Giving either to somebody whose bucket we
    // could not reach moves the failure into their client, where we cannot
    // explain it — the same dishonesty as a capture address that was
    // copyable before anything could receive mail. So both drop together.
    for (const storage of ["skipped", "unverified"] as const) {
      const run = stepsFor({ storage });
      expect(run).not.toContain("agents");
      expect(run).not.toContain("bootstrap");
    }
  });

  test("the layout step always hands off to the tools step", () => {
    // They share a precondition — a connected bucket — so the pairing holds by
    // construction rather than by coincidence, and this asserts it.
    expect(afterStructure()).toBe("agents");
    const run = stepsFor({ storage: "connected" });
    expect(run[run.indexOf("structure") + 1]).toBe("agents");
  });

  test("the tools step always hands off to the bootstrap step", () => {
    // Same shape as the layout → tools pairing above and for the same
    // reason: bootstrap only exists on a run whose bucket is connected —
    // which is what the tools step needed too — and asserting the pairing
    // in one place keeps the two branches from drifting.
    expect(afterAgents()).toBe("bootstrap");
    const run = stepsFor({ storage: "connected" });
    expect(run[run.indexOf("agents") + 1]).toBe("bootstrap");
  });

  test("the bootstrap step hands off to the last screen", () => {
    // Continuing is skipping; the prompt lands in the client the person
    // pasted it into, not here, so there is nothing to commit before Done.
    expect(afterBootstrap()).toBe("done");
    const run = stepsFor({ storage: "connected" });
    expect(run[run.indexOf("bootstrap") + 1]).toBe("done");
  });

  test("the storage step hands off differently depending on what happened", () => {
    expect(afterStorage("connected")).toBe("vault");
    expect(afterStorage("skipped")).toBe("done");
  });

  test("carrying on past a probe we never got an answer from drops the layout step", () => {
    // The layout step opens with "Your bucket is empty, so here is a starting
    // shape". Nobody has looked in this bucket. It might be a live vault.
    expect(stepsFor({ storage: "unverified" })).toEqual(["name", "storage", "done"]);
    expect(afterStorage("unverified")).toBe("done");
  });
});

describe("what the last screen says about the bucket", () => {
  test("a verified bucket gets no warning", () => {
    expect(storageWarning({ storage: "connected" })).toBeNull();
  });

  test("skipping is warned about, because there is nowhere to keep notes", () => {
    const warning = storageWarning({ storage: "skipped" });
    expect(warning).toMatch(/no bucket is connected/i);
  });

  test("a bucket we could not check is warned about too, and does not claim we looked", () => {
    // The regression this exists for: "Carry on anyway" was recorded as
    // "connected", so the one person who most needed this warning was the one
    // person who never saw it.
    const warning = storageWarning({ storage: "unverified" });
    expect(warning).not.toBeNull();
    expect(warning).toMatch(/could not confirm/i);
    expect(warning).toMatch(/never looked inside it/i);
    expect(warning).toMatch(/nothing has been written to it/i);
  });

  test("every step has a label and a title", () => {
    const keys: StepKey[] = [
      "name",
      "storage",
      "vault",
      "structure",
      "agents",
      "bootstrap",
      "done",
    ];
    for (const key of keys) {
      expect(STEP_LABELS[key].length).toBeGreaterThan(0);
      expect(stepTitle(key).length).toBeGreaterThan(0);
    }
  });
});

describe("the progress indicator", () => {
  test("counts the run you are actually in", () => {
    expect(stepProgress("name", { storage: "connected" })).toEqual({ index: 1, total: 7 });
    expect(stepProgress("done", { storage: "connected" })).toEqual({ index: 7, total: 7 });
  });

  test("a completed vault import replaces the layout question", () => {
    expect(stepsFor({ storage: "connected", vault: "imported" })).toEqual([
      "name",
      "storage",
      "vault",
      "agents",
      "bootstrap",
      "done",
    ]);
  });

  test("shrinks when the layout step is not going to happen", () => {
    // Better than showing "3 of 4" for a step that is the last one.
    expect(stepProgress("done", { storage: "skipped" })).toEqual({ index: 3, total: 3 });
  });

  test("a step this run does not contain has no number", () => {
    expect(stepProgress("structure", { storage: "skipped" })).toBeNull();
    expect(stepProgress("agents", { storage: "skipped" })).toBeNull();
    // Same rule for the second half of "point your AI at it": if the tools
    // step never happens, neither does the bootstrap step that lives on it.
    expect(stepProgress("bootstrap", { storage: "skipped" })).toBeNull();
    expect(stepProgress("bootstrap", { storage: "unverified" })).toBeNull();
  });
});

describe("a claim that fails", () => {
  test("a name lost in the race sends you back to the field", () => {
    // `createWorkspace` re-checks inside its transaction, so this is real and
    // narrow: the name went between the check and the claim.
    const failure = describeCreateFailure(
      new ConvexError({ code: "NAME_UNAVAILABLE", reason: "taken", message: "taken" }),
    );
    expect(failure.nameRejection).toBe("taken");
    expect(failure.headline).toMatch(/just went/i);
  });

  test("a name unavailable for some other reason keeps that reason", () => {
    const failure = describeCreateFailure(
      new ConvexError({ code: "NAME_UNAVAILABLE", reason: "reserved", message: "reserved" }),
    );
    expect(failure.nameRejection).toBe("reserved");
  });

  test("a reserved name is not described as a race it never lost", () => {
    // `createWorkspace` throws NAME_UNAVAILABLE for every refusal — reserved,
    // too long, bad characters. Branching on the code alone told somebody
    // typing @postmaster that it had gone while they were typing.
    const failure = describeCreateFailure(
      new ConvexError({ code: "NAME_UNAVAILABLE", reason: "reserved", message: "reserved" }),
    );
    expect(failure.headline).toMatch(/reserved/i);
    expect(failure.headline).not.toMatch(/just went/i);
    expect(failure.next).not.toMatch(/while you were typing/i);
  });

  test("a malformed name is told what is wrong with it", () => {
    const failure = describeCreateFailure(
      new ConvexError({ code: "NAME_UNAVAILABLE", reason: "too_long", message: "too long" }),
    );
    expect(failure.nameRejection).toBe("too_long");
    expect(failure.next).toMatch(/at most/i);
    expect(failure.headline).not.toMatch(/just went/i);
  });

  test("an unavailable name with no reason at all still returns to the field", () => {
    const failure = describeCreateFailure(
      new ConvexError({ code: "NAME_UNAVAILABLE", message: "no" }),
    );
    expect(failure.nameRejection).toBe("taken");
  });

  test("the account cap explains itself and does not read as a bug", () => {
    const failure = describeCreateFailure(
      new ConvexError({ code: "WORKSPACE_LIMIT_REACHED", message: "too many", limit: 10 }),
    );
    expect(failure.headline).toMatch(/as many workspaces/i);
    expect(failure.nameRejection).toBeUndefined();
  });

  test("a rate limit says to come back, not that something broke", () => {
    const failure = describeCreateFailure(new ConvexError({ code: "RATE_LIMITED", message: "" }));
    expect(failure.next).toMatch(/try again/i);
  });

  test("an unrecognised failure shows what the server said rather than inventing advice", () => {
    const failure = describeCreateFailure(
      new ConvexError({ code: "SOMETHING_NEW", message: "The database is on fire." }),
    );
    expect(failure.next).toBe("The database is on fire.");
  });

  test("a plain thrown Error still produces something sayable", () => {
    const failure = describeCreateFailure(new Error("network down"));
    expect(failure.headline.length).toBeGreaterThan(0);
    expect(failure.next).toBe("network down");
  });

  test("something thrown that is not an error at all does not crash the screen", () => {
    const failure = describeCreateFailure("nope");
    expect(failure.headline.length).toBeGreaterThan(0);
    expect(failure.next).toMatch(/nothing was created/i);
  });
});

describe("a layout that fails to land", () => {
  test("reads as a minor setback, because it is one", () => {
    // The name is claimed and the bucket is connected. Folders are one click in
    // the console. This must not look like a failed signup.
    const failure = describeStructureFailure(new Error("bucket said no"));
    expect(failure.next).toMatch(/workspace and your bucket are fine/i);
    expect(failure.next).toMatch(/bucket said no/);
  });
});
