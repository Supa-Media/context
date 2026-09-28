import { expect, test } from "@playwright/test";
import { openWeeklyReview } from "./helpers";

/**
 * The small browser proof for app-shell and packaging changes that do not
 * touch the editor, plugin runtime, offline shell or another full-suite owner.
 * It uses the built export and real WebKit, walks the shipping file tree, and
 * opens a real fixture note. The full suite owns feature-specific behavior.
 */
test("the built app boots, navigates its tree and renders a note", async ({ page }) => {
  await openWeeklyReview(page);
  await expect(page.getByTestId("breadcrumb-leaf")).toHaveText("Weekly review");
  await expect(page.getByTestId("note-scroll")).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("Weekly review");
});
