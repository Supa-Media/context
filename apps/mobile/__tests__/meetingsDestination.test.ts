import { describe, expect, test } from "@jest/globals";
/*
  The gateway's own folder rule, imported by the *suite* and not by the app.
  See `the sheet never offers a folder the gateway would refuse` below for why
  the phone cannot import it and why the test must.
*/
import { normalizeMeetingFolder } from "@context/meetings";

import {
  CONTEXT_ROOT_REFUSAL,
  INBOX_FOLDER,
  UNFILEABLE_FOLDER_REFUSAL,
  chooseOffer,
  describeDestination,
  resolveDestinations,
  sameDestination,
  recallDestination,
  rememberDestination,
  type DestinationContext,
  type MeetingDestination,
} from "../features/meetings/destination";
import { destinationKey, meetingKeys } from "../features/meetings/keys";
import { forgetAllMeetings } from "../features/meetings/local";
import { memoryStore } from "../features/offline/memory";

/**
 * Where a meeting goes, decided before the microphone opens.
 *
 * The rules are `features/meetings/destination.ts`'s and the reason they are a
 * pure module rather than state inside the sheet is `console/capabilities.ts`'s,
 * verbatim: every guard that lived inside a hook survived a full sabotage sweep
 * untouched, and every guard expressed as a module was held. This is the file
 * that holds them.
 *
 * ## Sabotage record
 *
 * Each of these was applied to `destination.ts`, the suite was run, the named
 * test failed, and the change was reverted.
 *
 *  1. `preselect` returns `offers.length - 1` rather than `0` when nothing is
 *     remembered — the current page becomes the default.
 *     → 3 fail, including both halves of the rule: `the default is the viewer's
 *     own inbox, even inside a shared workspace` and `… even standing in a
 *     colleague's brain`.
 *  2. `const yours = context.kind === "personal"` — the audience keyed off the
 *     kind alone rather than off whose context it is.
 *     → `a page in somebody else's brain names an audience too` fails. Worth
 *     noting: the *shared-workspace* test does not catch this one, because a
 *     shared context is not `personal` either way. The case that fails is the
 *     colleague's brain, which is why it has a test of its own.
 *  3. `const folder = page.path` — the `parentPath` call dropped.
 *     → `a note resolves to the folder it sits in, so the meeting lands beside
 *     it` fails.
 *  4. `pageOffer` synthesises a page from the first context when handed `null`.
 *     → `with no page open there is one offer, and it is the inbox` and `a
 *     remembered choice for somewhere else is not offered on its own` fail.
 *  5. `input.contexts.find((c) => c.kind === "personal")` in place of
 *     `ownPersonalContext` — the `role` half of ownership dropped.
 *     → `somebody who owns no brain is offered the claim, not a recording`
 *     fails.
 *  6. `pageOffer` returns `null` when `canEdit` is false — the read-only page
 *     hidden rather than refused.
 *     → 3 fail, led by `a read-only page is offered and refused, never hidden`.
 *  7. The `offer.refusal === null` half of `preselect`'s match dropped.
 *     → `a remembered choice that has gone read-only falls back to the inbox`
 *     fails.
 *  8. `recallDestination` returns the parsed JSON without re-validating.
 *     → `a remembered destination is re-validated on the way out of the device`
 *     fails.
 *  9. `chooseOffer` drops its `refusal !== null` guard.
 *     → `pressing a refused offer leaves the selection where it was` fails.
 * 10. `refusalFor` drops its `folder === ""` arm — the root offered as a live
 *     destination again, which is what shipped.
 *     → `a context root is offered and refused, because no meeting can be filed
 *     there` and both halves of `the sheet never offers a folder the gateway
 *     would refuse` fail.
 * 11. `fileableFolder` returns `true` unconditionally.
 *     → `an offer with no refusal is a folder `normalizeMeetingFolder`
 *     accepts` fails, naming the folder it offered.
 */

const OWN: DestinationContext = { slug: "testagent1", kind: "personal", role: "owner" };
const SHARED: DestinationContext = { slug: "field-notes", kind: "shared", role: "editor" };
const READ_ONLY: DestinationContext = { slug: "field-notes", kind: "shared", role: "member" };
const SOMEBODY_ELSE: DestinationContext = { slug: "testagent2", kind: "personal", role: "member" };

function offers(choice: ReturnType<typeof resolveDestinations>) {
  if (choice.kind !== "choose") throw new Error(`expected offers, got ${choice.kind}`);
  return choice;
}

/* -------------------------------------------------------------------------- */

