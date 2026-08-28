import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import {
  DEFAULT_TARGET_FOLDER,
  MAX_ALLOWED_DOMAINS,
  MAX_ALLOWED_SENDERS,
  MAX_FOLDER_LENGTH,
  NO_INGESTION_ADDRESS,
  addSender,
  describeDraftProblem,
  describeFolderProblem,
  describeIngestionAbsence,
  describeSenderPolicy,
  diff,
  draftOf,
  emptyDraft,
  ingestionAvailabilityFor,
  isDirty,
  isSenderProblem,
  normaliseFolder,
  parseSenderEntry,
  refusalMessage,
  removeSender,
  senderEntries,
  senderLabel,
  shouldReadIngestionSettings,
  type IngestionDraft,
  type IngestionState,
} from "../features/console/ingestion/settings";

/**
 * The ingestion address is semi-public, so the allow-list is a security
 * control and not a preference. These are the rules that decide whether a
 * stranger who learned the address can write into somebody's context.
 *
 * And one rule above all of those: **only a personal context receives email at
 * all.** A shared context has no capture address — not a disabled one, not one
 * awaiting configuration — so the console must not draw it one. The last four
 * blocks below are that rule, and the thing they mostly pin is that "this
 * context has no address" never gets worded like "ingestion is off here".
 */

const base: IngestionDraft = {
  targetFolder: "0-inbox/",
  allowedSenders: ["seyi@publicworship.life"],
  allowedDomains: [],
  allowAnySender: false,
};

describe("the target folder", () => {
  test("the default is the PARA inbox", () => {
    expect(DEFAULT_TARGET_FOLDER).toBe("0-inbox/");
    expect(emptyDraft().targetFolder).toBe("0-inbox/");
  });

  test("every spelling somebody might type normalises to one key prefix", () => {
    expect(normaliseFolder("0-inbox")).toBe("0-inbox/");
    expect(normaliseFolder("/0-inbox/")).toBe("0-inbox/");
    expect(normaliseFolder("  2-areas/receipts  ")).toBe("2-areas/receipts/");
    expect(normaliseFolder("2-areas//receipts")).toBe("2-areas/receipts/");
  });

  test("mail has to land somewhere", () => {
    expect(describeFolderProblem("")).toMatch(/land somewhere/);
    expect(describeFolderProblem("   ")).toMatch(/land somewhere/);
    expect(describeFolderProblem("/")).toMatch(/land somewhere/);
  });

  test("the dot folders are the bucket's, not yours", () => {
    expect(describeFolderProblem(".history")).toMatch(/reserved/);
    expect(describeFolderProblem("1-projects/.audit")).toMatch(/reserved/);
  });

  test("a path that is not a path is refused", () => {
    expect(describeFolderProblem("1-projects/../../etc")).toMatch(/not a folder path/);
  });

  test("a real folder is accepted, nested or not", () => {
    expect(describeFolderProblem("0-inbox/")).toBeNull();
    expect(describeFolderProblem("2-areas/receipts")).toBeNull();
  });

  test("a segment padded with spaces is a key nobody can type again", () => {
    expect(describeFolderProblem("2-areas/ receipts")).toMatch(/space at the start or end/);
    expect(describeFolderProblem("2-areas/receipts ")).toBeNull(); // trailing, trimmed off
  });

  test("the length limit is the backend's, not a stricter guess", () => {
    // Mirrors MAX_FOLDER_LENGTH in apps/convex/functions/lib/ingestion.ts. A
    // stricter client limit refuses folders the backend would have accepted.
    expect(MAX_FOLDER_LENGTH).toBe(512);
    expect(describeFolderProblem("a".repeat(300))).toBeNull();
    expect(describeFolderProblem("a".repeat(600))).toMatch(/at most 512/);
  });

  test("a draft with a bad folder cannot be saved", () => {
    expect(describeDraftProblem({ ...base, targetFolder: "" })).not.toBeNull();
    expect(describeDraftProblem(base)).toBeNull();
  });
});

