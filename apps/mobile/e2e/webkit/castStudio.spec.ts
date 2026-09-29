import { expect, test, type Page } from "@playwright/test";

/*
  The cast studio (Dev2, 2026-09-29): "Preview demo" opens a studio whose
  stage is the homepage playing the draft. The stage must wait for Play, show
  no preview line and no join card (both would be in the recording), follow
  pause, and play from a step when its row is pressed.
*/

const PAGE = "/e2e-fixture?screen=cast-studio";

function stage(page: Page) {
  return page.frameLocator('[data-testid="studio-stage"] iframe').locator(".cm-content").first();
}

test("the studio plays the scene on a stage, only when told", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(PAGE);
  await expect(page.getByTestId("cast-studio")).toBeVisible({ timeout: 20_000 });
  const content = stage(page);
  await expect(content).toContainText("Free is free, you cheapo.", { timeout: 20_000 });
  await expect(content).not.toContainText("Preview of an unpublished draft");
  await expect(page.frameLocator('[data-testid="studio-stage"] iframe').getByText("Join the waitlist")).toHaveCount(0);

  // Nothing plays before Play: the stage waits for the studio.
  await page.waitForTimeout(3_000);
  await expect(content).not.toContainText("this page is live");

  await page.getByTestId("studio-play").click();
  await expect(content).toContainText("this page is live", { timeout: 15_000 });
  await expect(page.getByTestId("studio-play")).toHaveAttribute("aria-label", "Pause");

  await page.getByTestId("studio-play").click();
  await expect(page.getByTestId("studio-play")).toHaveAttribute("aria-label", "Play");
});

test("a row plays from its step, with the earlier steps already done", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(PAGE);
  await expect(page.getByTestId("cast-studio")).toBeVisible({ timeout: 20_000 });
  await expect(stage(page)).toContainText("Free is free", { timeout: 20_000 });

  await page.getByTestId("studio-step-2").click();
  // The step before landed at once; the reply is on its way.
  await expect(stage(page)).toContainText("this page is live", { timeout: 15_000 });
  await expect(page.getByTestId("studio-step-2")).toHaveAttribute("aria-current", "step", { timeout: 15_000 });
});

test("frames change the stage's shape, and Record leaves nothing but the stage", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(PAGE);
  await expect(page.getByTestId("cast-studio")).toBeVisible({ timeout: 20_000 });

  const shape = async () => {
    const box = await page.getByTestId("studio-stage").boundingBox();
    return box === null ? 0 : box.width / box.height;
  };
  await expect.poll(shape).toBeCloseTo(16 / 9, 1);
  await page.getByTestId("studio-frame-phone").click();
  await expect.poll(shape).toBeCloseTo(9 / 16, 1);
  await page.getByTestId("studio-frame-square").click();
  await expect.poll(shape).toBeCloseTo(1, 1);

  await page.getByTestId("studio-record").click();
  await expect(page.getByText("Ready to record")).toBeVisible();
  await expect(page.getByTestId("studio-record-start")).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId("studio-record-start").click();
  await expect(page.getByText("Ready to record")).toHaveCount(0);
  await expect(page.getByTestId("studio-play")).toHaveCount(0);
  await expect(stage(page)).toContainText("this page is live", { timeout: 20_000 });
  await expect(page.getByText("Done. Stop your recorder.")).toBeVisible({ timeout: 45_000 });

  await page.keyboard.press("Escape");
  await expect(page.getByText("Done. Stop your recorder.")).toHaveCount(0);
  await expect(page.getByTestId("studio-play")).toBeVisible();
});
