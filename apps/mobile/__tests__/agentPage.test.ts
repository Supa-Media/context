import { describe, expect, test } from "@jest/globals";
import type { EditorState } from "../features/console/files/editor";
import { emptyEditor } from "../features/console/files/editor";
import type { DestinationContext } from "../features/meetings/destination";
import { agentPage, describePlace } from "../features/agent/page";

/**
 * WHAT THE AGENT IS TOLD ABOUT WHERE YOU ARE — AND WHAT IT IS NEVER TOLD.
 *
 * The agent's opening turn has to know the room it is standing in: which
 * context, which note, who can read that note. `VoicePage` already carries
 * almost exactly that for the microphone, and this is the same object widened.
 *
 * ## The whole point of this module is what it leaves out
 *
 * The device now keeps an offline mirror of every note (`features/offline/`),
 * and the editor on screen is holding the full text of the open one in
 * `draft`. So the app *could* put a note's body straight into a prompt, and
 * the first time somebody profiles the agent and finds it spending a tool call
 * to read a note that was already in memory, that is exactly the "optimisation"
 * they will reach for.
 *
 * It must never land. The gateway re-reads every note through the agent's own
 * grant, which is what puts the read through `canSee` and what puts it in the
 * audit trail under the agent's name. A body pasted in from the console is a
 * **second path to content that passes neither** — the app would be handing the
 * model text the grant may not be entitled to, and no test at the gateway could
 * see it happen.
 *
 * So this payload carries *references*: a path, the etag it was seen at, and
 * what the entry claims about its audience. Never a body, never a fragment of
 * one, never a summary of one.
 *
 * ## `unsaved` is the interesting half
 *
 * The saved text and the text on screen can differ, and the agent reads the
 * saved one. Telling it *that they differ* costs one boolean and keeps it
 * honest — "what I read may be behind your screen" is a true and useful thing
 * for it to say. Telling it *how* they differ would mean sending the draft,
 * which is the one thing this module exists to refuse. One boolean is the
 * whole of the compromise.
 *
 * ## Sabotage record
 *
 * Applied to `features/agent/page.ts`, suite run, named test observed failing,
 * reverted.
 *
 *  1. `body: state.draft` added to the note reference — the "optimisation"
 *     described above, written exactly as somebody would write it.
 *     → **3 fail**: `a note the grant cannot see does not become readable by
 *     opening it in the editor first`, `an unsaved draft is reported as a flag
 *     and never as its text`, and `an encrypted note hands over no ciphertext`.
 *     The first is the one that names the security property.
 *  2. `unsaved` computed as `false` always.
 *     → **2 fail**: `an unsaved draft is reported as a flag and never as its
 *     text` and `says when the screen is ahead of the file` — the agent would
 *     claim the file it read is what is on screen, in the object and in the
 *     sentence built from it.
 *  3. `readable` left `true` for an encrypted note.
 *     → **1 fails**: `an encrypted note is marked unreadable rather than
 *     merely private`. The agent would spend a tool call fetching a body
 *     neither it nor the console has a key for, and report the ciphertext as
 *     the note.
 *  4. `visibility` hard-coded to `private` in the reference.
 *     → **2 fail**: `the audience travels with the note, for disclosure` and
 *     `names the context and the note, and says who can read it`. The agent
 *     could not warn somebody that a draft it is about to propose lands in a
 *     note six colleagues read — and would actively call that note private.
 */

const CONTEXT: DestinationContext = { slug: "seyi", kind: "personal", role: "owner" };
const SHARED: DestinationContext = { slug: "supa", kind: "shared", role: "editor" };

/**
 * A distinctive phrase that exists nowhere else in this file's expectations.
 *
 * Every assertion about leakage searches for this rather than for a word like
 * "secret", so a payload that happened to contain the *word* cannot pass a test
 * that is really asking whether it contains the *note*.
 */
const SENTINEL = "zarquon-plumbago-9471";