describe("reading what somebody typed into the sender box", () => {
  test("a whole address is an address", () => {
    expect(parseSenderEntry("seyi@publicworship.life")).toEqual({
      kind: "email",
      value: "seyi@publicworship.life",
    });
  });

  test("case is not a different sender", () => {
    expect(parseSenderEntry("Seyi@PublicWorship.Life")).toEqual({
      kind: "email",
      value: "seyi@publicworship.life",
    });
  });

  test("all three spellings of a domain mean the domain", () => {
    const expected = { kind: "domain", value: "publicworship.life" };
    expect(parseSenderEntry("publicworship.life")).toEqual(expected);
    expect(parseSenderEntry("@publicworship.life")).toEqual(expected);
    expect(parseSenderEntry("*@publicworship.life")).toEqual(expected);
  });

  test("an empty box is asked about rather than silently ignored", () => {
    const result = parseSenderEntry("   ");
    expect(isSenderProblem(result)).toBe(true);
  });

  test("something that is nearly an address says so", () => {
    const result = parseSenderEntry("seyi@localhost");
    expect(isSenderProblem(result) && result.problem).toMatch(/email address/);
  });

  test("a sentence is not a sender", () => {
    const result = parseSenderEntry("anyone from church");
    expect(isSenderProblem(result) && result.problem).toMatch(/whole address/);
  });
});

describe("building the allow-list", () => {
  test("an address is added and the list stays sorted", () => {
    const result = addSender(base, "lk@publicworship.life");
    expect(isSenderProblem(result)).toBe(false);
    if (isSenderProblem(result)) return;
    expect(result.draft.allowedSenders).toEqual([
      "lk@publicworship.life",
      "seyi@publicworship.life",
    ]);
  });

  test("adding the same thing twice is refused rather than silently ignored", () => {
    const result = addSender(base, "SEYI@publicworship.life");
    expect(isSenderProblem(result) && result.problem).toMatch(/already on the list/);
  });

  test("adding a domain absorbs the addresses it already covers", () => {
    const result = addSender(base, "@publicworship.life");
    expect(isSenderProblem(result)).toBe(false);
    if (isSenderProblem(result)) return;
    // Leaving "seyi@publicworship.life" behind would show a line that has
    // stopped meaning anything.
    expect(result.draft.allowedDomains).toEqual(["publicworship.life"]);
    expect(result.draft.allowedSenders).toEqual([]);
  });

  test("an address whose domain is already allowed is refused, with the reason", () => {
    const withDomain: IngestionDraft = {
      ...base,
      allowedSenders: [],
      allowedDomains: ["publicworship.life"],
    };
    const result = addSender(withDomain, "someone@publicworship.life");
    expect(isSenderProblem(result) && result.problem).toMatch(
      /Everyone at publicworship\.life is already allowed/,
    );
  });

  test("removing takes the right one off", () => {
    const two = addSender(base, "grants@globalecho.org");
    if (isSenderProblem(two)) throw new Error("should have added");
    const after = removeSender(two.draft, {
      kind: "email",
      value: "seyi@publicworship.life",
    });
    expect(after.allowedSenders).toEqual(["grants@globalecho.org"]);
  });

  test("removing is case-insensitive, like adding", () => {
    const after = removeSender(base, { kind: "email", value: "SEYI@PUBLICWORSHIP.LIFE" });
    expect(after.allowedSenders).toEqual([]);
  });

  test("domains are listed before addresses, because they are the broader rule", () => {
    const draft: IngestionDraft = {
      ...base,
      allowedDomains: ["globalecho.org"],
    };
    expect(senderEntries(draft).map((entry) => entry.kind)).toEqual(["domain", "email"]);
    expect(senderLabel({ kind: "domain", value: "globalecho.org" })).toBe(
      "anyone @globalecho.org",
    );
    expect(senderLabel({ kind: "email", value: "a@b.com" })).toBe("a@b.com");
  });
});

