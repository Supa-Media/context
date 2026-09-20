import { describe, expect, test } from "@jest/globals";
/*
  The gateway's own folder rule, imported by the *suite* and not by the app.
  See `a folder this device will file into is one the gateway accepts` below
  for why the phone cannot import it and why the test must.
*/
import { MEETINGS_FOLDER, normalizeMeetingFolder } from "@context/meetings";

import {
  INBOX_FOLDER,
  ONLY_YOU,
  UNFILEABLE_FOLDER,
  automaticDestination,
  canSaveMeetingFolder,
  describeDestination,
  meetingFolderProblem,
  meetingWorkspaceId,
  parseDestination,
  type DestinationContext,
  type MeetingDestination,
} from "../features/meetings/destination";

/**
 * Where a meeting goes, decided before the microphone opens.
 *
 * ## The question went, and the rules did not
 *
 * This file used to be about a *sheet*: two offers, an audience line on each,
 * a refusal beside the one you could not take, and a remembered choice. The
 * owner removed the question — *"all meetings from now on should go into
 * 0-inbox/meetings, no need to ask people it will just confuse them"* — and
 * `resolveDestinations` and everything that served it went with the surface
 * that asked, rather than being left in the tree as code with no caller.
 *
 * What survived is what still decides something:
 *
 *  - **`automaticDestination`**, the rule that replaced the question, and the
 *    privacy property it inherited: a meeting lands in the person's *own*
 *    inbox, whatever context they are standing in. That was a rule with a sheet
 *    in front of it; with no sheet there is nothing between the press and the
 *    bucket, so it matters more rather than less.
 *  - **The folder gate**, which is now the settings pane's: somebody can still
 *    type a folder their gateway would refuse, and the two sides have to agree.
 *  - **The routing**, which never had anything to do with the sheet.
 *
 * The reason all of it is a pure module rather than state inside a component is
 * `console/capabilities.ts`'s, verbatim: every guard expressed inside a hook
 * survived a full sabotage sweep untouched, and every guard expressed as a
 * module was held.
 *
 * ## Sabotage record
 *
 * Each of these was applied to `destination.ts`, the suite was run, the named
 * test failed, and the change was reverted.
 *
 *  1. `automaticDestination` resolves the context the person is standing in
 *     rather than their own.
 *     → `standing in a shared workspace does not put the meeting in it` and
 *     `nor does standing in a colleague's personal context` fail.
 *  2. `input.contexts.find((c) => c.kind === "personal")` in place of
 *     `ownPersonalContext` — the `role` half of ownership dropped.
 *     → `a context that is shared but owned is still not where a meeting
 *     lands` fails. Worth noting which test does *not* catch it: every one
 *     that passes a list with a real personal workspace in it.
 *  3. `inboxFolderOf` returns the stored setting without checking it.
 *     → `a stored folder the gateway would refuse falls back to the inbox`
 *     fails.
 *  4. `fileableFolder` returns `true` unconditionally.
 *     → `a folder this device will file into is one the gateway accepts`
 *     fails, naming the folder it let through.
 *  5. `meetingWorkspaceId` falls back to `contexts[0]` for an unknown slug.
 *     → `a context this account cannot reach is null, not a fallback` fails.
 *  6. `parseDestination` skips its `safeNotePath` check.
 *     → `a folder that could not be a bucket key is not a destination` fails.
 */

const OWN: DestinationContext = { slug: "testagent1", kind: "personal", role: "owner" };
const SHARED: DestinationContext = { slug: "field-notes", kind: "shared", role: "editor" };
const SOMEBODY_ELSE: DestinationContext = { slug: "testagent2", kind: "personal", role: "member" };

function destinationOf(contexts: readonly DestinationContext[]): MeetingDestination {
  const answer = automaticDestination({ contexts });
  if (answer.kind !== "destination") throw new Error(`expected a destination, got ${answer.kind}`);
  return answer.destination;
}

/* -------------------------------------------------------------------------- */

