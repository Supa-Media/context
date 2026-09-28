import { expect, test } from "@playwright/test";

/*
  A screenshot pasted into a homepage page (Dev2, 2026-09-28). It drew in the
  editor and showed "Not in this bucket" on the published homepage, because
  the site loads no images and the homepage's workspace had none to give. The
  page's pictures now come with the site in the HTML, and the editor draws
  them from there.
*/

const LEAF = "paste-be3b688afc175efb.png";
// One red pixel: a real PNG, so the browser decodes it and the row has a size.
const PICTURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

test("a pasted picture on a homepage page is drawn from the site, and the page scrolls to its end", async ({ page }) => {
  const markdown = [
    "---",
    "title: use cases",
    "nav: 0",
    "---",
    "# use cases",
    "",
    "## Onboarding",
    "A new team member keeps asking questions.",
    `![[${LEAF}|356]] <!-- context: align=center -->`,
    "",
    "",
    "## Anything Really",
    "Its really just a notes app.",
    "",
    "[home](/index) - [pricing](/pricing) - [use cases](/use-cases) - [devlog](/devlog)",
  ].join("\n");
  const site = {
    siteName: "context",
    revision: "e2e",
    pages: [{ path: "website/use-cases.md", routePath: "/", title: "use cases", markdown }],
    emoji: {},
    images: { [LEAF]: PICTURE },
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

  const picture = page.locator(".cm-lp-image-img").first();
  await expect(picture).toHaveAttribute("src", PICTURE, { timeout: 15_000 });
  await expect(page.getByText("Not in this bucket", { exact: false })).toHaveCount(0);

  const devlog = page.locator(".cm-content").getByText("devlog", { exact: true });
  await devlog.scrollIntoViewIfNeeded();
  await expect(devlog).toBeVisible();
  await page.screenshot({ path: "e2e/webkit/test-results/home-images.png" });
});