describe("the backend's caps, hit before the round trip", () => {
  test("the numbers are the backend's", () => {
    // MAX_ALLOWED_SENDERS / MAX_ALLOWED_DOMAINS in
    // apps/convex/functions/lib/ingestion.ts, which throws on overflow.
    expect(MAX_ALLOWED_SENDERS).toBe(50);
    expect(MAX_ALLOWED_DOMAINS).toBe(20);
  });

  test("a full address list suggests the thing that would actually help", () => {
    const full: IngestionDraft = {
      ...base,
      allowedSenders: Array.from(
        { length: MAX_ALLOWED_SENDERS },
        (_, index) => `person${index}@example.test`,
      ),
    };
    const result = addSender(full, "one-more@example.test");
    expect(isSenderProblem(result) && result.problem).toMatch(/Allow a whole domain instead/);
  });

  test("a full domain list is refused too", () => {
    const full: IngestionDraft = {
      ...base,
      allowedDomains: Array.from(
        { length: MAX_ALLOWED_DOMAINS },
        (_, index) => `domain${index}.test`,
      ),
    };
    const result = addSender(full, "one-more.test");
    expect(isSenderProblem(result) && result.problem).toMatch(/at most 20 domains/);
  });
});

/**
 * These sentences describe the *list*, never the pipeline.
 *
 * They used to say "Mail is accepted from 1 address. Everything else is
 * dropped." — a statement about running software, written while no email
 * receiver existed, so both halves were false. `captureHonesty.test.ts` is the
 * test that bans the whole vocabulary; these assertions pin the replacements,
 * which are true before and after the receiver ships and therefore need no
 * revisiting when it does.
 */
describe("what the rules actually mean, said in one sentence", () => {
  test("an empty list is a closed door, and says so", () => {
    const policy = describeSenderPolicy(emptyDraft());
    expect(policy.tone).toBe("warn");
    expect(policy.text).toMatch(/Nobody is allowed to send yet/);
  });

  test("'anyone' is described as what it is", () => {
    const policy = describeSenderPolicy({ ...base, allowAnySender: true });
    expect(policy.tone).toBe("crit");
    expect(policy.text).toMatch(/Anyone who learns this address/);
  });

  test("'anyone' overrides the list rather than reading as an addition to it", () => {
    const policy = describeSenderPolicy({
      ...base,
      allowedDomains: ["publicworship.life"],
      allowAnySender: true,
    });
    expect(policy.tone).toBe("crit");
  });

  test("a real list counts both kinds, in the singular where it should", () => {
    // The counting is what this test is about, so it pins the prefix rather
    // than the whole sentence. The sentence used to end "Nobody else." — a
    // promise the list cannot keep now that the receiver captures unverified
    // mail instead of refusing it, and `captureHonesty.test.ts` bans those two
    // words outright. See `describeSenderPolicy`.
    expect(describeSenderPolicy(base).text).toMatch(/^Only 1 address may send\. /);
    expect(
      describeSenderPolicy({
        ...base,
        allowedDomains: ["publicworship.life", "globalecho.org"],
      }).text,
    ).toMatch(/^Only 1 address and 2 domains may send\. /);
  });
});

