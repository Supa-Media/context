/**
 * WHO IS OFFERED A LAYOUT, AND — MOSTLY — WHO IS NOT.
 *
 * The prompt exists because `applyStructure` was reachable only from the two
 * setup flows, and both of them can be left permanently: pressing the
 * managed-storage card goes to Stripe, and Stripe returns to Premium settings
 * rather than into a flow that lives in component state. What that leaves is a
 * verified, empty bucket whose owner is told, on arrival, that `privacy.md`
 * could not be read — and offered nothing that would write one.
 *
 * So this decides when the console speaks up. Nearly every assertion here is a
 * negative, because the failure that matters is not a missing prompt on an
 * empty context: it is a prompt offering to write folders into somebody's live
 * vault. `applyStructure` refuses that on the server (`CONTEXT_NOT_EMPTY`), and
 * a card that has to be refused should never have been drawn.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `undefined` scaffoldReason treated as empty          2
 *   the owner gate dropped                               1
 *   `existing-context` offered a layout                  1
 */

import { describe, expect, test } from "@jest/globals";
import {
  contextSetupFor,
  setupCopy,
  setupPromptVisible,
  type ContextSetup,
} from "../features/console/setup";

const connected = (scaffoldReason?: string) => ({ status: "connected", scaffoldReason });

/** A root listing that has been read and holds nothing. */
const emptyRoot = { entries: [] as unknown[] };

describe("offering to set an empty context up", () => {
  test("a verified empty bucket is the case this exists for", () => {
    expect(
      contextSetupFor({ role: "owner", storage: connected("empty"), root: emptyRoot }),
    ).toEqual({ kind: "empty" });
  });

  test("a bucket with anything in it is never empty, whatever the binding remembers", () => {
    /*
      THE BUG THIS CARD SHIPPED WITH, AND THE REASON THE GATE IS NOT ONE FIELD.

      `scaffoldReason` is written by exactly one thing: `verifyStorageBinding`.
      It is what the verifier saw **when it last looked**, and nothing that
      writes notes updates it — not the gateway, not `write_note`, not email
      ingestion, not the editor in this console. A context created empty,
      verified, and then filled by a connected AI client still has `empty` on
      its binding for ever.

      So the card drew "This context is empty" over a workspace with folders
      and notes in it, offering to scaffold. The listing in front of the person
      is the live fact; the binding is a memory of one. Read both, and the live
      one decides.
    */
    const full = { entries: [{ path: "1-projects" }] };
    expect(contextSetupFor({ role: "owner", storage: connected("empty"), root: full })).toEqual({
      kind: "none",
    });
    expect(
      contextSetupFor({ role: "owner", storage: connected("partial"), root: full }),
    ).toEqual({ kind: "none" });
  });

  test("and nothing is offered until the listing has actually been read", () => {
    // `undefined` is "not loaded yet", which is not "empty" — the same
    // distinction the `scaffoldReason` rule below turns on. A card that
    // appears in the gap before the root listing lands is a card that flashes
    // "this context is empty" at somebody whose context is not.
    expect(
      contextSetupFor({ role: "owner", storage: connected("empty"), root: undefined }),
    ).toEqual({ kind: "none" });
  });

  test("a half-written layout is offered as finishing, not as starting", () => {
    // Issue #22: a scaffold that stopped halfway left real files behind, every
    // detector then said "this bucket holds a context", and the owner was told
    // nothing had been changed while their bucket sat half-written.
    expect(contextSetupFor({ role: "owner", storage: connected("partial"), root: emptyRoot })).toEqual({
      kind: "unfinished",
    });
    expect(contextSetupFor({ role: "owner", storage: connected("failed"), root: emptyRoot })).toEqual({
      kind: "unfinished",
    });
  });

  test("a half-written CUSTOM layout is left to the flow that named its folders", () => {
    /*
      THE ONE WAY THIS CARD COULD WRITE THE WRONG THING.

      It offers the standard layout and nothing else — one press, five known
      folders. Pressing it against a context that was half-way through writing
      folders somebody *named* would ask `applyStructure` to resume with
      `para`, and the scaffolder would finish a layout that is now neither: the
      custom folders that landed, plus five PARA folders nobody asked for.
      Nothing is overwritten and nothing is lost, which is precisely what makes
      it the kind of wrong write that is never noticed.

      So the offer is for the layout it can actually finish. A custom one keeps
      its own folder names, and they live in the flow that took them.
    */
    expect(
      contextSetupFor({
        role: "owner",
        storage: connected("partial"),
        root: emptyRoot,
        structureTemplate: "custom",
      }),
    ).toEqual({ kind: "none" });
    expect(
      contextSetupFor({
        role: "owner",
        storage: connected("failed"),
        root: emptyRoot,
        structureTemplate: "custom",
      }),
    ).toEqual({ kind: "none" });
  });

  test("an empty bucket is offered the standard layout whatever was recorded", () => {
    // Nothing has been written, so there is no half-finished shape to respect:
    // `structureTemplate` here is what a flow recorded on the way past, and
    // `applyStructure` overwrites that column with what is actually applied.
    expect(
      contextSetupFor({
        role: "owner",
        storage: connected("empty"),
        root: emptyRoot,
        structureTemplate: "custom",
      }),
    ).toEqual({ kind: "empty" });
  });
});

