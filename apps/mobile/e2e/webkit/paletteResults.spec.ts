import { expect, test } from "@playwright/test";

/**
 * ⌘K'S ANSWERS SAY WHY, AND ⌘K IS THE ONLY SEARCH.
 *
 * Boards A and B1 (leadership weekly, 2026-10-17): every answer is three
 * lines (name and reason, two lines of matched words in bold, where and when),
 * the highlighted one reads beside the list on a wide window, and Tab narrows
 * the tree, which is what the tree's own filter field did before it went.
 * Layout claims, so a real engine: `?screen=palette-results` is invented notes
 * (`features/e2e/PaletteResultsFixture.tsx`) and reaches no account.
 */

const SCREEN = "/e2e-fixture?screen=palette-results";

test.describe("on a wide window", () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

  test("rows are three fixed lines, with the reason in words that count", async ({ page }) => {
    await page.goto(SCREEN);
    await page.getByRole("textbox").fill("launch pricing plan");
    const rows = page.getByRole("option");
    await expect(rows).toHaveCount(4);
    const heights = await rows.evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
    expect(new Set(heights)).toEqual(new Set([92]));
    await expect(page.getByTestId("palette-why").nth(1)).toHaveText("Has all 3 words");
    await expect(page.getByTestId("palette-why").nth(2)).toHaveText("Has 2 of 3 words");
    // The typed words are bold inside the snippet; no row carries a boxed tag.
    const weight = await page.getByTestId("palette-snippet").first().locator("span").first().evaluate((node) => getComputedStyle(node).fontWeight);
    expect(Number(weight)).toBeGreaterThanOrEqual(600);
    const border = await page.getByTestId("palette-why").first().evaluate((node) => getComputedStyle(node).borderTopWidth);
    expect(border).toBe("0px");
  });

  test("the highlighted answer reads beside the list, and follows the arrows", async ({ page }) => {
    await page.goto(SCREEN);
    await page.getByRole("textbox").fill("launch pricing plan");
    const preview = page.getByTestId("note-preview");
    await expect(preview).toContainText("One tier at launch.");
    // Front matter and link brackets are not words to read.
    await expect(preview).not.toContainText("status: active");
    await expect(preview).not.toContainText("[[");
    for (let step = 0; step < 3; step += 1) await page.keyboard.press("ArrowDown");
    await expect(preview).toContainText("This note is encrypted.");
  });

  test("Tab narrows the tree to the names typed", async ({ page }) => {
    await page.goto(SCREEN);
    await page.getByRole("textbox").fill("pricing");
    await expect(page.getByTestId("palette-narrow-tree")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("fixture-narrowed")).toHaveText("pricing");
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("rows keep their three lines, with no preview and no Tab", async ({ page }) => {
    await page.goto(SCREEN);
    await page.getByRole("textbox").fill("launch pricing plan");
    await expect(page.getByRole("option")).toHaveCount(4);
    await expect(page.getByTestId("note-preview")).toHaveCount(0);
    await expect(page.getByTestId("palette-narrow-tree")).toHaveCount(0);
    const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(pageWidth).toBeLessThanOrEqual(390);
  });
});

/**
 * NAMES FIRST, AND NOTHING MOVES WHEN THE SEARCH ANSWERS (the search tune-up,
 * boards M1, M2 and P1, 2026-10-27). `names=1` draws a name the tree holds at
 * once, answers 800 ms later, and includes two notes found only by meaning.
 */
const NAMES = "/e2e-fixture?screen=palette-results&names=1";

for (const [where, viewport] of [
  ["a wide window", { width: 1440, height: 900 }],
  ["a phone", { width: 390, height: 844 }],
] as const) {
  test.describe(`names first, on ${where}`, () => {
    test.use({ viewport });

    test("the name drawn at once stays on top when the answer lands, and meaning folds", async ({ page }) => {
      await page.goto(NAMES);
      await page.getByRole("textbox").fill("launch pricing plan");
      const rows = page.getByRole("option");
      await expect(rows.first()).toContainText("Launch pricing plan checklist");
      await expect(page.getByText("2 more about the same topic")).toBeVisible();
      await expect(rows.first()).toContainText("Launch pricing plan checklist");
      // Four answers, the folded line, and the name the tree held.
      await expect(rows).toHaveCount(6);
      await expect(page.getByText("Notes on freemium", { exact: true })).toHaveCount(0);
      await page.getByText("2 more about the same topic").click();
      await expect(page.getByText("Notes on freemium", { exact: true })).toBeVisible();
      await expect(rows.first()).toContainText("Launch pricing plan checklist");
      const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(pageWidth).toBeLessThanOrEqual(viewport.width);
    });
  });
}