describe("saving only what changed", () => {
  test("an untouched draft is not dirty and produces an empty patch", () => {
    expect(isDirty(base, base)).toBe(false);
    expect(diff(base, base)).toEqual({});
  });

  test("a changed folder is sent normalised, and nothing else is sent", () => {
    const patch = diff({ ...base, targetFolder: "/2-areas/receipts" }, base);
    expect(patch).toEqual({ targetFolder: "2-areas/receipts/" });
  });

  test("re-typing the same folder in another spelling is not a change", () => {
    expect(isDirty({ ...base, targetFolder: "0-inbox" }, base)).toBe(false);
  });

  test("reordering a list is not a change", () => {
    const reordered: IngestionDraft = {
      ...base,
      allowedSenders: ["seyi@publicworship.life"],
    };
    expect(isDirty(reordered, base)).toBe(false);
  });

  test("turning on 'anyone' is its own field", () => {
    expect(diff({ ...base, allowAnySender: true }, base)).toEqual({ allowAnySender: true });
  });

  test("a patch never carries fields the person did not touch", () => {
    // `updateIngestionSettings` takes every field as optional, so sending the
    // whole draft would have two open consoles overwrite each other.
    const patch = diff({ ...base, allowedDomains: ["publicworship.life"] }, base);
    expect(Object.keys(patch)).toEqual(["allowedDomains"]);
  });

  test("draftOf drops the address, which is issued rather than chosen", () => {
    const draft = draftOf({
      address: "seyi@context.lc",
      targetFolder: "0-inbox/",
      allowedSenders: [],
      allowedDomains: [],
      allowAnySender: false,
    });
    expect("address" in draft).toBe(false);
  });

  test("draftOf copies the lists rather than aliasing them", () => {
    const settings = {
      address: "seyi@context.lc",
      targetFolder: "0-inbox/",
      allowedSenders: ["a@b.com"],
      allowedDomains: [],
      allowAnySender: false,
    };
    const draft = draftOf(settings);
    draft.allowedSenders.push("c@d.com");
    expect(settings.allowedSenders).toEqual(["a@b.com"]);
  });
});

// ─── only a personal context receives email ──────────────────────────────────

/** A personal context whose owner is looking at it, with a policy loaded. */
const owned: IngestionState = {
  settings: {
    address: "seyi@context.lc",
    ...base,
  },
  loading: false,
  availability: "available",
  save: async () => {},
};

/** The same context, before its owner has said who may send. */
const off: IngestionState = { ...owned, settings: null };

/** Somebody else's personal context: no query is fired, so nothing is known. */
const notMine: IngestionState = { settings: null, loading: false, availability: "available" };

describe("which contexts have a capture address at all", () => {
  test("a personal context does, a shared one does not", () => {
    expect(ingestionAvailabilityFor("personal")).toBe("available");
    expect(ingestionAvailabilityFor("shared")).toBe("no-address");
  });

  test("a kind nobody has taught this yet is not assumed to receive mail", () => {
    // `resolvePersonalContextForIngestion` accepts `personal` and nothing else,
    // so a kind added later must not default into having an inbox.
    expect(ingestionAvailabilityFor("organisation")).toBe("no-address");
  });

  test("no context selected yet is not the same as a shared one", () => {
    // The console before the workspace list has landed. Reading this as
    // "no address" would announce a rule about a context nobody has picked.
    expect(ingestionAvailabilityFor(undefined)).toBe("available");
  });

  test("a context with no address is handed a state with nothing in it", () => {
    expect(NO_INGESTION_ADDRESS.availability).toBe("no-address");
    expect(NO_INGESTION_ADDRESS.settings).toBeNull();
    // Never spinning: there is no answer on its way.
    expect(NO_INGESTION_ADDRESS.loading).toBe(false);
    // And never a Save button, which is the control that would lie.
    expect(NO_INGESTION_ADDRESS.save).toBeUndefined();
  });
});

describe("who the console asks for a policy", () => {
  test("an owner of a personal context, and that is the whole list", () => {
    expect(
      shouldReadIngestionSettings({
        workspaceId: "w1",
        canEdit: true,
        availability: "available",
      }),
    ).toBe(true);
  });

  test("a shared context is never asked — the only answer it could give is null", () => {
    expect(
      shouldReadIngestionSettings({
        workspaceId: "w1",
        canEdit: true,
        availability: "no-address",
      }),
    ).toBe(false);
  });

  test("a member is not asked either: the read is owner-only, not just the write", () => {
    // `getIngestionSettings` throws INSUFFICIENT_ROLE for anyone but the owner,
    // so firing it for a member trades a screen that explains for one that failed.
    expect(
      shouldReadIngestionSettings({
        workspaceId: "w1",
        canEdit: false,
        availability: "available",
      }),
    ).toBe(false);
  });

  test("no context, no query", () => {
    expect(
      shouldReadIngestionSettings({
        workspaceId: null,
        canEdit: true,
        availability: "available",
      }),
    ).toBe(false);
  });
});

