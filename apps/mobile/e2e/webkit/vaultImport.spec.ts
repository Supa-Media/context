import { mkdir, writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("a chosen directory reaches the ready state and uploads", async ({
  page,
}, testInfo) => {
  const vault = testInfo.outputPath("My Vault");
  await mkdir(`${vault}/Notes`, { recursive: true });
  await writeFile(`${vault}/Notes/hello.md`, "# Hello\n");
  await writeFile(`${vault}/cover.png`, Buffer.from([137, 80, 78, 71]));

  await page.goto("/e2e-fixture?screen=vault-import");
  await page.getByTestId("fixture-vault-merge").click();

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("fixture-vault-choose").click();
  const chooser = await chooserPromise;
  await expect(page.getByText("Reading the selected folder…", { exact: true })).toBeVisible();
  await chooser.setFiles(vault);

  await expect(
    page.getByText("Ready to upload", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/2 files ·/)).toBeVisible();
  await expect(
    page.getByText("Destination: existing folder paths", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Keep this tab open during the upload/),
  ).toBeVisible();

  await page.getByTestId("fixture-vault-upload").click();
  await expect(
    page.getByText(/Import complete\. 2 files uploaded/),
  ).toBeVisible();
});