describe("the default is the person's own brain, wherever they are standing", () => {
  test("the default is the viewer's own inbox, even inside a shared workspace", () => {
    /*
      The important half of the whole feature. A meeting recorded while reading
      something in a shared workspace must not land in that workspace, visible
      to everyone in it, before the person has read a word of the transcript.
    */
    const choice = offers(
      resolveDestinations({
        contexts: [OWN, SHARED],
        page: { contextSlug: "field-notes", path: "1-projects/portal", isNote: false },
      }),
    );

    expect(choice.selectedIndex).toBe(0);
    const chosen = choice.offers[0]!.destination;
    expect(chosen.kind).toBe("personalInbox");
    expect(chosen.contextSlug).toBe("testagent1");
    expect(chosen.folder).toBe(INBOX_FOLDER);
  });

  test("the default is the viewer's own inbox, even standing in a colleague's brain", () => {
    const choice = offers(
      resolveDestinations({
        contexts: [OWN, SOMEBODY_ELSE],
        page: { contextSlug: "testagent2", path: "2-areas/hiring/notes.md", isNote: true },
      }),
    );

    expect(choice.selectedIndex).toBe(0);
    expect(choice.offers[0]!.destination.contextSlug).toBe("testagent1");
  });

  test("the inbox folder is the one this product already files captures into", () => {
    // Not a second spelling of it: `DEFAULT_TARGET_FOLDER` is where forwarded
    // mail lands, and a meeting is the same kind of unfiled capture.
    expect(INBOX_FOLDER).toBe("0-inbox");
  });

  test("the person's own row says only they can see it", () => {
    const choice = offers(resolveDestinations({ contexts: [OWN, SHARED], page: null }));
    expect(choice.offers[0]!.audience).toBe("Only you");
    expect(choice.offers[0]!.tone).toBe("quiet");
  });
});

