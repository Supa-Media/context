import { expect, test, type Page } from "@playwright/test";

/**
 * THE FILE TREE'S HEADER, LIT BY A REAL POINTER.
 *
 * The column's job is to be a legible list of names. Above that list sat four
 * lit icon buttons and an empty bordered input — six boxes of chrome, at rest,
 * over a list of about twenty rows, and together the loudest thing in the
 * quietest region. So the header draws on approach: the buttons fade in when
 * the pointer enters the column, and the filter gains its border and its fill
 * at the same moment. At rest what is drawn in the field's own box is the
 * eyebrow `Notes` — the column's own name — which goes as the field arrives.
 *
 * ## Why this is here and not in the unit suite
 *
 * `__tests__/explorerChrome.test.ts` holds the resting state, which is a
 * stylesheet fact jsdom can resolve, and it holds the two structural rules that
 * make fading the right technique — the field is a real input and the buttons
 * stay in the tree, so a keyboard reaches both.
 *
 * What it cannot hold is the approach itself, and that was measured rather than
 * assumed: `View`'s `onPointerEnter` is a real pointer event and **jsdom
 * defines no `PointerEvent` constructor at all**, so a dispatched `MouseEvent`
 * named `pointerenter` reaches nothing. A test built on one would report the
 * feature broken while Chromium drew it correctly — and, worse, a test written
 * to pass against that would be asserting about an event the product never
 * sends.
 *
 * Measured in Chromium at 1440×900 before this file existed:
 *
 *     at rest   tools opacity 0, border rgba(0,0,0,0), fill rgba(0,0,0,0)
 *     hovered   tools opacity 1, border rgba(237,232,224,0.07), fill rgb(10,9,8)
 *     left      tools opacity 0, border rgba(0,0,0,0), fill rgba(0,0,0,0)
 *
 * `?screen=app-frame-visual` is the fixture that mounts the real `Explorer`
 * inside the real `AppFrame` (`features/e2e/AppFrameVisualFixture.tsx`).
 * Nothing here can reach an account or a bucket.
 */

const FRAME = "/e2e-fixture?screen=app-frame-visual";

/*
  A pointer context, declared rather than resized into — `panels.spec.ts`'s
  own note applies exactly: the suite's default is a phone with touch
  emulation, and hover on a surface the engine believes is a touchscreen is the
  behaviour under test.
*/
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

/** Is this colour nothing? react-native-web spells `transparent` as `rgba(0, 0, 0, 0)`. */
function invisible(colour: string): boolean {
  return /^(transparent|rgba\(\s*0,\s*0,\s*0,\s*0(\.0+)?\s*\))$/.test(colour.trim());
}

async function header(page: Page): Promise<{
  toolsOpacity: string;
  eyebrowOpacity: string;
  border: string;
  fill: string;
}> {
  return await page.evaluate(() => {
    const filter = document.querySelector('[data-testid="explorer-filter"]');
    const row = filter?.parentElement ?? null;
    // The group the four buttons are faded as one: the toolbar's last child.
    const tools = row?.lastElementChild ?? null;
    // The resting label, drawn over the field: the toolbar's first child.
    const eyebrow = row?.firstElementChild ?? null;
    if (filter === null || tools === null || eyebrow === null) {
      throw new Error("no explorer header on this screen");
    }
    const field = getComputedStyle(filter);
    return {
      toolsOpacity: getComputedStyle(tools).opacity,
      eyebrowOpacity: getComputedStyle(eyebrow).opacity,
      border: field.borderTopColor,
      fill: field.backgroundColor,
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto(FRAME);
  await page.getByTestId("explorer-tree").waitFor();
  // Park the pointer somewhere that is not the column, so "at rest" is a state
  // rather than wherever the previous action left it.
  await page.mouse.move(1200, 500);
});

test("at rest the header is the column's name, with no boxes in it", async ({ page }) => {
  const at = await header(page);

  expect(at.eyebrowOpacity).toBe("1");
  expect(at.toolsOpacity).toBe("0");
  expect(`border ${invisible(at.border)}`).toBe("border true");
  expect(`fill ${invisible(at.fill)}`).toBe("fill true");
});

test("the pointer entering the column lights both halves together", async ({ page }) => {
  await page.getByTestId("explorer-tree").hover();

  const on = await header(page);
  // The label gets out of the way of the field in the same move.
  expect(on.eyebrowOpacity).toBe("0");
  expect(on.toolsOpacity).toBe("1");
  expect(`border ${invisible(on.border)}`).toBe("border false");
  expect(`fill ${invisible(on.fill)}`).toBe("fill false");
});

test("and leaving it puts them away again", async ({ page }) => {
  await page.getByTestId("explorer-tree").hover();
  expect((await header(page)).toolsOpacity).toBe("1");

  // Into the note, which is the move this fades for: a pointer that has left
  // the tree is a person reading rather than filing.
  await page.mouse.move(1200, 500);

  const off = await header(page);
  expect(off.eyebrowOpacity).toBe("1");
  expect(off.toolsOpacity).toBe("0");
  expect(`border ${invisible(off.border)}`).toBe("border true");
});

test("the buttons keep their box while faded, so nothing reflows under the hand", async ({
  page,
}) => {
  /*
    The reason this is opacity rather than a mount, asserted where it can be:
    a toolbar that grew its four buttons back as the pointer arrived would move
    the filter field sideways under the hand reaching for it — and jsdom, which
    lays nothing out, cannot tell the two implementations apart.
  */
  const filter = page.getByTestId("explorer-filter");
  const before = await filter.boundingBox();

  await page.getByTestId("explorer-tree").hover();
  const after = await filter.boundingBox();

  if (before === null || after === null) throw new Error("no box for the filter field");
  expect(after.x).toBe(before.x);
  expect(after.width).toBe(before.width);
});