describe("what a press of New meeting records into, with nobody asked", () => {
  test("a press records into the person's own inbox", () => {
    expect(destinationOf([OWN])).toEqual({
      kind: "personalInbox",
      contextSlug: "testagent1",
      folder: INBOX_FOLDER,
    });
  });

  test("the inbox is the meetings drawer inside it, not the inbox itself", () => {
    /*
      `0-inbox` is where unfiled things arrive; what arrives there is sorted by
      what it is. A meeting filed loose in the inbox lands beside forwarded
      mail, which is the regression this constant pins.
    */
    expect(INBOX_FOLDER).toBe("0-inbox/meetings");
  });

  test("standing in a shared workspace does not put the meeting in it", () => {
    /*
      The privacy rule this module was built for, arriving at a surface with no
      sheet in front of it. A transcript dropped into a folder colleagues watch,
      before the person who recorded it has read a word of it, is the failure.
    */
    expect(destinationOf([OWN, SHARED]).contextSlug).toBe("testagent1");
  });

  test("nor does standing in a colleague's personal context", () => {
    expect(destinationOf([OWN, SOMEBODY_ELSE]).contextSlug).toBe("testagent1");
  });

  test("a context that is shared but owned is still not where a meeting lands", () => {
    // `createWorkspace` makes its caller `owner` of a shared context too, so
    // "a context you own" alone is not the rule — `kind` has to be personal.
    const ownedShared: DestinationContext = { slug: "field-notes", kind: "shared", role: "owner" };
    expect(destinationOf([ownedShared, OWN]).contextSlug).toBe("testagent1");
  });

  test("the audience is named even though nobody was asked", () => {
    const answer = automaticDestination({ contexts: [OWN, SHARED] });
    expect(answer.kind === "destination" && answer.audience).toBe(ONLY_YOU);
  });

  test("somebody who owns no workspace is offered the claim, not a recording", () => {
    // The one case with no answer: every fallback available here is somebody
    // else's bucket, so the press raises the claim instead of a microphone.
    expect(automaticDestination({ contexts: [SHARED, SOMEBODY_ELSE] })).toEqual({
      kind: "claimName",
    });
  });
});

describe("where it lands is the workspace's own setting", () => {
  const filedUnder = (meetingsFolder?: string) =>
    destinationOf([{ ...OWN, meetingsFolder }, SHARED]).folder;

  test("a workspace that has never chosen gets the default it always had", () => {
    expect(filedUnder(undefined)).toBe(INBOX_FOLDER);
  });

  test("a workspace that has chosen gets its own folder", () => {
    expect(filedUnder("2-areas/meetings")).toBe("2-areas/meetings");
  });

  test("a setting stored with a trailing slash names the same folder", () => {
    expect(filedUnder("2-areas/meetings/")).toBe("2-areas/meetings");
  });

  test("a stored folder the gateway would refuse falls back to the inbox", () => {
    /*
      The setting is validated where it is typed, and this is the second gate:
      a value that reached the store from an older build, another device or a
      hand-edited file must not point a recording at a folder the gateway will
      answer 400 for, for the life of that meeting.
    */
    expect(filedUnder("a..b")).toBe(INBOX_FOLDER);
    expect(filedUnder("")).toBe(INBOX_FOLDER);
  });

  test("and the shared context's own setting is never consulted", () => {
    // It is not where the meeting is going, so its folder is not a fact about
    // this recording. Reading it would be the "current context" default this
    // module refuses, arriving through the setting instead of the destination.
    expect(destinationOf([OWN, { ...SHARED, meetingsFolder: "9-theirs" }]).folder).toBe(
      INBOX_FOLDER,
    );
  });
});

