/**
 * @jest-environment jsdom
 */

/**
 * Navigation on a phone, end to end — and it is not a way *off* a panel any
 * more, because there is no panel.
 *
 * Split out of `consoleChrome.test.ts`; see `fixtures.ts` in this folder for
 * the module-level rationale and the mounting harness these tests share.
 *
 * **This block used to be `the phone's way off a pane`**, and its premise was
 * stated in its own header: "`appFrameRender.test.ts` proves the frame *can*
 * raise and dismiss the sheet; this proves the console actually wires it up.
 * That gap was real and total: deleting `frame.closeNav()` from the rail's
 * `onNavigate` left all 1113 tests in this suite green, and it is the single
 * line that makes the fix a way out rather than a panel you have to dismiss by
 * hand after every choice." Every word of that was true and none of it survives
 * the panels: there is no rail sheet, no drawer, no scrim and no toggle at any
 * density (`features/app/frame.ts`).
 *
 * What survives is the *requirement* underneath it, in two halves, and both are
 * asserted below rather than assumed:
 *
 *  - **A destination is reachable without opening anything.** That is now
 *    stronger than "you can get out of the panel": there is nothing to get out
 *    of, so the test presses a destination on a console nobody has touched.
 *  - **Choosing a destination dismisses whatever it was chosen from.** The
 *    strip is not a panel, so choosing from it raises and leaves nothing — the
 *    assertion is that the screen is unchanged furniture rather than a sheet
 *    that has to be dismissed. The one thing a phone still raises over the note
 *    is the meeting sheet, and it puts itself away: `contextStrip.test.ts`
 *    holds the strip menu's half by name (`choosing a destination closes the
 *    menu and reports it once`) and `meetingsFlow.test.ts` holds the sheet's
 *    (`the meeting that results is the one the sheet described`, which asserts
 *    the sheet is gone). What is left here is the wiring between them and this
 *    console, which is exactly what the deleted `closeNav()` mutant proved a
 *    unit test cannot see.
 *
 * Mounted at a phone width against the real layout, the real `ContextStrip`,
 * the real `BottomBar` and the real `AppFrame` — only the data and the router
 * are stubs.
 *
 * ## Sabotage record
 *
 * Against a green baseline of **172 suites / 3,285 tests**
 * (`npx jest --watchman=false`): returning the pinned account's pressable to
 * `padding: 4` — a 34pt target around a 34pt mark, which is what it shipped as
 * — fails **1 test**, `sign-out is reachable through the account menu, and the
 * trigger is a target a thumb can hit`, and nothing else. That is the whole of
 * the coverage on the only sign-out control this product has on a phone,
 * which is why it is asserted from `layout.minTouchTarget` rather than from a
 * literal.
 */

import { describe, expect, test } from "@jest/globals";
import { mockConsoleState, created, layout, mountConsole, sheetUp } from "./fixtures";

