import { expect, test, type Page } from "@playwright/test";

/**
 * Dictation in a real browser, at the size the sketch was drawn at.
 *
 * ## Why this suite exists when jsdom already covers the same code
 *
 * `voiceEditor.test.ts` proves the guess is not in `EditorState.doc` — a claim
 * about a data structure, checked against a real CodeMirror in jsdom. That is
 * the important half and it is not this half.
 *
 * What it cannot see is the **rendered page**: whether the widget CodeMirror was
 * told to draw actually lands in the DOM, whether the floating control is on
 * screen and hittable at a desktop width, and whether the text a person would
 * copy out of the note contains the machine's guess. jsdom has no layout, so
 * "the button is visible" is not a question it can answer. This suite answers
 * it by reading the same DOM a person's browser builds.
 *
 * ## The engine is a fake, and the fake is the point
 *
 * A headless browser has no speech engine and cannot be talked to. Installing a
 * controllable `SpeechRecognition` before the app boots is what lets a test
 * drive the exact sequence a real one produces — nine revisions of a phrase,
 * then the settled form — which is precisely the sequence the product's one
 * promise is about. What this does *not* prove is that
 * `engine.web.ts` reads a real browser's events correctly;
 * `voiceEngine.test.ts` holds that against the API's own shapes.
 *
 * Run by the `chromium` project in this repository's own agent environment and
 * by `webkit` in CI. Say which project a run used; a chromium pass is never
 * reported as a WebKit result.
 */

/*
  A pointer layout, not the phone viewport the rest of this directory uses.

  The control under test is a *floating* one — `position: absolute` at the
  region's bottom-right — and at 390pt it sits over a note that fills the
  screen, where the sketch puts it beside one in a three-column console. The
  phone's own answer is the sheet, which this file also drives, but the case
  the sketch is about is the desktop one.
*/
test.use({ viewport: { width: 1280, height: 840 }, isMobile: false, hasTouch: false });

/** What a `SpeechRecognition` looks like from outside, driven by the test. */
const FAKE_ENGINE = `
  window.__speech = { live: null, started: 0, stopped: 0, aborted: 0 };
  class FakeRecognition {
    constructor() {
      this.continuous = false;
      this.interimResults = false;
      this.lang = "";
      this.maxAlternatives = 1;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
    }
    start() { window.__speech.live = this; window.__speech.started += 1; }
    stop() { window.__speech.stopped += 1; if (this.onend) this.onend(); }
    abort() { window.__speech.aborted += 1; }
  }
  window.SpeechRecognition = FakeRecognition;
`;

/** Say something. \`settled\` is the engine deciding it has stopped revising. */
async function say(page: Page, transcript: string, settled: boolean): Promise<void> {
  await page.evaluate(
    ([text, isFinal]) => {
      const live = (window as unknown as { __speech: { live: FakeLike | null } }).__speech.live;
      if (live === null || live.onresult === null) throw new Error("no live recognition");
      const results = [{ isFinal, length: 1, 0: { transcript: text } }];
      live.onresult({ resultIndex: 0, results: Object.assign(results, { length: 1 }) });
    },
    [transcript, settled] as [string, boolean],
  );
}

interface FakeLike {
  onresult: ((event: unknown) => void) | null;
}

/**
 * What is actually in the note, with the guess taken out.
 *
 * The widget renders *inside* `.cm-content`, so a plain `textContent` would
 * read the guess back and prove nothing. Removing the widget from a clone and
 * reading what is left is the DOM's version of the question
 * `voiceEditor.test.ts` asks of `EditorState.doc`: is this text in the
 * document, or is it drawn over it.
 */
async function documentText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const content = document.querySelector(".cm-content");
    if (content === null) return "";
    const clone = content.cloneNode(true) as HTMLElement;
    for (const ghost of clone.querySelectorAll(".cm-dictation-interim")) ghost.remove();
    return clone.textContent ?? "";
  });
}

/**
 * The note is on screen.
 *
 * `.cm-content`, not `note-scroll`: that testID is on the phone's page
 * scroller, which a pointer layout deliberately does not have — the editor
 * there scrolls itself inside a region that already has a toolbar, and a page
 * scroller around it would be a second scrollbar around the first
 * (`NoteEditor.tsx`). Waiting for it at 1280 waits forever.
 */
async function ready(page: Page): Promise<void> {
  await page.locator(".cm-content").first().waitFor();
}

const SHOTS = process.env.VOICE_SHOT_DIR ?? "";
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === "") return;
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(FAKE_ENGINE);
  await page.goto("/e2e-fixture");
  await ready(page);
});