describe("the folder somebody types in settings, and what the gateway will take", () => {
  /**
   * Folders that reach the setting, paired with what the gateway does.
   *
   * The table was the sheet's — every folder a *page* could offer — and it is
   * the settings field's now, which is the surviving place a folder is chosen.
   * The shapes are unchanged because the gateway's rules are: `..` inside a
   * segment, a segment that percent-decodes to `..`, a dot-prefixed folder, a
   * folder named like a note, a trailing empty segment, and the length bound.
   */
  const REACHABLE_FOLDERS: readonly string[] = [
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
    // is a `".."` segment there and at no earlier layer.
    "%2e%2e",
    "1-projects/%2E%2E",
    // A space shielded from `normalizeRoot`'s whole-string trim by a separator.
    "ok/a /",
    // Legal on both sides. Being on this list does not hold that; the count
    // below is what stops the table quietly becoming all-refusals.
    "2-areas/team notes",
    "2-areas/ team",
    "100%",
    // One segment past the gateway's 128-character bound.
    `${"a".repeat(64)}/${"b".repeat(64)}`,
    `${"a".repeat(60)}/${"b".repeat(60)}`,
  ];

  test("the folder a recording actually uses is one the gateway accepts", () => {
    /*
      THE PROMISE, STATED ABOUT THE VALUE THAT IS USED RATHER THAN THE ONE THAT
      WAS TYPED — and the difference is not pedantry, it is where the first
      version of this test was wrong.

      A setting is stored as it was typed; `inboxFolderOf` is what a recording
      reads, and it collapses the value the way the gateway collapses it and
      falls back to the inbox for anything it would not file into. So `ok/a /`
      is savable and is never *used*: `ok/a ` is, and the gateway takes it. The
      thing that costs a meeting is a destination the gateway answers 400
      `meeting_invalid` for — the code no client retries — so that is what is
      asserted, at the layer that produces it.
    */
    for (const folder of REACHABLE_FOLDERS) {
      const used = destinationOf([{ ...OWN, meetingsFolder: folder }]).folder;
      expect([folder, normalizeMeetingFolder(used)]).not.toEqual([folder, null]);
    }
  });

  test("and a folder it would refuse is never the one a recording uses", () => {
    const refusedByGateway = REACHABLE_FOLDERS.filter(
      (folder) => normalizeMeetingFolder(folder) === null,
    );
    /*
      An exact count, not a floor: the point is that the table really does
      contain refusals on both sides, so the test above is not passing
      vacuously. Adding a shape is meant to make you come here and say which
      side it is on.
    */
    expect(refusedByGateway).toHaveLength(11);
    expect(REACHABLE_FOLDERS).toHaveLength(18);

    for (const folder of refusedByGateway) {
      const used = destinationOf([{ ...OWN, meetingsFolder: folder }]).folder;
      expect([folder, used]).not.toEqual([folder, folder]);
      expect([folder, normalizeMeetingFolder(used)]).not.toEqual([folder, null]);
    }
  });

  test("and the field refuses the ones no collapse can rescue", () => {
    // `ok/a /` is savable because collapsing it produces a folder the gateway
    // takes. `a..b` is not, and Save is what says so before anything is stored.
    expect(canSaveMeetingFolder("a..b", "")).toBe(false);
    expect(canSaveMeetingFolder(".git", "")).toBe(false);
    expect(canSaveMeetingFolder("overview.md", "")).toBe(false);
    expect(canSaveMeetingFolder("2-areas/meetings", "")).toBe(true);
  });

  test("the refusal says what to do, and does not quote the folder back", () => {
    expect(meetingFolderProblem("a..b")).toBe(UNFILEABLE_FOLDER);
    expect(UNFILEABLE_FOLDER).not.toContain("a..b");
  });

  test("an empty field is not a complaint, and is not a save either", () => {
    // Somebody who has selected the whole value to retype it is mid-word, not
    // wrong. `canSaveMeetingFolder` is what refuses to store nothing.
    expect(meetingFolderProblem("")).toBeNull();
    expect(canSaveMeetingFolder("", "2-areas/meetings")).toBe(false);
  });

  test("the default this module offers is the folder the gateway files into", () => {
    // The real package, not a copy of its constant.
    expect(INBOX_FOLDER.startsWith(MEETINGS_FOLDER)).toBe(true);
    expect(normalizeMeetingFolder(INBOX_FOLDER)).not.toBeNull();
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
});

describe("a destination read back off a device", () => {
  /**
   * Every destination that has been to storage comes back through
   * `parseDestination` — a restored `MeetingRecord`'s is the one that still
   * does. It is a file on a *device*: a restored backup, a rooted browser,
   * another app sharing the store, and both fields end up in a request against
   * the customer's own bucket.
   */
  test("a destination this build wrote is a destination", () => {
    const destination: MeetingDestination = {
      kind: "personalInbox",
      contextSlug: "testagent1",
      folder: INBOX_FOLDER,
    };
    expect(parseDestination(JSON.parse(JSON.stringify(destination)))).toEqual(destination);
  });

  test("a folder that could not be a bucket key is not a destination", () => {
    for (const folder of ["../escape", "/leading", "a\\b", "with\u0001control"]) {
      expect(
        parseDestination({ kind: "personalInbox", contextSlug: "testagent1", folder }),
      ).toBeNull();
    }
  });

  test("a slug that is not a slug is not a destination", () => {
    expect(
      parseDestination({ kind: "personalInbox", contextSlug: "@testagent1", folder: "0-inbox" }),
    ).toBeNull();
    expect(parseDestination({ kind: "somethingElse", contextSlug: "a", folder: "b" })).toBeNull();
    expect(parseDestination(null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe("the workspace a destination names", () => {
  /**
   * The other half of routing, and the half that was silently wrong.
   *
   * A `MeetingDestination` names a context by slug; `files.writeNote` takes a
   * `workspaceId`. `meetingWorkspaceId` is the only translation between the
   * two, and its interesting case is the one with no destination at all — the
   * one-tap Record on `/meetings`, which asks nobody anything.
   *
   * That case used to resolve through `defaultContext`, which is
   * `role === "owner"` and nothing else, over a list sorted oldest-first. So
   * somebody who owns a shared workspace older than their own had a meeting
   * written into a bucket their colleagues watch, at whatever visibility that
   * folder carries, with no sheet ever shown to name the audience — and
   * somebody who owns nothing but is an `editor` somewhere fell to
   * `contexts[0]`, which is a write into another person's context.
   */
  const contexts = [
    { slug: "acme", kind: "shared", role: "owner", workspaceId: "ws-acme" },
    { slug: "testagent1", kind: "personal", role: "owner", workspaceId: "ws-mine" },
  ];

  test("a meeting nobody addressed goes to the recorder's own workspace", () => {
    expect(meetingWorkspaceId(contexts, null)).toBe("ws-mine");
  });

  test("and never to a shared workspace, however old it is", () => {
    /*
      The whole finding, as a test. `defaultContext` answers `ws-acme` for this
      list — it is the first `owner` — so a resolver built on it files a
      transcript into a workspace several people watch. `ownPersonalContext` is
      the rule `destination.ts` already argues for the sheet's first offer, and
      it is the same rule here because it is the same question.
    */
    expect(meetingWorkspaceId(contexts, null)).not.toBe("ws-acme");
  });

  test("somebody who owns no workspace has nowhere for it to go, and is told so", () => {
    /*
      `contexts[0]` is somebody else's context. Answering `null` keeps the
      meeting on the device — `unavailable`, so it is retried rather than
      parked, and claiming an @name makes the next drain land it.
    */
    const editorOnly = [
      { slug: "acme", kind: "shared", role: "editor", workspaceId: "ws-acme" },
      { slug: "colleague", kind: "personal", role: "member", workspaceId: "ws-them" },
    ];
    expect(meetingWorkspaceId(editorOnly, null)).toBeNull();
  });

  test("a named context is looked up by slug, with or without the @", () => {
    expect(meetingWorkspaceId(contexts, "acme")).toBe("ws-acme");
    expect(meetingWorkspaceId(contexts, "@acme")).toBe("ws-acme");
  });

  test("a context this account cannot reach is null, not a fallback", () => {
    // Falling back to the workspace here would file a meeting somebody addressed to
    // `@acme` into their own bucket without saying so. The writer refuses.
    expect(meetingWorkspaceId(contexts, "gone")).toBeNull();
  });
});
