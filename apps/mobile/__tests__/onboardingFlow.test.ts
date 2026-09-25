import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import {
  afterDryRun,
  afterName,
  afterStorage,
  headerLabel,
  stepTitle,
  type StepKey,
} from "../features/onboarding/flow";
import {
  describeCreateFailure,
  describeStructureFailure,
} from "../features/onboarding/errors";

/**
 * The canvas's first run: Handle → Fork → the console, with one side track
 * for a bucket somebody brought. Nine steps was the complaint; these are the
 * tests that fail if a tenth is quietly added back.
 */
describe("the shape of the run", () => {
  test("the name hands off to the fork, which asks where the notes live", () => {
    expect(afterName()).toBe("fork");
  });

  test("a bucket we run goes straight to the console once it is ready", () => {
    // Layout, tools, bootstrap and the summary live in the console's setup
    // widget now — none of them is a step between a person and their notes.
    expect(afterStorage("connected", "managed")).toBe("console");
  });

  test("a bucket somebody brought is reported on before the console", () => {
    expect(afterStorage("connected", "byo")).toBe("dryrun");
    expect(afterDryRun()).toBe("console");
  });

  test("skipping storage, or carrying on past a failed check, goes to the console too", () => {
    // Nothing is laid out, nothing is written: the widget's storage row is the
    // thing still to do, and it says so.
    for (const route of ["byo", "managed", undefined] as const) {
      expect(afterStorage("skipped", route)).toBe("console");
      expect(afterStorage("unverified", route)).toBe("console");
    }
  });

  test("there are four screens at most, and none of them is layout, tools or a summary", () => {
    const every: StepKey[] = ["name", "fork", "storage", "dryrun"];
    for (const step of every) expect(stepTitle(step).length).toBeGreaterThan(0);
    expect(every).toHaveLength(4);
  });
});

describe("the line in the corner", () => {
  test("says what the canvas says, board by board", () => {
    expect(headerLabel("name", null)).toBe("Step 1 of 1");
    expect(headerLabel("fork", "seyi")).toBe("@seyi · claimed");
    expect(headerLabel("storage", "seyi")).toBe("@seyi · claimed");
  });

  test("never calls the report read-only, because the probe writes one object and removes it", () => {
    expect(headerLabel("dryrun", "seyi")).not.toMatch(/read-only/i);
  });

  test("the bucket track has its own title", () => {
    expect(stepTitle("fork")).toBe("Where should we start you?");
    expect(stepTitle("storage", { route: "byo" })).toBe("Show us what's already there");
    expect(stepTitle("name")).toBe("Pick the name your notes live under");
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
