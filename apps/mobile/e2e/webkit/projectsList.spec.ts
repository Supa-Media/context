import { expect, test, type Page } from "@playwright/test";

/**
 * A PROJECTS FOLDER'S LIST, LAID OUT BY A REAL ENGINE.
 *
 * Reported by the owner on 2026-09-28 with a screenshot: "the spacing here got
 * all the way messed up, I cant even read the tasks". Every project's name was
 * squeezed to "Po…" or to nothing while "0 of 4 done" wrapped onto three
 * lines, because a row's hover controls and a status column kept their width
 * whether shown or not and the name was what gave way. jsdom has no layout, so
 * nothing but a browser can hold this: the name keeps its room, the progress
 * stays one line, the controls lie over the name only while it is hovered.
 *
 * The same page holds the other two things the report asked for: a Backlog to
 * drag into (on the projects folder, the `backlog/` folder), and a side peek a
 * writer can type in. `?screen=projects` is the real `FolderView` on an
 * in-memory folder (`features/e2e/projects/`).
 */

const PAGE = "/e2e-fixture?screen=projects";

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

async function open(page: Page, query = "") {
  await page.goto(`${PAGE}${query}`);
  await page.getByTestId("folder-groups").waitFor();
}

const rowNamed = (page: Page, name: string) => page.getByTestId("folder-item").filter({ hasText: name });

test("a project's name keeps its room and its progress stays on one line", async ({ page }) => {
  await open(page);
  const rows = page.getByTestId("folder-item");
  expect(await rows.count()).toBeGreaterThanOrEqual(5);
  for (const row of await rows.all()) {
    const name = await row.getByTestId("folder-item-name").boundingBox();
    expect(name!.width).toBeGreaterThanOrEqual(140);
    const progress = row.getByTestId("folder-item-progress");
    if ((await progress.count()) === 0) continue;
    const line = await progress.boundingBox();
    // One line of the meta face, and all of it: the bar and "0/4" are never cut or wrapped.
    expect(line!.height).toBeLessThan(24);
    expect(await progress.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  }
  // A row at rest draws no hover control over its name.
  const rest = rowNamed(page, "Togather");
  await page.mouse.move(5, 5);
  await expect(rest.getByTestId("folder-row-peek")).toHaveCSS("opacity", "0");
});

test("hovering a row shows Open over the end of its name, and they stay while the pointer is on them", async ({ page }) => {
  await open(page);
  const row = rowNamed(page, "Togather");
  const before = await row.getByTestId("folder-item-name").boundingBox();
  await row.getByTestId("folder-item-label").hover();
  const peek = row.getByTestId("folder-row-peek");
  await expect(peek).toHaveCSS("opacity", "1");
  await peek.hover();
  await expect(peek).toHaveCSS("opacity", "1");
  // Shown at the end of the name, not beside it: the name's box is the same.
  expect((await row.getByTestId("folder-item-name").boundingBox())!.width).toBe(before!.width);
  // And the title is cut short of them, never drawn under them.
  const label = (await row.getByTestId("folder-item-label").boundingBox())!;
  const tools = (await row.getByTestId("folder-row-tools").boundingBox())!;
  expect(label.x + label.width).toBeLessThanOrEqual(tools.x + 1);
});

test("with the peek open, a hovered row's title still ends before its tools", async ({ page }) => {
  await open(page);
  await rowNamed(page, "Togather").getByTestId("folder-item-label").click();
  await page.getByTestId("task-panel").waitFor();
  for (const name of ["Togather", "Portal", "Software", "Context search"]) {
    const row = rowNamed(page, name).first();
    await row.getByTestId("folder-item-label").hover();
    const label = (await row.getByTestId("folder-item-label").boundingBox())!;
    const tools = (await row.getByTestId("folder-row-tools").boundingBox())!;
    expect(label.x + label.width).toBeLessThanOrEqual(tools.x + 1);
  }
  // Open, pressed, keeps the focus a click gave it, but not the pill: once the pointer leaves, the title is whole again.
  const opened = rowNamed(page, "Portal").first();
  const whole = (await opened.getByTestId("folder-item-label").boundingBox())!.width;
  await opened.getByTestId("folder-row-peek").click();
  await page.mouse.move(5, 5);
  await expect(opened.getByTestId("folder-row-peek")).toHaveCSS("opacity", "0");
  await expect.poll(async () => (await opened.getByTestId("folder-item-label").boundingBox())!.width).toBeGreaterThanOrEqual(whole);
  // A keyboard's focus showing them is proven in `__tests__/projectsListRows.test.ts`: WebKit's Tab
  // does not reach a button, so there is no keyboard route to drive here.
});

test("the priority mark opens the priorities, and a choice is written with an Undo", async ({ page }) => {
  await open(page);
  const row = rowNamed(page, "Togather");
  await row.getByTestId("folder-item-priority").click();
  for (const word of ["Urgent", "High", "Medium", "Low", "No priority"]) {
    await expect(page.getByRole("menu").getByText(word, { exact: true })).toBeVisible();
  }
  await page.getByRole("menu").getByText("Urgent", { exact: true }).click();
  await expect(page.getByTestId("fixture-toast")).toContainText("is Urgent now");
  await expect(row.getByTestId("priority-urgent")).toBeVisible();
});

test("the backlog folder is the Backlog band: its projects, a drop that moves one in, and Undo", async ({ page }) => {
  await open(page);
  const band = page.getByTestId("folder-band").first();
  await expect(band).toContainText("Backlog");
  await expect(band).toContainText("2");
  // Not drawn a second time as a note of the page.
  await expect(page.getByTestId("folder-note").filter({ hasText: /^Backlog/ })).toHaveCount(0);
  await rowNamed(page, "Context sharing").dragTo(band);
  await expect(page.getByTestId("fixture-toast")).toContainText("to Backlog");
  await expect(band).toContainText("3");
  await page.getByTestId("fixture-toast-undo").click();
  await expect(band).toContainText("2");
  await expect(rowNamed(page, "Context sharing")).toBeVisible();
});

test("a writer types in the side peek, and it is saved", async ({ page }) => {
  await open(page);
  await rowNamed(page, "Togather").getByTestId("folder-item-label").click();
  const editor = page.getByTestId("task-panel").locator(".cm-content");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" Typed beside the list.");
  await expect(page.getByTestId("fixture-save-mark")).toContainText("Saved");
  await page.getByTestId("task-panel-close").click();
  await rowNamed(page, "Togather").getByTestId("folder-item-label").click();
  await expect(page.getByTestId("task-panel")).toContainText("Typed beside the list.");
});

test("a member reads the side peek and cannot type in it", async ({ page }) => {
  await open(page, "&role=member");
  await rowNamed(page, "Togather").getByTestId("folder-item-label").click();
  await expect(page.getByTestId("task-panel-body")).toBeVisible();
  const editor = page.getByTestId("task-panel").locator(".cm-content");
  await expect(editor).not.toHaveAttribute("contenteditable", "true");
  await expect(page.getByTestId("folder-item-priority")).toHaveCount(0);
});
