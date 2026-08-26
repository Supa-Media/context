import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import {
  STEP_LABELS,
  afterStorage,
  stepProgress,
  stepTitle,
  stepsFor,
  type StepKey,
} from "../features/onboarding/flow";
import {
  describeCreateFailure,
  describeStructureFailure,
} from "../features/onboarding/errors";

describe("the shape of the run", () => {
  test("connecting a bucket gets you the layout step", () => {
    expect(stepsFor({ storageSkipped: false })).toEqual([
      "name",
      "storage",
      "structure",
      "done",
    ]);
  });

  test("skipping storage drops the layout step, because there is nowhere to put it", () => {
    expect(stepsFor({ storageSkipped: true })).toEqual(["name", "storage", "done"]);
  });

  test("the storage step hands off differently depending on what happened", () => {
    expect(afterStorage("connected")).toBe("structure");
    expect(afterStorage("skipped")).toBe("done");
  });

  test("every step has a label and a title", () => {
    const keys: StepKey[] = ["name", "storage", "structure", "done"];
    for (const key of keys) {
      expect(STEP_LABELS[key].length).toBeGreaterThan(0);
      expect(stepTitle(key).length).toBeGreaterThan(0);
    }
  });
});

describe("the progress indicator", () => {
  test("counts the run you are actually in", () => {
    expect(stepProgress("name", { storageSkipped: false })).toEqual({ index: 1, total: 4 });
    expect(stepProgress("done", { storageSkipped: false })).toEqual({ index: 4, total: 4 });
  });

  test("shrinks when the layout step is not going to happen", () => {
    // Better than showing "3 of 4" for a step that is the last one.
    expect(stepProgress("done", { storageSkipped: true })).toEqual({ index: 3, total: 3 });
  });

  test("a step this run does not contain has no number", () => {
    expect(stepProgress("structure", { storageSkipped: true })).toBeNull();
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
    expect(failure.headline).toMatch(/as many contexts/i);
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
    expect(failure.next).toMatch(/context and your bucket are fine/i);
    expect(failure.next).toMatch(/bucket said no/);
  });
});