describe("staying quiet", () => {
  test("a bucket that already held a vault is never offered a layout", () => {
    // The most valuable thing this product does for a vault that has been
    // running for years is nothing at all.
    expect(
      contextSetupFor({ role: "owner", storage: connected("existing-context"), root: emptyRoot }),
    ).toEqual({ kind: "none" });
  });

  test("a context already laid out has nothing to offer", () => {
    expect(
      contextSetupFor({ role: "owner", storage: connected("created"), root: emptyRoot }),
    ).toEqual({ kind: "none" });
  });

  test("a bucket nobody has looked inside is not an empty one", () => {
    /*
      THE ASSERTION THAT KEEPS THIS CARD OFF LIVE CONTEXTS.

      `undefined` is "not attempted", or a deployment older than the field —
      never "we looked and it was empty". Onboarding's `structureStepFor` reads
      the same value as "ask", which is right in front of a bucket it has just
      watched connect and wrong in a console that may be showing anything.
    */
    expect(
      contextSetupFor({ role: "owner", storage: connected(undefined), root: emptyRoot }),
    ).toEqual({ kind: "none" });
    expect(
      contextSetupFor({ role: "owner", storage: connected("not-attempted"), root: emptyRoot }),
    ).toEqual({ kind: "none" });
  });

  test("only an owner is asked, because only an owner may answer", () => {
    // `applyStructure` requires `owner`. A card for anybody else is a button
    // that throws.
    for (const role of ["editor", "member", undefined]) {
      expect(contextSetupFor({ role, storage: connected("empty"), root: emptyRoot })).toEqual({
        kind: "none",
      });
    }
  });

  test("storage that is absent, loading, or unreachable belongs to another notice", () => {
    expect(contextSetupFor({ role: "owner", storage: null, root: emptyRoot })).toEqual({
      kind: "none",
    });
    expect(contextSetupFor({ role: "owner", storage: undefined, root: emptyRoot })).toEqual({
      kind: "none",
    });
    expect(
      contextSetupFor({
        role: "owner",
        storage: { status: "error", scaffoldReason: "empty" },
        root: emptyRoot,
      }),
    ).toEqual({ kind: "none" });
    expect(
      contextSetupFor({
        role: "owner",
        storage: { status: "unverified", scaffoldReason: "empty" },
        root: emptyRoot,
      }),
    ).toEqual({ kind: "none" });
  });
});

describe("what the card says", () => {
  test("the two cases do not share a sentence", () => {
    const empty = setupCopy({ kind: "empty" });
    const unfinished = setupCopy({ kind: "unfinished" });
    expect(empty?.title).toMatch(/empty/i);
    expect(unfinished?.title).toMatch(/not finished/i);
    // The half-written case has one job beyond describing itself: saying that
    // finishing cannot duplicate what is already there.
    expect(unfinished?.body).toMatch(/nothing already in your storage/i);
    expect(setupCopy({ kind: "none" })).toBeNull();
  });

  test("visibility follows the decision and nothing else", () => {
    const cases: Array<[ContextSetup, boolean]> = [
      [{ kind: "empty" }, true],
      [{ kind: "unfinished" }, true],
      [{ kind: "none" }, false],
    ];
    for (const [setup, visible] of cases) {
      expect(setupPromptVisible(setup)).toBe(visible);
    }
  });
});
