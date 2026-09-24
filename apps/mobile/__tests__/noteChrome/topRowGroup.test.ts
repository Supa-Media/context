/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { dataWith, emptyEditor, FILE, mountConsole, NOTE, OPEN_LINK, sheet } from "./fixtures";

/**
 * The positions live in a dropdown on the General access line now, the way
 * Google Docs draws "Restricted ⌄", so a test opens it the way a person would
 * before reading or pressing one.
 */
function openAudience(app: { press: (node: HTMLElement | null) => void }): void {
  app.press(sheet("share-audience"));
}

describe("the top row ends in one group, and it is the note's", () => {
  /**
   * **This was `the top bar is a toggle and one group › nothing sits between
   * them`**, and it asserted a `frame-drawer-toggle` at the leading edge with
   * an empty middle. Both halves are retired rather than deleted:
   *
   *  - the toggle is gone because there is no panel for it to pull in — a
   *    phone has no file-tree drawer and no rail sheet at any density
   *    (`features/app/frame.ts`), and a toggle for a panel that does not exist
   *    is not navigation;
   *  - the middle is no longer empty. The old comment here said "the chip that
   *    used to be in the middle … is the vault switcher at the foot of the file
   *    tree now", and that footer went with the tree. The contexts are a
   *    scrolling strip in the middle and the account is pinned before it.
   *
   * The claim that has *not* changed is the one this file exists for: **one row
   * above the note**, and the trailing group on it holds what acts on the note.
   * So the row is asserted by its three slots rather than by an emptiness.
   */
  test("an account, the contexts, and the note's own actions", () => {
    const app = mountConsole(dataWith());

    // The slot's own control, not `account-sign-out`: that testID now names a
    // row inside the menu this trigger opens, not something on screen at rest.
    expect(app.find("account-menu")).not.toBeNull();
    expect(app.find("context-strip")).not.toBeNull();
    expect(app.find("note-share")).not.toBeNull();

    // Retired chrome, absent: the two toggles and the chip.
    expect(app.find("frame-drawer-toggle")).toBeNull();
    expect(app.find("frame-nav-toggle")).toBeNull();
    expect(app.find("storage-pill")).toBeNull();
    // And search is on the toolbar, where the thumb is, not doubled up here.
    expect(app.find("frame-search")).toBeNull();
  });

  /**
   * THE eye. Reading mode is a control somebody has to find, and "it is in the
   * trailing group" is exactly the claim that was made about Share once and was
   * not true of any screen.
   *
   * It leads the group rather than following Share: this changes how the note
   * in front of you is drawn and is undone by pressing it again, Share opens a
   * sheet that grants somebody access, and the reversible one is the safer
   * neighbour for a thumb.
   *
   * ## Sabotage record
   *
   * Dropping the button from `_layout.tsx`: **3** failed here. Leaving it drawn
   * but never passing `reading` into `NoteEditor`: **1** — the editability
   * check, which is the one that says the press does anything.
   */
  test("the note carries a reading toggle, before Share", () => {
    const app = mountConsole(dataWith());
    const eye = app.find("note-read");
    expect(eye).not.toBeNull();
    // Before Share in the DOM, which is what "leads the group" means on a row
    // laid out in order.
    const share = app.find("note-share");
    expect(eye!.compareDocumentPosition(share!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * The glyph and the label say the same thing, and the glyph used to say
   * nothing.
   *
   * This was "it names the act, since a glyph cannot" — one eye, whose state
   * lived in a `selected` accent fill because a single mark cannot draw both
   * "will hide the markup" and "will bring it back". Two marks can, so the
   * icon now carries the act and the fill is gone: lighting the *pencil* would
   * say "pencil mode is on", which is the opposite of what pressing it does.
   *
   * `data-icon` is what makes the swap assertable at all — an icon drawn from
   * `View`s or from a `<Path>` has no text in it, which is the whole reason
   * `Icon.tsx` puts the name in the DOM.
   */
  test("...and the glyph names the act, alongside the label", () => {
    const app = mountConsole(dataWith());
    const glyph = () => app.find("note-read")!.querySelector("[data-icon]")!.getAttribute("data-icon");

    expect(app.find("note-read")!.getAttribute("aria-label")).toBe("Read this note");
    expect(glyph()).toBe("eye");

    app.press(app.find("note-read"));

    expect(app.find("note-read")!.getAttribute("aria-label")).toBe("Edit this note");
    expect(glyph()).toBe("pencil");
  });

  /**
   * The press has to reach the document, or the eye is decoration.
   *
   * `contenteditable` is what `editability` drops, and it is what every other
   * consequence of read-only hangs off — the paste, drop and cut handlers all
   * open with the same question. Asserting on it rather than on a class is
   * asserting on the thing that makes the mode true.
   */
  test("...and pressing it stops the note being editable", () => {
    const app = mountConsole(dataWith());
    const editable = () =>
      document.body.querySelector('[contenteditable="true"]') !== null;
    expect(editable()).toBe(true);
    app.press(app.find("note-read"));
    expect(editable()).toBe(false);
    app.press(app.find("note-read"));
    expect(editable()).toBe(true);
  });

  /**
   * …AND THE NOTE ITSELF MAY ASK, WHICH IS THE SAME MODE FROM THE OTHER END.
   *
   * A page built around a ` ```form ` fence is drawn as a fillable form only
   * while it is read (`formBlock.ts`), so the one kind of page whose purpose is
   * to be *used* opened as a code fence and every visitor had to find the eye
   * first. Its author can now say so in the frontmatter.
   *
   * This is the claim that the wiring exists at all: `files/viewMode.ts` has
   * its own suite for the vocabulary and the layering (`noteViewMode.test.ts`),
   * and all of it is inert if `BrowsePane` never calls the hook. So the
   * assertion here is the same `contenteditable` the press is asserted on
   * above, reached without a press.
   *
   * ## Sabotage record
   *
   * Dropping `useDeclaredView` from `BrowsePane`: **1** failed here — this one,
   * on its first assertion — and **none** in `noteViewMode.test.ts`, which is
   * the whole reason this test is in this file as well.
   */
  test("a note that declares `view: read` opens read, with no press at all", () => {
    const declaring = FILE.replace("status: unprocessed", "view: read");
    const app = mountConsole(
      dataWith({
        editor: { ...emptyEditor, status: "clean", path: NOTE, baseline: declaring, draft: declaring },
      }),
    );

    expect(document.body.querySelector('[contenteditable="true"]')).toBeNull();
    // The control agrees with the state rather than lagging it: the way out is
    // the pencil, because the note is already being read.
    expect(app.find("note-read")!.getAttribute("aria-label")).toBe("Edit this note");

    // And the person outranks the file — the one place a broken fence is fixed.
    app.press(app.find("note-read"));
    expect(document.body.querySelector('[contenteditable="true"]')).not.toBeNull();
  });

  /**
   * Share had to land somewhere when the breadcrumb went, and "somewhere" is
   * the thing that is easy to skip. `browseShare.test.ts` states the rule this
   * is the phone's half of: a control that is correct in `menu.ts` and
   * unreachable on a screen is a feature nobody has.
   */
  test("Share opens the dialog for the note in front of you", () => {
    const app = mountConsole(dataWith());
    expect(document.body.querySelector('[aria-label="Share plan.md"]')).toBeNull();

    app.press(app.find("note-share"));

    expect(document.body.querySelector('[aria-label="Share plan.md"]')).not.toBeNull();
  });

  test("and it is absent — not dimmed — for anybody the server would refuse", () => {
    const editor = mountConsole(dataWith({ canShare: false }));
    expect(editor.find("note-share")).toBeNull();
    // The positive control: the same fixture with ownership shows it, so this
    // cannot pass because the note failed to open.
    expect(editor.find("note-inline-title")).not.toBeNull();
  });

  /**
   * ## The padlock is gone, and every claim it carried moved into the sheet
   *
   * The trailing group used to hold two icons. They were two controls for one
   * question — and they overlapped on the dangerous state: the padlock's third
   * position minted exactly the share row the sheet's own "Create link"
   * minted. Worse, most notes sit at `team` already by folder inheritance, so
   * a note was **one tap on an unlabelled 20pt icon** away from a link that
   * needs no account, with the glyph changing to a globe as the only feedback.
   *
   * `scope.ts` is untouched — it is still the pure model of what the positions
   * are and how to move between them, and `setScope` is still the single point
   * every surface goes through. Only the control driving it changed, so the
   * tests below are the same claims re-asked where they now live: a named
   * segmented control inside the share sheet.
   */
  test("a folder is acted on through the same one button", () => {
    const app = mountConsole(
      dataWith({}, { kind: "folder", path: "3-resources", name: "3-resources" }),
    );
    expect(app.find("note-share")).not.toBeNull();
    // The padlock is gone for a folder too — there is only ever one icon now.
    expect(app.find("note-visibility")).toBeNull();
  });

  /**
   * **A folder has three positions now, and that is a change rather than a
   * relaxation.** This asserted the opposite, on the ground that
   * `createLinkShare` was note-only and a third position would be a press that
   * always fails. A folder link exists: it reaches the folder's whole subtree,
   * mirroring Drive and Dropbox, and it is stricter than either because every
   * path is still re-derived through the live `privacy.md` at `team` scope
   * rather than inherited from the folder.
   *
   * The press no longer always fails, so the control no longer hides it.
   */
  test("a folder's sheet offers the public-link position too", () => {
    const app = mountConsole(
      dataWith({}, { kind: "folder", path: "3-resources", name: "3-resources" }),
    );
    app.press(app.find("note-share"));
    openAudience(app);
    expect(sheet("share-audience-private")).not.toBeNull();
    expect(sheet("share-audience-team")).not.toBeNull();
    expect(sheet("share-audience-anyone")).not.toBeNull();
  });

  /**
   * THE WORDS REACH THE SCREEN, NOT JUST THE MODULE.
   *
   * `audienceWords.test.ts` proves what the sentences say; this proves the
   * sheet is the thing saying them. The two halves are worth keeping apart:
   * the vocabulary changed underneath a dialog that went on rendering, and
   * every existing test passed either way because none of them read a label.
   *
   * "Everyone in @…" rather than "Workspace" is the whole point — a set the
   * reader can check against the People list, instead of a word naming a set
   * that exists nowhere.
   */
  test("the sheet names the context rather than saying `team`", () => {
    const app = mountConsole(dataWith());
    app.press(app.find("note-share"));
    openAudience(app);
    const team = sheet("share-audience-team")!;
    expect(team.getAttribute("aria-label")).toMatch(/^Everyone in @/);
    expect(team.getAttribute("aria-label")).not.toMatch(/workspace/i);
    expect(sheet("share-audience-private")!.getAttribute("aria-label")).toBe("Restricted");
  });

  /**
   * What the icon could only imply, the control says. A padlock has to be
   * decoded; a marked position is read.
   */
  test("the sheet names every position and marks the one it is in", () => {
    const shared = mountConsole(dataWith());
    shared.press(shared.find("note-share"));
    openAudience(shared);
    expect(sheet("share-audience-team")!.getAttribute("aria-checked")).toBe("true");
    expect(sheet("share-audience-private")!.getAttribute("aria-checked")).toBe("false");

    const priv = mountConsole(dataWith({}, { visibility: "private", inherited: "private" }));
    priv.press(priv.find("note-share"));
    openAudience(priv);
    expect(sheet("share-audience-private")!.getAttribute("aria-checked")).toBe("true");
  });

  /**
   * Asserted on the *call*, not on what the screen then shows: the console does
   * not move a visibility optimistically, so a test reading the control
   * afterwards would pass on a segment wired to nothing.
   */
  test("pressing a position asks the server to move the scope, once", () => {
    const moved: unknown[] = [];
    const app = mountConsole(
      dataWith({ setScope: (...args: unknown[]) => moved.push(args) } as never),
    );
    app.press(app.find("note-share"));
    openAudience(app);
    app.press(sheet("share-audience-private"));
    expect(moved).toEqual([[NOTE, "file", "team", "private"]]);
  });

  /**
   * **The step the padlock used to take on one unlabelled tap.**
   *
   * The whole reason this control moved. Narrowing is immediate — a dialog
   * that asks before making something *more* private teaches people to dismiss
   * it unread, which is the habit that then costs them the one that mattered —
   * but publishing asks, in words, and nothing is minted until it is answered.
   */
  test("going public asks first, and mints nothing until it is answered", () => {
    const moved: unknown[] = [];
    const app = mountConsole(
      dataWith({ setScope: (...args: unknown[]) => moved.push(args) } as never),
    );
    app.press(app.find("note-share"));
    openAudience(app);
    app.press(sheet("share-audience-anyone"));

    // Asked, and NOT done.
    expect(sheet("share-confirm-public")).not.toBeNull();
    expect(moved).toEqual([]);

    app.press(sheet("share-confirm-public-yes"));
    expect(moved).toEqual([[NOTE, "file", "team", "anyone"]]);
  });

  /**
   * The one property this screen must not get wrong: a live link means the
   * `anyone` position is the true one, and it is drawn from the share row AND
   * the manifest together. `scopeOf` is where that rule lives; this is the
   * wiring.
   */
  test("a note with a live open link reads as the link position", () => {
    const app = mountConsole(
      dataWith({ openLinkPaths: new Set([NOTE]), shares: [OPEN_LINK] } as never),
      390,
    );
    app.press(app.find("note-share"));
    openAudience(app);
    expect(sheet("share-audience-anyone")!.getAttribute("aria-checked")).toBe("true");
  });

  test("…and a private note with a stale link row still reads as private", () => {
    // The link grants nothing over a private note — the server re-derives
    // visibility from the live manifest on every read — so reading as `anyone`
    // here would tell somebody they had published something they had not.
    const app = mountConsole(
      dataWith({ openLinkPaths: new Set([NOTE]), shares: [OPEN_LINK] } as never, {
        visibility: "private",
        inherited: "private",
      }),
    );
    app.press(app.find("note-share"));
    openAudience(app);
    expect(sheet("share-audience-private")!.getAttribute("aria-checked")).toBe("true");
    expect(sheet("share-audience-anyone")!.getAttribute("aria-checked")).toBe("false");
  });

  test("the audience control is absent — not dimmed — for anybody the server would refuse", () => {
    const member = mountConsole(dataWith({ canSetVisibility: false }));
    member.press(member.find("note-share"));
    expect(sheet("share-audience")).toBeNull();
    // The positive control: the sheet did open, so this cannot pass by mounting
    // nothing at all.
    expect(sheet("share-access")).not.toBeNull();
  });

  test("nor for `privacy.md`, which is the access map itself", () => {
    const app = mountConsole(
      dataWith({}, { path: "privacy.md", name: "privacy.md", readOnly: true }),
    );
    expect(app.find("note-inline-title")).not.toBeNull();
    // Share is absent, so there is no sheet and therefore no audience control:
    // `privacy.md` *is* the access map, and a control offering to change its
    // visibility would be offering to edit the file that decides everybody
    // else's.
    expect(app.find("note-share")).toBeNull();
    expect(app.find("note-visibility")).toBeNull();
  });
});
