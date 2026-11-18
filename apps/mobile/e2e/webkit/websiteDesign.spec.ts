import { expect, test, type Page, type Route } from "@playwright/test";

/*
  A published website drawn in a real browser, the way a signed-out visitor
  sees it: the page's answer comes from the router's edge copy
  (`/_site/page`, `features/site/edgeAddress.ts`), here answered by the test.

  Websites have regressed to unstyled or blank in production more than once
  (#1201: the design was left out of the edge copy; #2335: a lagging
  stylesheet took the whole design off every page). Each time every unit test
  was green, because nothing checked that the CSS a site publishes is applied
  to the page a browser draws. This does: the site's own rule must change the
  computed colour of its own heading, its frame must wrap the words, and a
  page the menu names must open drawn the same way.

  The edge copy is asked only over https, where the router is the page's own
  origin, so this spec runs only with `E2E_HTTPS=1` (the browser job's https
  pass); a plain-http run skips it rather than reporting a pass it did not
  earn. Run it with the enforced CSP candidate too (`E2E_CSP_CANDIDATE=full`):
  a style policy that refuses the design's <style> fails it.
*/

const HANDLE = "e2e-site";
const SITE_RED = "rgb(200, 16, 46)";

const design = {
  frame: '<header class="site-band">Example site</header><main class="site-main">{ content }</main>',
  template: null,
  css: [
    ".ctx-site h1 { color: #c8102e; }",
    ".ctx-site .site-band { background-color: #c8102e; color: #ffffff; padding: 12px; }",
  ].join("\n"),
  fonts: [],
};

function page(routePath: string, title: string, words: string) {
  return {
    kind: "page",
    siteName: "Example site",
    routePath,
    audience: "public",
    title,
    description: null,
    markdown: `# ${title}\n\n${words}\n\n[About](/about)`,
    navigation: [
      { title: "Home", routePath: "/" },
      { title: "About", routePath: "/about" },
    ],
    design,
  };
}

const ANSWERS: Record<string, unknown> = {
  "/": page("/", "Welcome", "The home page of a designed site."),
  "/about": page("/about", "About us", "Who made this site."),
};

async function answerSitePages(browserPage: Page, answers: Record<string, unknown>): Promise<string[]> {
  const asked: string[] = [];
  await browserPage.route(/\/_site\/page\?/, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.searchParams.get("path") ?? "";
    asked.push(path);
    const answer = answers[path] ?? { kind: "unavailable", siteName: "Example site", navigation: [] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answer) });
  });
  return asked;
}

// The exported app registers its service worker, and once it controls the
// page WebKit sends the page's fetches through it, where `page.route` never
// sees them: the edge copy is then asked of the static server, misses, and
// the page waits on the fixture's unreachable Convex. The worker passes
// `/_site/page` through untouched (`public/sw.js`), so blocking it changes
// nothing this spec checks (as in `googleConnect.spec.ts`).
test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, serviceWorkers: "block" });

test.describe("a published website in the browser", () => {
  test.skip(process.env.E2E_HTTPS !== "1", "the edge copy is asked only over https: run with E2E_HTTPS=1");

  test("draws the site's own CSS and frame, and keeps them on the next page", async ({ page: browserPage }) => {
    const asked = await answerSitePages(browserPage, ANSWERS);
    await browserPage.goto(`/@${HANDLE}`);

    const site = browserPage.getByTestId("site-designed");
    await expect(site).toBeVisible({ timeout: 20_000 });
    await expect(site.locator("h1")).toHaveText("Welcome");
    // The stylesheet is applied, not merely present: its rule wins the cascade.
    await expect(site.locator("h1")).toHaveCSS("color", SITE_RED);
    // The frame wraps the words.
    await expect(site.locator(".site-band")).toHaveText("Example site");
    await expect(site.locator(".site-band")).toHaveCSS("background-color", SITE_RED);
    await expect(site.locator(".site-main h1")).toHaveCount(1);
    expect(asked).toContain("/");

    await site.getByRole("link", { name: "About" }).first().click();
    const about = browserPage.getByRole("heading", { name: "About us" });
    await expect(about).toBeVisible({ timeout: 10_000 });
    await expect(about).toHaveCSS("color", SITE_RED);
    // The page that was left is not drawn beside the new one (the router may
    // keep its screen mounted, hidden, which is why only visible parts count).
    await expect(browserPage.getByRole("heading", { name: "Welcome" })).toHaveCount(0);
    const band = browserPage.getByTestId("site-designed").filter({ visible: true }).locator(".site-band");
    await expect(band).toHaveCSS("background-color", SITE_RED);
  });

  test("a page answered without its design draws plain, and the check above would see it", async ({ page: browserPage }) => {
    // The sabotage the first test exists for, run every time: the same page
    // with no design must not have the site's colour, so a pass above means
    // the CSS was applied and not that the default look happens to match.
    const plain = { ...(ANSWERS["/"] as Record<string, unknown>) };
    delete plain.design;
    await answerSitePages(browserPage, { "/": plain });
    await browserPage.goto(`/@${HANDLE}`);
    await expect(browserPage.getByText("The home page of a designed site.")).toBeVisible({ timeout: 20_000 });
    await expect(browserPage.getByTestId("site-designed")).toHaveCount(0);
    const heading = browserPage.getByRole("heading", { name: "Welcome" }).first();
    await expect(heading).toBeVisible();
    await expect(heading).not.toHaveCSS("color", SITE_RED);
  });

  test("a page the site does not publish says so instead of drawing blank", async ({ page: browserPage }) => {
    await answerSitePages(browserPage, ANSWERS);
    await browserPage.goto(`/@${HANDLE}/no-such-page`);
    await expect(browserPage.getByText(/nothing here/i).first()).toBeVisible({ timeout: 20_000 });
  });
});