const NOTE_TEXT = [
  "# Weekly sync",
  "",
  `The acquisition price is ${SENTINEL} and nobody outside this room knows it.`,
  "",
].join("\n");

function editorHolding(overrides: Partial<EditorState> = {}): EditorState {
  return {
    ...emptyEditor,
    status: "clean",
    path: "1-projects/weekly-sync.md",
    baseline: NOTE_TEXT,
    draft: NOTE_TEXT,
    etag: "W/\"a1b2c3\"",
    visibility: "private",
    ...overrides,
  };
}

/** Everything reachable in the payload, as one string. */
function serialize(value: unknown): string {
  return JSON.stringify(value);
}

describe("the note never travels", () => {
  test("a note the grant cannot see does not become readable by opening it in the editor first", () => {
    /*
      The named guarantee, at the layer where the object is defined rather than
      at the layer where it becomes load-bearing.

      Opening a note fills the editor with its text. If that text could ride
      along in the ambient context, then "the agent's grant may not read this
      note" would be defeated by the person simply having it open — and the
      gateway, which is where `canSee` lives, would never see the bypass
      because the body arrived from the client as prompt text.
    */
    const page = agentPage({
      context: CONTEXT,
      editor: editorHolding(),
      route: "/console/@seyi",
      meetingLive: false,
      query: null,
    });

    expect(serialize(page)).not.toContain(SENTINEL);
    // And the reference that *is* carried is enough to fetch it properly.
    expect(page.note?.path).toBe("1-projects/weekly-sync.md");
    expect(page.note?.etag).toBe("W/\"a1b2c3\"");
  });

  test("an unsaved draft is reported as a flag and never as its text", () => {
    const page = agentPage({
      context: CONTEXT,
      editor: editorHolding({
        baseline: "# Weekly sync\n",
        draft: NOTE_TEXT,
        status: "dirty",
      }),
      route: "/console/@seyi",
      meetingLive: false,
      query: null,
    });

    expect(page.note?.unsaved).toBe(true);
    expect(serialize(page)).not.toContain(SENTINEL);
  });

  test("a saved note is not reported as unsaved", () => {
    const page = agentPage({
      context: CONTEXT,
      editor: editorHolding(),
      route: "/console/@seyi",
      meetingLive: false,
      query: null,
    });

    expect(page.note?.unsaved).toBe(false);
  });

  test("an encrypted note hands over no ciphertext", () => {
    /*
      `baseline` and `draft` are the envelope's ciphertext for an encrypted
      note, and a payload that carried "the text" would carry that. It is still
      the customer's content and it is still not ours to move around.
    */
    const page = agentPage({
      context: CONTEXT,
      editor: editorHolding({
        baseline: SENTINEL,
        draft: SENTINEL,
        encrypted: true,
        readOnly: true,
      }),
      route: "/console/@seyi",
      meetingLive: false,
      query: null,
    });

    expect(serialize(page)).not.toContain(SENTINEL);
  });

  test("the search query travels, because the person typed it", () => {
    /*
      The one string that is the person's own words rather than the note's.
      Carrying it is what makes "summarise what I'm looking for" work, and it
      leaks nothing that was not typed into this session a moment ago.
    */
    const page = agentPage({
      context: CONTEXT,
      editor: emptyEditor,
      route: "/console/search",
      meetingLive: false,
      query: "pricing decisions",
    });

    expect(page.query).toBe("pricing decisions");
  });
});

