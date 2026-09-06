import { describe, expect, test } from "@jest/globals";

import {
  INBOX_FOLDER,
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
 *  1. Default to the current page instead of the personal inbox — return the
 *     page's index from `selectedIndex` when nothing is remembered.
 *     → `the default is the viewer's own inbox, even inside a shared workspace`
 *     and `the default is the viewer's own inbox, even standing in a colleague's
 *     brain` both fail.
 *  2. Report a shared page as `Only you` — drop the `own` comparison and key
 *     the audience off `kind === "personal"` alone.
 *     → `a shared page names who will see it, in a warning tone` fails.
 *  3. Take a note's own path as the folder — drop the `parentPath` call.
 *     → `a note resolves to the folder it sits in, so the meeting lands beside
 *     it` fails.
 *  4. Offer the page when there is none — synthesise a page offer from the
 *     first context when `page` is null.
 *     → `with no page open there is one offer, and it is the inbox` fails.
 *  5. Treat any personal context as the viewer's brain — drop the `role`
 *     half of `ownPersonalContext`'s rule by resolving against the first
 *     `kind === "personal"` entry.
 *     → `somebody who owns no brain is offered the claim, not a recording`
 *     fails.
 *  6. Hide a read-only page instead of refusing it — drop the offer when
 *     `canEdit` is false.
 *     → `a read-only page is offered and refused, never hidden` fails.
 *  7. Let a remembered choice select a refused row — drop the `refusal === null`
 *     half of the match.
 *     → `a remembered choice that has gone read-only falls back to the inbox`
 *     fails.
 *  8. Trust the stored record — return the parsed JSON from `recallDestination`
 *     without re-validating the slug and the folder.
 *     → `a remembered destination is re-validated on the way out of the device`
 *     fails.
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

  test("a context root resolves to the root, and says so in words", () => {
    const choice = offers(
      resolveDestinations({
        contexts: [OWN, SHARED],
        page: { contextSlug: "field-notes", path: "", isNote: false },
      }),
    );
    const page = choice.offers[1]!.destination;
    expect(page.folder).toBe("");
    expect(page).toMatchObject({ label: "the root of your context" });
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