describe("the second offer is the page somebody is looking at", () => {
  test("a folder resolves to itself", () => {
    const choice = offers(
      resolveDestinations({
        contexts: [OWN, SHARED],
        page: { contextSlug: "field-notes", path: "1-projects/portal", isNote: false },
      }),
    );
    const page = choice.offers[1]!.destination;
    expect(page.kind).toBe("currentPage");
    expect(page.folder).toBe("1-projects/portal");
    expect(page.contextSlug).toBe("field-notes");
  });

  test("a note resolves to the folder it sits in, so the meeting lands beside it", () => {
    const choice = offers(
      resolveDestinations({
        contexts: [OWN, SHARED],
        page: { contextSlug: "field-notes", path: "1-projects/portal/kickoff.md", isNote: true },
      }),
    );
    expect(choice.offers[1]!.destination.folder).toBe("1-projects/portal");
  });

  /**
   * **The offer the gateway was guaranteed to refuse, and the state a phone
   * arrives in.**
   *
   * `app/(app)/console/_layout.tsx` passes `path: data.files.selectedPath ??
   * ""`, so "nothing selected" — a context opened and not yet navigated —
   * reaches this module as a root. It used to come back as a live, pressable,
   * unrefused second row labelled "the root of your context", and
   * `normalizeMeetingFolder("")` is `null`: press it, record, end the meeting,
   * and the gateway filed the note in `0-inbox` and set `folderRejected`. A
   * control that appears to work and does nothing, on the default path.
   *
   * Nothing caught it because the one double that could have — `fakeGateway` —
   * had been taught to honour `folder: ""`, and no mobile test drove an empty
   * folder through a gateway at all. Both halves are closed: this test, and
   * `an empty folder is refused, the way the real gateway refuses it` in
   * `meetingsDestinationWiring.test.ts`.
   *
   * The row is still **drawn**, with the reason beside it, which is the same
   * rule as the read-only page further down.
   */
  test("a context root is offered and refused, because no meeting can be filed there", () => {
    const choice = offers(
      resolveDestinations({
        contexts: [OWN, SHARED],
        page: { contextSlug: "field-notes", path: "", isNote: false },
      }),
    );
    expect(choice.offers).toHaveLength(2);
    const root = choice.offers[1]!;
    expect(root.destination.folder).toBe("");
    expect(root.destination).toMatchObject({ label: "the root of your context" });
    expect(root.refusal).toBe(CONTEXT_ROOT_REFUSAL);
    // And it is not what Start would start: the inbox keeps the selection.
    expect(choice.selectedIndex).toBe(0);
  });

  test("a shared page names who will see it, in a warning tone", () => {
    const choice = offers(
      resolveDestinations({
        contexts: [OWN, SHARED],
        page: { contextSlug: "field-notes", path: "1-projects/portal", isNote: false },
      }),
    );
    expect(choice.offers[1]!.audience).toBe("Visible to the team");
    expect(choice.offers[1]!.tone).toBe("warn");
  });

  test("a page in somebody else's brain names an audience too", () => {
    /*
      `kind === "personal"` is not "yours" — a personal context shared with you
      keeps its kind, which is the exact confusion `console/identity.ts` exists
      to end. Reporting `Only you` for a colleague's brain would be the worst
      version of this bug: the reassuring sentence, on the one row where it is
      false.
    */
    const choice = offers(
      resolveDestinations({
        contexts: [OWN, SOMEBODY_ELSE],
        page: { contextSlug: "testagent2", path: "2-areas/hiring", isNote: false },
      }),
    );
    expect(choice.offers[1]!.audience).toBe("Visible to the team");
    expect(choice.offers[1]!.tone).toBe("warn");
  });

  test("a page inside the viewer's own brain is not a second audience", () => {
    const choice = offers(
      resolveDestinations({
        contexts: [OWN],
        page: { contextSlug: "testagent1", path: "1-projects/portal", isNote: false },
      }),
    );
    expect(choice.offers[1]!.audience).toBe("Only you");
    expect(choice.offers[1]!.tone).toBe("quiet");
  });

  test("the page that is already the inbox is one row, not the same row twice", () => {
    const choice = offers(
      resolveDestinations({
        contexts: [OWN],
        page: { contextSlug: "testagent1", path: INBOX_FOLDER, isNote: false },
      }),
    );
    expect(choice.offers).toHaveLength(1);
  });

  test("with no page open there is one offer, and it is the inbox", () => {
    // The meetings list, or anywhere outside a context.
    const choice = offers(resolveDestinations({ contexts: [OWN, SHARED], page: null }));
    expect(choice.offers).toHaveLength(1);
    expect(choice.offers[0]!.destination.kind).toBe("personalInbox");
  });

  test("a page in a context this person is not a member of is not offered", () => {
    // The list is the whole of what they can reach. A page naming anything
    // else is a stale URL, not a destination.
    const choice = offers(
      resolveDestinations({
        contexts: [OWN],
        page: { contextSlug: "field-notes", path: "1-projects", isNote: false },
      }),
    );
    expect(choice.offers).toHaveLength(1);
  });

  test("a page whose path could not be a bucket key is not offered", () => {
    for (const path of ["/1-projects", "1-projects/../..", "a\\b"]) {
      const choice = offers(
        resolveDestinations({
          contexts: [OWN, SHARED],
          page: { contextSlug: "field-notes", path, isNote: false },
        }),
      );
      expect(choice.offers).toHaveLength(1);
    }
  });
});

describe("a capability that is absent is reported, never hidden and never faked", () => {
  test("a read-only page is offered and refused, never hidden", () => {
    /*
      CLAUDE.md's rule, and the console's: a disabled action is dimmed with the
      reason beside it. Removing the row would leave somebody looking for a
      choice the product says they have.
    */
    const choice = offers(
      resolveDestinations({
        contexts: [OWN, READ_ONLY],
        page: { contextSlug: "field-notes", path: "1-projects/portal", isNote: false },
      }),
    );
    expect(choice.offers).toHaveLength(2);
    expect(choice.offers[1]!.refusal).toContain("read");
    expect(choice.selectedIndex).toBe(0);
  });

  test("a role this build does not recognise is refused, not trusted", () => {
    const choice = offers(
      resolveDestinations({
        contexts: [OWN, { slug: "field-notes", kind: "shared", role: "auditor" }],
        page: { contextSlug: "field-notes", path: "1-projects", isNote: false },
      }),
    );
    expect(choice.offers[1]!.refusal).not.toBeNull();
  });

  test("somebody who owns no brain is offered the claim, not a recording", () => {
    // `kind === "personal"` is not ownership: a personal context shared with
    // you keeps its kind and is still not you.
    const choice = resolveDestinations({
      contexts: [SOMEBODY_ELSE, SHARED],
      page: { contextSlug: "field-notes", path: "1-projects", isNote: false },
    });
    expect(choice.kind).toBe("claimName");
  });

  test("somebody with no contexts at all is offered the claim", () => {
    expect(resolveDestinations({ contexts: [], page: null }).kind).toBe("claimName");
  });
});

/* -------------------------------------------------------------------------- */