describe("what the reference says", () => {
  test("an encrypted note is marked unreadable rather than merely private", () => {
    const page = agentPage({
      context: CONTEXT,
      editor: editorHolding({ encrypted: true, readOnly: true }),
      route: "/console/@seyi",
      meetingLive: false,
      query: null,
    });

    expect(page.note?.readable).toBe(false);
  });

  test("an ordinary note is readable", () => {
    const page = agentPage({
      context: CONTEXT,
      editor: editorHolding(),
      route: "/console/@seyi",
      meetingLive: false,
      query: null,
    });

    expect(page.note?.readable).toBe(true);
  });

  test("the audience travels with the note, for disclosure", () => {
    const page = agentPage({
      context: SHARED,
      editor: editorHolding({ visibility: "team" }),
      route: "/console/@supa",
      meetingLive: false,
      query: null,
    });

    expect(page.note?.visibility).toBe("team");
  });

  test("a note with no etag yet is carried as a note that does not exist", () => {
    /*
      A brand-new note has never been written, so there is nothing at the path
      for the gateway to read. Saying so is better than sending a path that
      answers 404 and letting the agent guess why.
    */
    const page = agentPage({
      context: CONTEXT,
      editor: editorHolding({ etag: null }),
      route: "/console/@seyi",
      meetingLive: false,
      query: null,
    });

    expect(page.note?.etag).toBeNull();
    expect(page.note?.readable).toBe(false);
  });

  test("a folder on screen is no note at all", () => {
    const page = agentPage({
      context: CONTEXT,
      editor: { ...emptyEditor, path: null },
      route: "/console/@seyi",
      meetingLive: false,
      query: null,
    });

    expect(page.note).toBeNull();
  });
});

describe("the rest of the room", () => {
  test("a context this build does not recognise is never called personal", () => {
    /*
      The same rule `audience.ts` holds, for the same reason: a control plane
      that ships a third `kind` must not have every context in it described to
      the model as the person's own.
    */
    const page = agentPage({
      context: { slug: "future", kind: "syndicate", role: "member" },
      editor: editorHolding(),
      route: "/console/@future",
      meetingLive: false,
      query: null,
    });

    expect(page.context?.personal).toBe(false);
  });

  test("a personal context is personal", () => {
    const page = agentPage({
      context: CONTEXT,
      editor: editorHolding(),
      route: "/console/@seyi",
      meetingLive: false,
      query: null,
    });

    expect(page.context?.personal).toBe(true);
  });

  test("a live meeting is part of where you are", () => {
    const page = agentPage({
      context: CONTEXT,
      editor: emptyEditor,
      route: "/console/@seyi",
      meetingLive: true,
      query: null,
    });

    expect(page.meetingLive).toBe(true);
  });

  test("no context open is a page with no context", () => {
    const page = agentPage({
      context: null,
      editor: emptyEditor,
      route: "/console",
      meetingLive: false,
      query: null,
    });

    expect(page.context).toBeNull();
    expect(page.note).toBeNull();
  });
});

describe("the sentence the agent is handed", () => {
  test("names the context and the note, and says who can read it", () => {
    const line = describePlace(
      agentPage({
        context: SHARED,
        editor: editorHolding({ visibility: "team" }),
        route: "/console/@supa",
        meetingLive: false,
        query: null,
      }),
    );

    expect(line).toContain("@supa");
    expect(line).toContain("1-projects/weekly-sync.md");
    expect(line).toContain("team");
  });

  test("carries no note text either", () => {
    const line = describePlace(
      agentPage({
        context: CONTEXT,
        editor: editorHolding(),
        route: "/console/@seyi",
        meetingLive: false,
        query: null,
      }),
    );

    expect(line).not.toContain(SENTINEL);
  });

  test("says when the screen is ahead of the file", () => {
    const line = describePlace(
      agentPage({
        context: CONTEXT,
        editor: editorHolding({ baseline: "# Weekly sync\n", status: "dirty" }),
        route: "/console/@seyi",
        meetingLive: false,
        query: null,
      }),
    );

    expect(line).toMatch(/unsaved/i);
  });

  test("a page with nothing open still describes itself", () => {
    const line = describePlace(
      agentPage({
        context: null,
        editor: emptyEditor,
        route: "/console",
        meetingLive: false,
        query: null,
      }),
    );

    expect(line.length).toBeGreaterThan(0);
    expect(line).not.toContain("null");
    expect(line).not.toContain("undefined");
  });
});