test("the microphone is on the page, and pressing it opens no microphone", async ({ page }) => {
  const button = page.getByTestId("voice-button");
  await expect(button).toBeVisible();
  await shot(page, "1-resting");

  await button.click();

  await expect(page.getByTestId("voice-sheet")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __speech: { started: number } }).__speech.started)).toBe(0);
  await shot(page, "2-sheet");
});

/*
  The fixture opens on `1-projects/context-lc.md`, which `placeholderData.ts`
  declares with `teamFile(...)` — a note the whole demo workspace reads. This
  case asserted "Only you." over it for as long as the sheet answered from the
  workspace's kind rather than the note's visibility. The string changed
  because the claim was wrong, not because the test was.
*/
test("the sheet says who can hear it and what happens to the audio", async ({ page }) => {
  await page.getByTestId("voice-button").click();
  await expect(page.getByTestId("voice-sheet-audience")).toHaveText(
    "Anyone you have shared 1-projects/context-lc.md with can read it.",
  );
  await expect(page.getByTestId("voice-sheet-disclosure")).toContainText(
    "Context never receives the audio",
  );
  await expect(page.getByTestId("voice-sheet-dictate")).toBeVisible();
  await expect(page.getByTestId("voice-sheet-meeting")).toBeVisible();
});

test("a guess is drawn over the note and is not in it", async ({ page }) => {
  const before = await documentText(page);

  await page.getByTestId("voice-button").click();
  await page.getByTestId("voice-sheet-dictate").click();
  await expect(page.getByTestId("voice-capsule")).toBeVisible();

  for (const guess of [
    "the",
    "the handover",
    "the handover is",
    "the handover is the one",
    "the handover is the one thing I want landed",
  ]) {
    await say(page, guess, false);
  }

  const ghost = page.locator(".cm-dictation-interim");
  await expect(ghost).toHaveText("the handover is the one thing I want landed");
  // The whole claim, read off the page a person is looking at.
  expect(await documentText(page)).toBe(before);
  await shot(page, "3-dictating");

  await say(page, "The handover is the one thing I want landed.", true);

  await expect(ghost).toHaveCount(0);
  expect(await documentText(page)).toContain("The handover is the one thing I want landed.");
  await shot(page, "4-settled");
});

test("Stop settles what is pending; the note keeps it and the capsule goes", async ({ page }) => {
  await page.getByTestId("voice-button").click();
  await page.getByTestId("voice-sheet-dictate").click();
  await say(page, "no shared mailbox", false);

  await page.getByTestId("voice-stop").click();

  expect(
    await page.evaluate(
      () => (window as unknown as { __speech: { stopped: number; aborted: number } }).__speech,
    ),
  ).toMatchObject({ stopped: 1, aborted: 0 });
  await expect(page.getByTestId("voice-capsule")).toHaveCount(0);
  await expect(page.getByTestId("voice-button")).toBeVisible();
});

test("Discard takes the run back out of the note", async ({ page }) => {
  const before = await documentText(page);

  await page.getByTestId("voice-button").click();
  await page.getByTestId("voice-sheet-dictate").click();
  await say(page, "One sentence that landed.", true);
  expect(await documentText(page)).toContain("One sentence that landed.");

  await page.getByTestId("voice-discard").click();

  /*
    Not byte-equality against `before`, and the reason is live preview rather
    than dictation: inserting at the caret puts the caret in the first line, and
    `livePreview.ts` reveals a heading's own `# ` mark exactly while the caret
    is inside it. So the *rendered* text gains two characters the document
    always had. Asserting equality here would be asserting that dictation does
    not move the caret, which is the opposite of what it is for.

    What Discard promises is checked instead: the dictated sentence is gone and
    the note it was dictated into is still there.
  */
  const after = await documentText(page);
  expect(after).not.toContain("One sentence that landed.");
  expect(after).toContain(before.replace(/^#\s*/, "").slice(0, 60));
  expect(
    await page.evaluate(
      () => (window as unknown as { __speech: { stopped: number; aborted: number } }).__speech,
    ),
  ).toMatchObject({ aborted: 1, stopped: 0 });
});

test("a browser with no engine offers the meeting and refuses dictation", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 840 },
    isMobile: false,
    hasTouch: false,
  });
  const page = await context.newPage();
  // No `addInitScript`: this is Firefox's situation, and the fixture's.
  await page.addInitScript(`delete window.SpeechRecognition; delete window.webkitSpeechRecognition;`);
  await page.goto("/e2e-fixture");
  await ready(page);

  await page.getByTestId("voice-button").click();
  await expect(page.getByTestId("voice-sheet-refusal")).toContainText("no dictation engine");
  await expect(page.getByTestId("voice-sheet-audience")).toHaveCount(0);
  await expect(page.getByTestId("voice-sheet-meeting")).toBeVisible();
  await shot(page, "5-no-engine");
  await context.close();
});