/**
 * **The two layers, held against each other rather than described.**
 *
 * An offer with no `refusal` on it is a promise, and the only thing that can
 * keep it is `normalizeMeetingFolder`. `destination.ts` therefore states that
 * rule a second time — it has to, because the phone does not bundle
 * `@context/meetings` (Metro is configured with `@context/shared` as its only
 * shared package) — and `paths.js` is emphatic that two implementations of
 * "does this string escape its bucket" is how one of them ends up weaker.
 *
 * The suite is not the phone, so it *can* import the real one. Every shape
 * either side cares about goes through both, and the assertion is one-way on
 * purpose: **an unrefused offer must be a folder the gateway accepts.** Being
 * stricter here costs a row and is allowed; being laxer costs a destination and
 * is the defect.
 *
 * SABOTAGE: drop any arm of `fileableFolder`, or the `folder === ""` arm of
 * `refusalFor`. MEASURED: this test fails, naming the folder.
 */
describe("the sheet never offers a folder the gateway would refuse", () => {
  /**
   * Folders that survive `safeNotePath` — which is the only gate a page has to
   * pass to reach `pageOffer` at all — paired with what the gateway does.
   *
   * Anything `safeNotePath` already refuses (`../x`, `a\\b`, a leading slash, a
   * control character) is not on this list: such a page is not offered in the
   * first place, and `a page whose path could not be a bucket key is not
   * offered` above is where that is held.
   */
  const REACHABLE_FOLDERS: readonly string[] = [
    "",
    "1-projects",
    "1-projects/portal",
    "2-areas/team/notes",
    "a..b",
    "1-projects/a..b",
    ".git",
    "1-projects/.obsidian",
    "overview.md",
    "1-projects/overview.MD",
    "scopes.yml",
    // A segment that percent-DECODES to `..`. The gateway added this rule when
    // it found that the storage adapter decodes before it compares, so `%2e%2e`
    // is a `".."` segment there and at no earlier layer. `safeNotePath` does
    // not decode either, so this reaches the sheet as an ordinary folder name.
    "%2e%2e",
    "1-projects/%2E%2E",
    // A space shielded from `normalizeRoot`'s whole-string trim by a separator.
    // `safeNotePath` trims and refuses a LEADING slash; it does nothing about a
    // TRAILING one, and an empty last segment is legal here — so this arrives
    // intact. The gateway refuses it because normalizing its own answer again
    // would give something different.
    "ok/a /",
    // Legal on both sides. Being on this list does NOT hold that — the two
    // tests below only look at folders the gateway refuses — so
    // `STILL_OFFERABLE` under them names these again and asserts it.
    "2-areas/team notes",
    "2-areas/ team",
    "100%",
    // One segment past the gateway's 128-character bound, which nothing on the
    // console's side has an opinion about.
    `${"a".repeat(64)}/${"b".repeat(64)}`,
    // Legal on both sides, and worth being on the list so that a rule which
    // simply refused everything could not pass this test.
    `${"a".repeat(60)}/${"b".repeat(60)}`,
  ];

  test("an offer with no refusal is a folder `normalizeMeetingFolder` accepts", () => {
    for (const folder of REACHABLE_FOLDERS) {
      const choice = offers(
        resolveDestinations({
          contexts: [OWN, SHARED],
          page: { contextSlug: "field-notes", path: folder, isNote: false },
        }),
      );
      const offer = choice.offers[1];
      if (offer === undefined || offer.refusal !== null) continue;
      expect([folder, normalizeMeetingFolder(folder)]).not.toEqual([folder, null]);
    }
  });

  test("and it refuses every one of them that the gateway refuses", () => {
    /*
      The other direction, asserted as a *count* rather than folder by folder:
      the point is that the table above really does contain refusals on both
      sides, so the test above is not passing vacuously on a list the sheet
      happens to offer nothing for.
    */
    const refusedByGateway = REACHABLE_FOLDERS.filter(
      (folder) => normalizeMeetingFolder(folder) === null,
    );
    expect(refusedByGateway.length).toBeGreaterThan(1);

    for (const folder of refusedByGateway) {
      const choice = offers(
        resolveDestinations({
          contexts: [OWN, SHARED],
          page: { contextSlug: "field-notes", path: folder, isNote: false },
        }),
      );
      /*
        NO OFFER IS A REFUSAL, and reading `?.refusal ?? null` said the
        opposite. `resolveDestinations` drops a context entirely when
        `safeNotePath` refuses the page's path, so a folder caught one layer
        earlier arrived here looking unrefused — a false RED, which is the
        less dangerous direction and still sends somebody to change working
        code until the test stops complaining. Found by putting `"/ ok"` in
        the table above: refused by `safeNotePath` for its leading slash, so
        it never reaches the sheet at all, and it is out of a list whose name
        claims its members do.
      */
      const offer = choice.offers[1];
      expect([folder, offer === undefined || offer.refusal !== null]).toEqual([folder, true]);
    }
  });


  /*
    STRICTER ON THE PHONE IS FINE — UP TO A POINT, AND THIS IS THE POINT.

    The two tests above are one-directional by design: they hold that the sheet
    never offers what the gateway refuses, and say nothing about the sheet
    refusing what the gateway accepts. That asymmetry is deliberate — the phone
    may be conservative — but it is not free, and unbounded it hides the exact
    mistake this mirror already made once in reverse: `#247` first shipped a
    per-segment trim rule on the GATEWAY that refused 36 folders a real vault
    could have, and review measured the cost before it landed.

    MEASURED, and the reason this block exists: with only the two tests above,
    replacing the decoded rule with "refuse any segment containing a percent"
    passes 34/34, and replacing the joined trim with a per-segment trim passes
    34/34. Both are wrong and neither reddened anything. With this block, each
    reddens.

    These are folders somebody plausibly has, so refusing one costs a real
    destination on the surface where people actually choose one.
  */
  const STILL_OFFERABLE: readonly string[] = [
    "1-projects/portal",
    "2-areas/team notes",
    "2-areas/ team",
    "100%",
    "a%2e%2eb",
  ];

  test("...and it still offers the folders the gateway accepts", () => {
    for (const folder of STILL_OFFERABLE) {
      expect([folder, normalizeMeetingFolder(folder)]).not.toEqual([folder, null]);
      const choice = offers(
        resolveDestinations({
          contexts: [OWN, SHARED],
          page: { contextSlug: "field-notes", path: folder, isNote: false },
        }),
      );
      /*
        `?? ` CANNOT BE USED HERE, and the first version of this line used it:
        `refusal: null` IS the success value, so `offers[1]?.refusal ?? "no
        offer"` reports "no offer" for a folder that was offered perfectly.
        The assertion could not pass for any input. It failed loudly rather
        than quietly, which is the only reason it was cheap — the same slip in
        a `.not.toEqual` would have passed for every input instead.
      */
      const offer = choice.offers[1];
      expect([folder, offer === undefined ? "no offer at all" : offer.refusal]).toEqual([folder, null]);
    }
  });

  test("the root says why, and the rest say the folder is not one this context files into", () => {
    const refusalFor = (path: string) =>
      offers(
        resolveDestinations({
          contexts: [OWN, SHARED],
          page: { contextSlug: "field-notes", path, isNote: false },
        }),
      ).offers[1]!.refusal;

    expect(refusalFor("")).toBe(CONTEXT_ROOT_REFUSAL);
    expect(refusalFor("a..b")).toBe(UNFILEABLE_FOLDER_REFUSAL);
    expect(refusalFor(".git")).toBe(UNFILEABLE_FOLDER_REFUSAL);
    expect(refusalFor("overview.md")).toBe(UNFILEABLE_FOLDER_REFUSAL);
    // No refusal quotes what it refused: the ack one layer down carries no copy
    // of the folder either, and for the same reason.
    expect(UNFILEABLE_FOLDER_REFUSAL).not.toContain("a..b");
  });
});

