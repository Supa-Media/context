import { expect, test, type Page } from "@playwright/test";

/*
  The homepage on a phone, as a visitor moves around it (Dev2, 2026-09-28).

  1. `‹` and Recent stayed dimmed however many pages somebody opened. Every
     page is a push of `/?page=…`, and each push mounted a new copy of the
     route's screen, which started its history empty. The homepage is now
     drawn by `app/(home)/_layout.tsx`, which outlives those pushes.
  2. The homepage's cast opened the comment sheet over the page on every
     comment step. On a phone the highlight is the whole event; a tap on it
     opens the thread.

  With no site in the page, the homepage draws its built-in pages after a
  short wait (`useHomeSite`); the second test puts a site in the HTML the way
  the router does, so the cast has a comment to play.
*/

const content = (page: Page) => page.locator(".cm-content").first();

test("back and Recent follow the pages a visitor opened", async ({ page }) => {
  await page.goto("/");
  await expect(content(page)).toContainText("Notes for your team", { timeout: 15_000 });
  const back = page.getByRole("button", { name: "Go back" }).first();
  const recent = page.getByRole("button", { name: "Recently opened" }).first();
  await expect(back).toHaveAttribute("aria-disabled", "true");

  for (const title of ["How it works", "Pricing"]) {
    await page.getByRole("button", { name: "Browse this folder" }).first().click();
    await page.getByText(title, { exact: true }).first().click();
    await expect(content(page)).toContainText(title);
  }
  await expect(page).toHaveURL(/\?page=pricing$/);
  await expect(back).not.toHaveAttribute("aria-disabled", "true");
  await expect(recent).not.toHaveAttribute("aria-disabled", "true");

  // The browser's own Back lands on the page before, still inside one visit.
  await page.goBack();
  await expect(page).toHaveURL(/\?page=how-it-works$/);
  await expect(content(page)).toContainText("How it works");

  // And the bar's ‹ walks the same pages.
  await back.click();
  await expect(content(page)).toContainText("Notes for your team");
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