describe("the phone reaches a destination with nothing opened first", () => {
  test("a context is one press in the band, and the press raises no panel", () => {
    const app = mountConsole(390);

    // Nothing is up before, which is the whole point: this is the resting
    // state of the screen rather than something a previous press produced.
    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();

    /*
      The button for the context you are IN, at the head of the breadcrumb —
      this fixture has exactly one context, so there is no pill for it on the
      strip and this is the whole of the navigation to a context on this screen.
      It is also the way to that context's root, which is the press that was
      missing when the segment was deleted instead of moved.
    */
    const pill = app.find("nav-context-seyi");
    expect(pill).not.toBeNull();
    app.press(pill);

    // Still nothing. The band is furniture; there is no dismissal to wire up
    // and therefore none to forget.
    expect(app.find("frame-nav-sheet")).toBeNull();
    expect(app.find("frame-scrim")).toBeNull();
    expect(app.find("nav-band")).not.toBeNull();

    app.unmount();
  });

  test("the + is in the corner of a pointer console, on every route it has", () => {
    /*
      THE MOUNT, WHICH IS THE HALF NO UNIT TEST OF THE BUTTON CAN SEE.

      `CreateButton` has its own tests for what it draws and what its menu
      offers. Those pass just as happily if nothing in the product ever renders
      it — which is exactly the defect being guarded here, and the one the
      microphone it replaced actually shipped: the corner was drawn by
      `NoteEditor`, so it existed on a note and nowhere else. The owner's words
      are the requirement: *"it should show up all the time, even when on a
      folder page, and not just show up when on a note."*

      So this asserts the *layout* draws it, at a context route with no note
      selected — which is a folder page, and the state a console arrives in.
    */
    mockConsoleState.pathname = "/console/@seyi";
    const app = mountConsole(1280);
    expect(app.find("console-create")).not.toBeNull();
    app.unmount();
  });

  test("...and on Map, which has no file tree and no note at all", () => {
    // Restored by `afterEach`, not here: see the note there.
    mockConsoleState.pathname = "/console/map";
    const app = mountConsole(1280);
    expect(app.find("console-create")).not.toBeNull();
    app.unmount();
  });

  test("pressing it offers everything a console starts", () => {
    const app = mountConsole(1280);
    app.press(app.find("console-create"));

    // The menu is a `Menu`, which react-native-web portals out of the tree.
    for (const label of ["New meeting", "New note", "New drawing", "New folder", "New chat"]) {
      expect([label, document.body.textContent?.includes(label)]).toEqual([label, true]);
    }
    app.unmount();
  });

  test("a context with no model key is not offered a conversation", () => {
    /*
      A key is what lets the agent answer at all, so the row without one opens
      a composer whose first send errors — the control that appears to work and
      does nothing. Everything else in the menu still makes a file, so the menu
      is shorter rather than absent.
    */
    mockConsoleState.modelConnected = false;
    const app = mountConsole(1280);
    app.press(app.find("console-create"));

    expect(document.body.textContent).not.toContain("New chat");
    expect(document.body.textContent).toContain("New note");
    expect(document.body.textContent).toContain("New meeting");
    app.unmount();
  });

  test("...and neither is one whose answer has not landed yet", () => {
    /*
      `undefined` is "ask again in a moment", which is not "there is no key".
      Absent then present is the honest direction: offered then withdrawn is an
      offer somebody may already have pressed.
    */
    mockConsoleState.modelConnected = undefined;
    const app = mountConsole(1280);
    app.press(app.find("console-create"));
    expect(document.body.textContent).not.toContain("New chat");
    app.unmount();
  });

  test("and the corner holds no second control: the microphone is not drawn beside it", () => {
    /*
      One corner, one control. `oneMicrophone.test.ts` holds the editor's half
      through the real editor; this is the one that can see both at once,
      because it mounts the console that supplies the `+` and the note that
      used to supply the microphone.
    */
    const app = mountConsole(1280);
    expect(app.find("console-create")).not.toBeNull();
    expect(app.find("voice-button")).toBeNull();
    app.unmount();
  });

  test("a phone draws no floating + at all, because its bottom row carries one", () => {
    /*
      The row's own `+` is the phone's create surface — and since the microphone
      key went, its meeting route too. A second floating control 24pt above that
      row is the defect `oneMicrophone.test.ts` exists for, arriving again with a
      different glyph on it.
    */
    const app = mountConsole(390);
    expect(app.find("console-create")).toBeNull();
    expect(app.find("bottom-bar-new")).not.toBeNull();
    expect(app.find("bottom-bar-meeting")).toBeNull();
    app.unmount();
  });

  test("the app's other place is a row in the + sheet, and choosing it records", () => {
    /*
      THE SEVENTH KEY, AFTER THE SHEET WENT — AND AFTER THE KEY WENT.

      It used to be its own microphone at the end of the row, and before that it
      raised a destination sheet with two rows, an audience line and a Start.
      Both are gone, for the owner's reasons in order: *"no need to ask people it
      will just confuse them"*, and then *"we no longer need a dedicated mic
      button on the bottom row, just a plus button that opens different
      options"*.

      What `docs/decisions/meetings.md` actually protects survived both. It calls
      a control that silently starts recording "the same product with the
      indicator removed", and the indicator is where it went: the press records
      and lands on the meeting's own screen — a clock, a meter, a transport and
      the note it is becoming. What the phone must keep is a **route**, and this
      is the route: one press for the `+`, one for Meeting.

      So what is asserted is that the two presses reach a recording, and that
      neither raises the retired destination sheet. This fixture's console has no
      meetings controller configured, so the attempt cannot reach a microphone;
      what it must do is say so rather than doing nothing at all, which is
      `meetingsFlow.test.ts`'s refusal arriving through the real row.
    */
    const app = mountConsole(390);
    expect(sheetUp()).toBe(false);

    app.press(app.find("bottom-bar-new"));
    const meeting = document.body.querySelector<HTMLElement>('[aria-label="New meeting"]');
    expect(meeting).not.toBeNull();
    app.press(meeting);

    expect(sheetUp()).toBe(false);
    expect(document.body.querySelector('[data-testid="meeting-refusal"]')).not.toBeNull();

    // And it is dismissible from inside itself, which is the property the rail
    // sheet's `closeNav()` used to carry for the panel it replaced.
    app.press(document.body.querySelector<HTMLElement>('[data-testid="meeting-refusal-close"]'));
    expect(document.body.querySelector('[data-testid="meeting-refusal"]')).toBeNull();

    app.unmount();
  });

  /**
   * AND THE FILES ARE IN THE SAME SHEET, WITH NOTHING ASKING FOR A NAME.
   *
   * The `+` is the only route to creating anything on a phone, so what it offers
   * is the whole of that capability — and the note is made on the press rather
   * than after a text field, which is what the owner asked for: *"for new note,
   * new drawing etc should not ask you to title it"*.
   */
  test("the + offers the three files, and Note writes one without asking", () => {
    const app = mountConsole(390);
    app.press(app.find("bottom-bar-new"));

    const labelled = (label: string) =>
      document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    for (const row of ["New note", "New drawing", "New folder"]) {
      expect(labelled(row)).not.toBeNull();
    }

    created.length = 0;
    app.press(labelled("New note"));
    // It reached the browser as an untitled note in the destination folder —
    // and no field and no sheet were in the way.
    expect(created).toEqual(["note:"]);
    expect(document.body.querySelector("input, textarea")).toBeNull();
    expect(labelled("New note")).toBeNull();

    app.unmount();
  });

  /**
   * A PHONE CAN ASK ITS CONTEXT A QUESTION.
   *
   * It could not, and the absence was never decided — it was a fact about the
   * code that nobody had written down. `CreateButton`'s `onNewChat` is `null`
   * "where there is no panel for a conversation to open in", and on a phone that
   * read as *no panel exists*, because the only thing that raised `AgentPanel`
   * was the floating microphone `NoteEditor` mounts. So the row was absent from
   * the phone's `+` while the desktop's menu offered it, and the way to the
   * agent on a phone was: open a note, put the keyboard up so the bottom row
   * hides, press the microphone that comes back, choose the agent row.
   *
   * `AgentPanel` is a `Modal` and says in its own header that it is one
   * precisely so it can "appear identically on a surface that has no console
   * around it at all". So the layout raises it, and the Chat row is a row on
   * both densities.
   *
   * ## What this asserts, and why each half is needed
   *
   * That the row is **there** and that pressing it **opens the panel**. A test
   * of only the first passes on a row wired to nothing, which is the shape of
   * the defect this closes; a test of only the second cannot tell a phone that
   * offers the row from one that never did.
   *
   * ## Sabotage record
   *
   * Applied as local edits to `_layout.tsx`, suite run, named tests observed
   * failing, reverted. Counts are failing tests in this file.
   *
   *   the phone's branch dropped, so it opens the aside it does not have    1
   *   `hasAside` back in the gate, so the row is absent on a phone          1
   *   the gate no longer reads `modelConnected`                             3
   *   the panel never mounted                                              1
   */
  test("the + offers a chat, and choosing it opens the panel", () => {
    const app = mountConsole(390);
    app.press(app.find("bottom-bar-new"));

    const chat = document.body.querySelector<HTMLElement>('[aria-label="New chat"]');
    expect(chat).not.toBeNull();
    app.press(chat);

    expect(app.find("agent-panel")).not.toBeNull();
    // And it names the model that will answer, which is `AgentPanel`'s own
    // disclosure rule rather than this test's: a conversation whose provider is
    // unstated is one somebody cannot cost.
    expect(app.find("agent-provider")).not.toBeNull();

    app.unmount();
  });

  /**
   * And the gate travels with the row, on both densities.
   *
   * The owner's line — *"new chat should be off btw if no LLM api key
   * configured"* — is `modelConnected`'s, and #733 argues why `undefined` is
   * absent rather than present. The phone's sheet asks the same question through
   * the same value, so a context with no key is not offered a conversation here
   * either.
   */
  test("and no chat row on a phone in a context with no model key", () => {
    mockConsoleState.modelConnected = false;
    const app = mountConsole(390);
    app.press(app.find("bottom-bar-new"));
    expect(document.body.querySelector('[aria-label="New chat"]')).toBeNull();
    // The rest of the sheet is untouched, so this cannot pass on a sheet that
    // failed to open at all.
    expect(document.body.querySelector('[aria-label="New note"]')).not.toBeNull();
    app.unmount();
  });

  test("sign-out is reachable through the account menu, and the trigger is a target a thumb can hit", () => {
    /*
      **It is the only sign-out control in the product**, and before the panels
      went it was at the foot of the rail — this test used to press
      `frame-nav-toggle` to reach it. There is no toggle and no rail on a phone;
      it lives behind the pinned account slot, in the corner of the glass that
      is always visible.

      **It used to be reached with no press at all** — `account-sign-out` was
      the avatar's own pressable, and pressing it signed out directly. That was
      the bug this test's sabotage record predates: on a clean queue,
      `useSignOutFlow` raises no confirmation, so the one thing reachable
      without a press was also the one thing nothing should do by accident.
      The avatar now opens a menu; this test presses through it rather than
      finding the row already on screen.

      The trigger is 44pt on both axes, from the token rather than from a
      literal — what a thumb hits is the pressable, and this is the one
      control here somebody reaches for deliberately and must not miss. The
      row inside the menu is a `Modal` portal (`react-native-web`), so it is
      searched for in `document.body` rather than through `app.find`, which is
      scoped to this test's own container.
    */
    mockConsoleState.pathname = "/console";
    const app = mountConsole(390);

    const trigger = app.find("account-menu");
    expect(trigger).not.toBeNull();
    // Named, not just present: an icon carries nothing to a screen reader and
    // there is no menu and no keymap here to reach it by instead.
    expect(trigger!.getAttribute("aria-label")).toBe("@seyi — account menu");

    const box = window.getComputedStyle(trigger!);
    expect(Number.parseFloat(box.width)).toBeGreaterThanOrEqual(layout.minTouchTarget);
    expect(Number.parseFloat(box.height)).toBeGreaterThanOrEqual(layout.minTouchTarget);

    app.press(trigger);
    const signOut = document.body.querySelector<HTMLElement>('[data-testid="account-sign-out"]');
    expect(signOut).not.toBeNull();
    expect(signOut!.textContent).toContain("Sign out");

    app.unmount();
    mockConsoleState.pathname = "/console/@seyi";
  });

  test("and a pointer layout reaches it in the switcher instead", () => {
    /*
      The positive control for the move: sign-out is not deleted, it is the
      other density's answer, and a rewrite that lost it would pass every
      assertion above.

      **It used to be `rail-sign-out`, at the foot of the rail's account
      block.** The rail folded into `SwitcherMenu`, so this density's route is
      the same shape the phone's already was — open the control under your own
      name, then choose — and `AccountBlock`'s `compact` menu stays the phone's
      alone.
    */
    const app = mountConsole(1440);
    expect(app.find("rail-sign-out")).toBeNull();
    expect(app.find("account-menu")).toBeNull();

    app.press(app.find("frame-switcher"));
    const signOut = app.find("switcher-sign-out");
    expect(signOut).not.toBeNull();
    expect(signOut!.textContent).toContain("Sign out");

    app.unmount();
  });
});
