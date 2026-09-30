import { expect, test, type Page } from "@playwright/test";

/*
  A scene in a chat (Dev2, 2026-09-30): "I want people to be able to see how
  their folder structure changes in real time as they chat with claude or chat
  gpt or both … seeing folders move, notes get renamed, project items status
  getting updated in list view all in real time".
*/

async function preview(page: Page, lines: readonly string[]) {
  const markdown = ["# Chat scene", "", "Welcome in.", "", "```cast", ...lines, "```", ""].join("\n");
  const encoded = await page.evaluate(
    (body) => {
      const bytes = new TextEncoder().encode(body);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
    JSON.stringify({ title: "Chat scene", markdown }),
  );
  await page.goto(`/#cast-preview=${encoded}`);
}

const SCENE = [
  "pace: fast",
  "@maya asks Claude: keep track of the beta",
  "Claude answers: On it.",
  "Claude adds folder: 1-projects/beta-launch",
  "Claude adds folder: 1-projects/website",
  "Claude marks website as: to do",
  "Claude marks beta-launch as: to do",
  "Claude adds note: 1-projects/beta-launch/decisions",
  "  - Beta ships Oct 14",
  "Claude renames 1-projects/beta-launch/decisions to: launch decisions",
  "@maya asks ChatGPT: and plan the week",
  "ChatGPT answers: Planned.",
  "@maya opens: 1-projects",
  "Claude marks beta-launch as: in progress",
  "Claude moves website into: 4-archive",
  "Claude answers: Done.",
];

test.describe("side by side, on a wide screen", () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test("the chat and the workspace change together", async ({ page }) => {
    // Sixteen steps played at their real pace: longer than the default budget.
    test.setTimeout(90_000);
    await preview(page, SCENE);
    const claude = page.getByTestId("cast-chat-Claude");
    await expect(claude).toContainText("keep track of the beta", { timeout: 20_000 });
    await expect(claude).toContainText("On it.");
    await expect(claude).toContainText("Used Context", { timeout: 15_000 });
    await expect(claude).toContainText("Added folder");

    // Two apps side by side, not a chat panel inside Context (Dev2,
    // 2026-09-30): Context has its own window, apart from the chat's, and says
    // which assistant is reaching it from the chat.
    await expect(page.getByTestId("cast-workspace-bar")).toContainText("Claude, from chat");
    const chatBox = (await claude.boundingBox())!;
    const contextBox = (await page.getByTestId("cast-workspace-bar").boundingBox())!;
    expect(contextBox.x).toBeGreaterThan(chatBox.x + chatBox.width + 8);
    // Sized by its window, not the screen: its bottom edge is on the page.
    const frame = (await page.getByTestId("app-frame").boundingBox())!;
    expect(frame.y + frame.height).toBeLessThanOrEqual(800 - 8);

    // The tree takes each step as it lands.
    const tree = page.getByRole("tree").first();
    await expect(tree).toContainText("beta-launch", { timeout: 15_000 });
    await expect(tree).toContainText("launch decisions", { timeout: 15_000 });

    // Both assistants, one window each.
    await expect(page.getByTestId("cast-chat-ChatGPT")).toContainText("Planned.", { timeout: 15_000 });

    // The projects folder's List, and a status moving as it is set.
    const row = page.getByTestId("folder-item").filter({ hasText: "Beta launch" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(claude).toContainText("Marked Beta launch as in progress", { timeout: 15_000 });
    await expect(row).toContainText(/in progress/i);
    await expect(claude).toContainText("Moved Website into Archive", { timeout: 15_000 });
    // The tree names folders without their number: `4-archive` is "archive".
    await expect(tree).toContainText(/archive\s*website/);
    await expect(claude).toContainText("Done.", { timeout: 15_000 });
  });
});

test("on a phone the chat sits above the workspace", async ({ page }) => {
  await preview(page, ["@maya asks Claude: keep track of the beta", "Claude answers: On it."]);
  const claude = page.getByTestId("cast-chat-Claude");
  await expect(claude).toContainText("On it.", { timeout: 20_000 });
  const chat = await claude.boundingBox();
  const note = await page.locator(".cm-content").first().boundingBox();
  expect(chat).not.toBeNull();
  expect(note).not.toBeNull();
  expect(chat!.y + chat!.height).toBeLessThanOrEqual(note!.y + 1);
});

test("a visitor can close the chat", async ({ page }) => {
  await preview(page, ["@maya asks Claude: hi", "Claude answers: Hello."]);
  await expect(page.getByTestId("cast-chat-Claude")).toContainText("Hello.", { timeout: 20_000 });
  await page.getByTestId("cast-chat-close").click();
  await expect(page.getByTestId("cast-chat")).toHaveCount(0);
});
