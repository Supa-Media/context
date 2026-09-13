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

test("replacement accepts the destructive acknowledgement regardless of casing", async ({
  page,
}, testInfo) => {
  const vault = testInfo.outputPath("Replacement Vault");
  await mkdir(vault, { recursive: true });
  await writeFile(`${vault}/new.md`, "# New\n");

  await page.goto("/e2e-fixture?screen=vault-import");
  await page.getByTestId("fixture-vault-replace").click();

  await expect(page.getByText(
    "This permanently deletes every existing file in this bucket.",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByText(/Context cannot undo this/)).toBeVisible();
  await expect(page.getByTestId("fixture-vault-choose")).toHaveCount(0);

  const confirmation = page.getByTestId("fixture-vault-replace-confirmation");
  await confirmation.fill("I understand this");
  await expect(page.getByTestId("fixture-vault-choose")).toHaveCount(0);
  await confirmation.fill("  i UnDeRsTaNd  ");
  await expect(page.getByTestId("fixture-vault-choose")).toBeVisible();

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId("fixture-vault-choose").click();
  const chooser = await chooserPromise;
  await chooser.setFiles(vault);
  await expect(page.getByText(
    "Destination: replaces every file in this bucket",
    { exact: true },
  )).toBeVisible();
  await page.getByTestId("fixture-vault-upload").click();
  await expect(page.getByText(/Import complete\. 1 file uploaded/)).toBeVisible();
});
