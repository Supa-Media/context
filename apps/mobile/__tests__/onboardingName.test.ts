import { describe, expect, test } from "@jest/globals";
import {
  NAME_MAX_LENGTH,
  canClaim,
  nameConsequences,
  nameFeedback,
  nameStatus,
  normalizedName,
  shouldCheckAvailability,
} from "../features/onboarding/name";

/**
 * The name field.
 *
 * Three failures that must not be one failure: a name you typed wrong, a name
 * that belongs to somebody else, and a name nobody will ever be given. The
 * reader's next move differs in each, so the status does too.
 */

const free = { available: true, normalized: "seyi" };

describe("what gets asked of the server", () => {
  test("a well-formed name is worth checking", () => {
    expect(shouldCheckAvailability("seyi")).toBe(true);
  });

  test("a half-typed name is not", () => {
    // `checkNameAvailable` requires auth and cannot be rate limited — it is a
    // query. Not firing it per keystroke is the whole mitigation.
    expect(shouldCheckAvailability("s")).toBe(false);
  });

  test("neither is a name with characters that can never be legal", () => {
    expect(shouldCheckAvailability("Seyi Olujide")).toBe(false);
    expect(shouldCheckAvailability("seyi_olujide")).toBe(false);
  });

  test("nor a reserved one — the local list is the same list", () => {
    expect(shouldCheckAvailability("support")).toBe(false);
  });
});

describe("normalisation", () => {
  test("lowercases and trims, and does not rewrite anything else", () => {
    // A name that is silently rewritten is not the name somebody chose, and
    // here it is an access path.
    expect(normalizedName("  Seyi  ")).toBe("seyi");
    expect(normalizedName("My Notes")).toBe("my notes");
  });
});

describe("status", () => {
  test("an empty field says nothing at all", () => {
    expect(nameStatus("", undefined)).toEqual({ kind: "empty" });
    expect(nameFeedback(nameStatus("", undefined))).toBeNull();
  });

  test("too short is malformed, not taken", () => {
    expect(nameStatus("s", undefined)).toEqual({
      kind: "malformed",
      normalized: "s",
      reason: "too_short",
    });
  });

  test("too long is malformed", () => {
    const long = "a".repeat(NAME_MAX_LENGTH + 1);
    expect(nameStatus(long, undefined)).toMatchObject({
      kind: "malformed",
      reason: "too_long",
    });
  });

  test("bad characters are malformed", () => {
    expect(nameStatus("seyi olujide", undefined)).toMatchObject({
      kind: "malformed",
      reason: "invalid_characters",
    });
  });

  test("a stray hyphen on the end is its own message", () => {
    expect(nameStatus("seyi-", undefined)).toMatchObject({
      kind: "malformed",
      reason: "invalid_start_or_end",
    });
  });

  test("a reserved name is reserved, not malformed", () => {
    // `support` is well-formed. It is refused because it is a mailbox we have
    // to keep, which is a different thing to say than "you typed it wrong".
    expect(nameStatus("support", undefined)).toEqual({
      kind: "reserved",
      normalized: "support",
      reason: "reserved",
    });
  });

  test("the IDNA label form is reserved too", () => {
    expect(nameStatus("xn--80ak6aa92e", undefined)).toMatchObject({
      kind: "reserved",
      reason: "reserved_label_form",
    });
  });

  test("a well-formed name with no answer yet is checking", () => {
    expect(nameStatus("seyi", undefined)).toEqual({ kind: "checking", normalized: "seyi" });
  });

  test("the server saying yes is the only thing that makes a name claimable", () => {
    expect(nameStatus("seyi", free)).toEqual({ kind: "available", normalized: "seyi" });
    expect(canClaim(nameStatus("seyi", free))).toBe(true);
    expect(canClaim(nameStatus("seyi", undefined))).toBe(false);
  });

  test("taken comes back as taken", () => {
    const status = nameStatus("seyi", {
      available: false,
      normalized: "seyi",
      reason: "taken",
    });
    expect(status).toEqual({ kind: "taken", normalized: "seyi" });
    expect(canClaim(status)).toBe(false);
  });

  test("a reason the client does not recognise is treated as taken, not as free", () => {
    // Failing closed. A new rejection code arriving from a newer backend must
    // never render as a green tick.
    const status = nameStatus("seyi", {
      available: false,
      normalized: "seyi",
      reason: "some_future_rule",
    });
    expect(status.kind).toBe("taken");
    expect(canClaim(status)).toBe(false);
  });

  test("the server can still say reserved for a name the local list allows", () => {
    const status = nameStatus("brandnew", {
      available: false,
      normalized: "brandnew",
      reason: "reserved",
    });
    expect(status).toMatchObject({ kind: "reserved" });
  });
});

describe("what the field says", () => {
  test("each failure gets its own sentence", () => {
    const taken = nameFeedback(nameStatus("seyi", { available: false, normalized: "seyi", reason: "taken" }));
    const reserved = nameFeedback(nameStatus("support", undefined));
    const malformed = nameFeedback(nameStatus("seyi olujide", undefined));

    expect(taken?.message).not.toBe(reserved?.message);
    expect(reserved?.message).not.toBe(malformed?.message);
    expect(taken?.tone).toBe("crit");
  });

  test("a free name is confirmed in the affirmative, with the @", () => {
    const feedback = nameFeedback(nameStatus("seyi", free));
    expect(feedback?.tone).toBe("ok");
    expect(feedback?.message).toContain("@seyi");
  });

  test("a taken name suggests what to do instead of just refusing", () => {
    const feedback = nameFeedback(
      nameStatus("seyi", { available: false, normalized: "seyi", reason: "taken" }),
    );
    expect(feedback?.message).toMatch(/try another/i);
  });

  test("checking is neutral, not an error", () => {
    expect(nameFeedback(nameStatus("seyi", undefined))).toEqual({
      tone: "neutral",
      message: "Checking…",
    });
  });
});

describe("what the name becomes", () => {
  test("the context, the path, and the mailbox", () => {
    expect(nameConsequences("seyi")).toEqual({
      context: "@seyi",
      path: "@seyi/1-projects/note.md",
      mailbox: "seyi@context.lc",
    });
  });

  test("an empty field still shows the shape, with a placeholder", () => {
    const shown = nameConsequences("");
    expect(shown.context).toBe("@yourname");
    expect(shown.mailbox).toBe("yourname@context.lc");
  });
});
