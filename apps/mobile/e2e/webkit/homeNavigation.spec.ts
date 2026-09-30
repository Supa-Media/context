import { expect, test, type Page } from "@playwright/test";

/*
  The homepage on a phone, as a visitor moves around it.

  1. Every page is a push of `/?page=…`, and each push used to mount a new
     copy of the route's screen, which started its history empty. The
     homepage is drawn by `app/(home)/_layout.tsx`, which outlives those
     pushes, so the browser's Back walks the pages of one visit.
  2. The way between pages is Home (2026-09-30, the Apple Notes board): the
     path bar's workspace chip opens it, and it lists every page — the site's
     loose pages under Notes, since they are in no folder. The bottom bar is
     search and a new note, nothing else.
  3. The homepage's cast opened the comment sheet over the page on every
     comment step. On a phone the highlight is the whole event; a tap on it
     opens the thread.

  With no site in the page, the homepage draws its built-in pages after a
  short wait (`useHomeSite`); the second test puts a site in the HTML the way
  the router does, so the cast has a comment to play.
*/

const content = (page: Page) => page.locator(".cm-content").first();

async function openFromHome(page: Page, title: string): Promise<void> {
  await page.getByLabel("@context, the context you are in — open its root", { exact: true }).click();
  const home = page.getByTestId("phone-home");
  await expect(home).toBeVisible();
  await home.getByRole("button", { name: title }).last().click();
  await expect(home).toHaveCount(0);
  await expect(content(page)).toContainText(title);
}

test("Home reaches every page, and Back walks the pages a visitor opened", async ({ page }) => {
  await page.goto("/");
  await expect(content(page)).toContainText("Notes for your team", { timeout: 15_000 });
  await expect(page.getByRole("toolbar", { name: "Search and new note" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Browse files" })).toHaveCount(0);

  await openFromHome(page, "How it works");
  await openFromHome(page, "Pricing");
  await expect(page).toHaveURL(/\?page=pricing$/);

  // The browser's own Back stays inside one visit, a page at a time.
  await page.goBack();
  await expect(page).not.toHaveURL(/\?page=pricing$/);
  await expect(page).toHaveURL(/^[^?]*\/(\?page=[a-z-]+)?$/);
});

test("a cast comment on a phone shows its highlight and waits for a tap", async ({ page }) => {
  const markdown = [
    "---",
    "title: Welcome",
    "nav: 0",
    "---",
    "",
    "# Welcome",
    "",
    "Context is free for everyone to try.",
    "",
    "```cast",
    'Codex comments on "free for everyone": a little bold?',
    "```",
    "",
  ].join("\n");
  const site = {
    siteName: "context",
    revision: "e2e",
    pages: [{ path: "website/index.md", routePath: "/", title: "Welcome", markdown }],
    emoji: {},
    images: {},
  };
  await page.route(/\/$/, async (route) => {
    const response = await route.fetch();
    const html = (await response.text()).replace(
      "</head>",
      `<script type="application/json" id="context-home-site">${JSON.stringify(site)}</script></head>`,
    );
    await route.fulfill({ response, body: html });
  });
  await page.goto("/");

  const highlight = page.locator(".cm-cmt-hl").first();
  await expect(highlight).toBeVisible({ timeout: 15_000 });
  // Give a sheet every chance to open on its own before saying it did not.
  await page.waitForTimeout(1_000);
  await expect(page.locator(".cm-cmt-sheet-layer:not([hidden])")).toHaveCount(0);

  await highlight.tap();
  await expect(page.locator(".cm-cmt-sheet-layer:not([hidden])")).toHaveCount(1);
  await expect(page.getByText("a little bold?")).toBeVisible();
});