describe("the last choice is remembered, and remembering it decides nothing else", () => {
  const page: MeetingDestination = {
    kind: "currentPage",
    contextSlug: "field-notes",
    folder: "1-projects/portal",
    label: "1-projects/portal",
  };

  test("a remembered choice is preselected", () => {
    const choice = offers(
      resolveDestinations({
        contexts: [OWN, SHARED],
        page: { contextSlug: "field-notes", path: "1-projects/portal", isNote: false },
        remembered: page,
      }),
    );
    expect(choice.selectedIndex).toBe(1);
  });

  test("a remembered choice for somewhere else is not offered on its own", () => {
    // Somebody who last recorded into a project and is now on the meetings
    // list gets the inbox, not a row for a page they are not on.
    const choice = offers(
      resolveDestinations({ contexts: [OWN, SHARED], page: null, remembered: page }),
    );
    expect(choice.offers).toHaveLength(1);
    expect(choice.selectedIndex).toBe(0);
  });

  test("a remembered choice that has gone read-only falls back to the inbox", () => {
    const choice = offers(
      resolveDestinations({
        contexts: [OWN, READ_ONLY],
        page: { contextSlug: "field-notes", path: "1-projects/portal", isNote: false },
        remembered: page,
      }),
    );
    expect(choice.selectedIndex).toBe(0);
  });

  test("a destination survives a round trip through the device", async () => {
    const store = memoryStore();
    await rememberDestination(store, page);
    expect(await recallDestination(store)).toEqual(page);
  });

  test("a remembered destination is re-validated on the way out of the device", async () => {
    /*
      `lastPlace.ts`'s rule, for the same reason: it is a file this process
      wrote, but it is a file on a *device* — a restored backup, another app
      with the same store — and the folder in it becomes a key in a request to
      somebody's bucket.
    */
    const store = memoryStore();
    const forged = [
      { kind: "currentPage", contextSlug: "field-notes", folder: "../../etc", label: "x" },
      { kind: "currentPage", contextSlug: "@field-notes", folder: "1-projects", label: "x" },
      { kind: "personalInbox", contextSlug: "a/b", folder: INBOX_FOLDER },
      { kind: "elsewhere", contextSlug: "field-notes", folder: "1-projects" },
      { folder: "1-projects" },
    ];
    for (const value of forged) {
      await rememberDestination(store, value as MeetingDestination);
      expect(await recallDestination(store)).toBeNull();
    }
  });

  test("a device that knows nothing says so rather than guessing", async () => {
    expect(await recallDestination(memoryStore())).toBeNull();
  });

  test("the remembered choice leaves the device with the meetings it names", async () => {
    /*
      A slug and a folder are the names of somebody's context and somebody's
      folder — `lastPlace.ts`'s reason for being cleared on sign-out. It is kept
      under this feature's own namespace so `meetingKeys` already covers it,
      rather than as a second list for sign-out to keep in step with.
    */
    const store = memoryStore();
    await rememberDestination(store, {
      kind: "personalInbox",
      contextSlug: "testagent1",
      folder: INBOX_FOLDER,
    });
    expect(meetingKeys(await store.keys())).toContain(destinationKey());

    await forgetAllMeetings(store);
    expect(await recallDestination(store)).toBeNull();
  });
});