describe("what the card says when it has no allow-list to show", () => {
  test("a shared context is told it does not receive email, not that ingestion is off", () => {
    const shared = describeIngestionAbsence(NO_INGESTION_ADDRESS);
    const closed = describeIngestionAbsence(off);
    expect(shared?.reason).toBe("no-address");
    expect(closed?.reason).toBe("off");

    // The two are different situations and must not read as the same one. "Off"
    // is a setting its owner can change this afternoon; "no address" is not a
    // setting at all, and offering to fix it would be the lie.
    expect(shared!.text).not.toBe(closed!.text);
    expect(shared!.text).toMatch(/[Oo]nly a brain receives email/);
    expect(shared!.text).not.toMatch(/\boff\b/i);
    expect(shared!.text).not.toMatch(/until|set a target folder|who may send/i);
    expect(closed!.text).toMatch(/^Ingestion is off/);
  });

  test("a context with no address says how a note gets there instead", () => {
    const shared = describeIngestionAbsence(NO_INGESTION_ADDRESS);
    expect(shared).not.toBeNull();
    if (shared === null || shared.reason !== "no-address") throw new Error("wrong state");
    expect(shared.title).toMatch(/does not receive email/);
    expect(shared.text).toMatch(/moves it here/);
  });

  test("a shared context is never a loading state", () => {
    // Nothing is on its way, so a spinner would spin forever.
    const shared = describeIngestionAbsence({ ...NO_INGESTION_ADDRESS, loading: true });
    expect(shared?.reason).toBe("no-address");
  });

  test("a member is told the rules are the owner's, not that ingestion is off", () => {
    const absence = describeIngestionAbsence(notMine);
    expect(absence?.reason).toBe("owner-only");
    // Claiming "nothing is accepted" would be a fact this console never asked for.
    expect(absence!.text).not.toMatch(/^Ingestion is off/);
  });

  test("all three absences are worded differently", () => {
    const texts = [NO_INGESTION_ADDRESS, off, notMine].map(
      (state) => describeIngestionAbsence(state)!.text,
    );
    expect(new Set(texts).size).toBe(3);
  });

  test("nothing is said while the answer is still coming, or once it has", () => {
    expect(describeIngestionAbsence({ ...off, loading: true })).toBeNull();
    expect(describeIngestionAbsence(owned)).toBeNull();
  });
});

describe("a refusal, turned into something a person can read", () => {
  test("the control plane's own sentence is shown, including the one about shared contexts", () => {
    // Unreachable from the console — a context with no address is never offered
    // a Save — but a refusal is a refusal, and this one is written to be read.
    const error = new ConvexError({
      code: "INGESTION_NOT_AVAILABLE",
      message:
        "Only a brain receives email. Notes reach a workspace when someone moves them there.",
    });
    expect(refusalMessage(error)).toMatch(/^Only a brain receives email\./);
  });

  test("a payload with no message falls back rather than rendering an object", () => {
    expect(refusalMessage(new ConvexError({ code: "INGESTION_NOT_AVAILABLE" }))).toBe(
      "The control plane refused the change. Try again.",
    );
  });

  test("an unknown failure never puts the runtime's own words on screen", () => {
    expect(refusalMessage(new Error("TypeError: undefined is not a function"))).toBe(
      "The control plane refused the change. Try again.",
    );
    expect(refusalMessage(undefined)).toBe("The control plane refused the change. Try again.");
    expect(refusalMessage({ data: { message: 7 } })).toBe(
      "The control plane refused the change. Try again.",
    );
  });
});
