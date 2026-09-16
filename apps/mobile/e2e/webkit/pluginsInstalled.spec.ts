import { expect, test } from "@playwright/test";
import { tap } from "./helpers";

/**
 * The plugins panel, opened in a real browser, with a plugin already installed
 * and no scan having been run.
 *
 * ## The bug, as a person hit it
 *
 * Install a plugin. Come back the next day. The panel that installs plugins
 * named none of them — it rested at "read the plugins in this bucket", and the
 * registry beside it, with no inventory to compare against, offered Install on
 * the row that was already installed. So it got installed again, and the report
 * was that installs do not persist. They always had; nothing had ever read
 * them back.
 *
 * `pluginsPanel.test.ts` holds the same properties in jsdom. This is the one
 * that looks at the screen a person actually opens, in the state they actually
 * arrive in, which is the state the jsdom suite was green through for months.
 */

const ACCOUNT_MENU = "@seyi — account menu";
const ACCOUNT_SETTINGS = "account-settings";

async function openPlugins(page: import("@playwright/test").Page) {
  await page.goto("/e2e-fixture");
  await page.getByTestId("breadcrumb-leaf").waitFor();
  await tap(page, ACCOUNT_MENU);
  await page.getByTestId(ACCOUNT_SETTINGS).tap();
  // The list is one press back from whatever section opened first.
  const back = page.getByLabel("Back", { exact: true });
  if (await back.count()) await back.tap();
  await page.getByTestId("settings-section-plugins").tap();
  await page.getByTestId("plugins-panel").waitFor();
}

test("an installed plugin is named on arrival, with nothing pressed", async ({ page }) => {
  await openPlugins(page);

  // The state a first visit is in: no scan has run, and it still says what is
  // installed. Both halves, because either alone is the bug in one direction.
  await expect(page.getByTestId("plugins-idle")).toBeVisible();
  const installed = page.getByTestId("plugins-installed");
  await expect(installed).toBeVisible();
  await expect(installed).toContainText("obsidian-bible-reference 26.08.07");

  /*
    And no verdict is claimed for it. A pointer read cannot know whether a
    plugin runs, and printing the scan's vocabulary here would be the overclaim
    the whole verdict system exists to avoid.
  */
  await expect(installed).not.toContainText("Runs here");
  await expect(installed).not.toContainText("Won't run");
});

test("the panel no longer says it only reads Obsidian's folder", async ({ page }) => {
  await openPlugins(page);
  /*
    The copy was every sentence on this screen, and it is why the bug was read
    as "Context ignores its own plugins folder". Both directories are named
    where the scan is offered.
  */
  const idle = page.getByTestId("plugins-idle");
  await expect(idle).toContainText(".context/plugins/");
  await expect(idle).toContainText(".obsidian/plugins/");
});
