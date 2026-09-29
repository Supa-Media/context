import { expect, test } from "@playwright/test";

/*
  "Preview demo" (Dev2, 2026-09-29: "the play button for cast does not
  work"). The console opens `/#cast-preview=<draft>`; the homepage must draw
  that draft as its only page and play its cast, and a reload plays it again.
*/

test("the homepage plays a previewed draft's cast", async ({ page }) => {
  const markdown = [
    "# Pricing preview",
    "",
    "- unlimited members",
    "",
    "```cast",
    "@jon adds a line below: - clearer skin",
    "```",
    "",
  ].join("\n");
  const encoded = await page.evaluate(
    (body) => {
      const bytes = new TextEncoder().encode(body);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
    JSON.stringify({ title: "Pricing preview", markdown }),
  );
  await page.goto(`/#cast-preview=${encoded}`);
  const content = page.locator(".cm-content").first();
  await expect(content).toContainText("Pricing preview", { timeout: 15_000 });
  await expect(content).toContainText("clearer skin", { timeout: 15_000 });
  await expect(content).not.toContainText("```cast");
  await expect(content).toContainText("Preview of an unpublished draft");

  await page.reload();
  await expect(content).toContainText("Pricing preview", { timeout: 15_000 });
  await expect(content).toContainText("clearer skin", { timeout: 15_000 });
});