describe("what a press on a row is allowed to do", () => {
  const offers = [
    {
      destination: { kind: "personalInbox" as const, contextSlug: "testagent1", folder: "0-inbox" },
      audience: "Only you",
      tone: "quiet" as const,
      refusal: null,
    },
    {
      destination: {
        kind: "currentPage" as const,
        contextSlug: "field-notes",
        folder: "1-projects",
        label: "1-projects",
      },
      audience: "Visible to the team",
      tone: "warn" as const,
      refusal: "You can read this context but not write to it.",
    },
  ];

  test("pressing an offer selects it", () => {
    expect(chooseOffer([offers[0]!, { ...offers[1]!, refusal: null }], 0, 1)).toBe(1);
  });

  test("pressing a refused offer leaves the selection where it was", () => {
    expect(chooseOffer(offers, 0, 1)).toBe(0);
  });

  test("a row the list does not have leaves the selection where it was", () => {
    // The only caller is a list this module produced, so an index it does not
    // have is a bug in the caller — not a reason to take a screen down while
    // somebody is trying to record.
    expect(chooseOffer(offers, 0, 7)).toBe(0);
    expect(chooseOffer(offers, 0, -1)).toBe(0);
  });
});

describe("how a destination reads", () => {
  test("a destination is drawn as the context and the folder it names", () => {
    expect(
      describeDestination({ kind: "personalInbox", contextSlug: "testagent1", folder: "0-inbox" }),
    ).toBe("@testagent1 / 0-inbox");
  });

  test("the root of a context is named rather than drawn as an empty half", () => {
    expect(
      describeDestination({
        kind: "currentPage",
        contextSlug: "field-notes",
        folder: "",
        label: "the root of your context",
      }),
    ).toBe("@field-notes");
  });

  test("two destinations are the same when they name the same folder in the same context", () => {
    const a: MeetingDestination = {
      kind: "currentPage",
      contextSlug: "field-notes",
      folder: "1-projects",
      label: "1-projects",
    };
    expect(sameDestination(a, { ...a, label: "something else" })).toBe(true);
    expect(sameDestination(a, { ...a, folder: "2-areas" })).toBe(false);
    expect(sameDestination(a, { ...a, contextSlug: "other" })).toBe(false);
  });
});
