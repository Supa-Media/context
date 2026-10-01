import { expect, test, type Page } from "@playwright/test";

/*
  A scene in a chat (Dev2, 2026-09-30): "I want people to be able to see how
  their folder structure changes in real time as they chat with claude or chat
  gpt or both … seeing folders move, notes get renamed, project items status
  getting updated in list view all in real time".
*/

async function preview(page: Page, lines: readonly string[], body: readonly string[] = []) {
  const markdown = ["# Chat scene", "", "Welcome in.", "", ...body, "```cast", ...lines, "```", ""].join("\n");
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
    // 2026-09-30): Context has its own window, apart from the chat's.
    await expect(page.getByTestId("cast-workspace-bar")).toHaveText("Context");
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

test.describe("on a phone", () => {
  // Both apps on screen (Dev2, 2026-09-30: "I'd like to show how folders and
  // things are being created as you chat"): Context above, one chat below.
  test("Context sits above the chat, and each change shows its folder", async ({ page }) => {
    test.setTimeout(60_000);
    await preview(page, [
      "pace: fast",
      "@maya asks Claude: keep track of the beta",
      "Claude answers: On it.",
      "Claude adds folder: 1-projects/beta-launch",
      "@maya asks ChatGPT: and plan the week",
      "ChatGPT answers: Planned.",
    ]);
    const claude = page.getByTestId("cast-chat-Claude");
    await expect(claude).toContainText("On it.", { timeout: 20_000 });
    const chat = (await page.getByTestId("cast-phone-chat").boundingBox())!;
    const context = (await page.getByTestId("cast-phone-context").boundingBox())!;
    expect(context.y + context.height).toBeLessThanOrEqual(chat.y + 1);
    expect(chat.y + chat.height).toBeLessThanOrEqual(844);

    // The folder the step made it in comes up in Context while it lands.
    await expect(claude).toContainText("Added folder", { timeout: 15_000 });
    await expect(page.getByTestId("app-frame")).toContainText(/beta.launch/i, { timeout: 5_000 });

    // A second assistant is a tab on the one chat window, not a third window.
    const chatgpt = page.getByTestId("cast-chat-ChatGPT");
    await expect(chatgpt).toContainText("Planned.", { timeout: 15_000 });
    await expect(page.getByTestId("cast-chat-Claude")).toHaveCount(0);
    await page.getByTestId("cast-chat-tab-Claude").click();
    await expect(page.getByTestId("cast-chat-Claude")).toContainText("On it.");
  });

  // "the cast scripting stuff [should] decide wether to go split screen, or
  // full screen on a specific app" (Dev2, 2026-09-30).
  test("one app at a time goes where the work is, and the script can cut", async ({ page }) => {
    test.setTimeout(60_000);
    await preview(page, [
      "phone: one app",
      "@maya asks Claude: keep track of the beta",
      "Claude adds folder: 1-projects/beta-launch",
      "wait 3s",
      "shows: Claude",
      "Claude answers: Done.",
      "wait 2s",
      "shows: both",
      "wait 5s",
    ]);
    const onScreen = async (id: string) => {
      const box = (await page.getByTestId(id).boundingBox())!;
      return box.x > -1 && box.x + box.width < 391;
    };
    // Somebody asking: the chat fills the phone, Context waits off the side.
    await expect(page.getByTestId("cast-chat-Claude")).toContainText("keep track", { timeout: 20_000 });
    await expect.poll(() => onScreen("cast-phone-chat"), { timeout: 5_000 }).toBe(true);
    await expect.poll(() => onScreen("cast-phone-context")).toBe(false);
    // A step in Context: the phone switches there to show it land.
    await expect.poll(() => onScreen("cast-phone-context"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => onScreen("cast-phone-chat")).toBe(false);
    // The script's own cuts.
    await expect(page.getByTestId("cast-chat-Claude")).toContainText("Done.", { timeout: 15_000 });
    await expect.poll(() => onScreen("cast-phone-chat")).toBe(true);
    await expect.poll(() => onScreen("cast-phone-context"), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => onScreen("cast-phone-chat")).toBe(true);
  });
  // "make sure that the page moves down or up to where is currently being
  // written … maya writes something under but it cant be seen" (Dev2,
  // 2026-10-01).
  test("the page follows whoever is writing", async ({ page }) => {
    test.setTimeout(60_000);
    const filler = Array.from({ length: 30 }, (_, index) => [`Paragraph ${index + 1} of the brief.`, ""]).flat();
    await preview(page, ["pace: fast", "wait 1s", "@maya writes: the very last line"], filler);
    const line = page.locator(".cm-line", { hasText: "the very last line" });
    await expect(line).toBeInViewport({ timeout: 20_000 });
    await expect(page.locator(".cm-line", { hasText: "Welcome in." })).not.toBeInViewport();
  });

  // "im not seeing comments here" (Dev2, 2026-10-01): a phone scene with no
  // chat in it has comments too, and a phone draws no margin for them.
  test("a comment comes up as a card, chat or no chat", async ({ page }) => {
    test.setTimeout(60_000);
    await preview(page, [
      "pace: fast",
      '@maya comments on "Welcome": a little short?',
      "wait 2s",
      "@jon replies: it reads fine",
      "wait 2s",
    ]);
    const card = page.getByTestId("cast-comment-card");
    await expect(card).toContainText("a little short?", { timeout: 20_000 });
    await expect(card).toContainText("Welcome");
    const box = (await card.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    // Over the note, never over the search bar at the foot of the phone.
    const search = await page.getByText("Search", { exact: true }).first().boundingBox();
    if (search !== null) expect(box.y + box.height).toBeLessThanOrEqual(search.y);
    await expect(card).toContainText("it reads fine", { timeout: 15_000 });
  });
});

test("a visitor can close the chat", async ({ page }) => {
  await preview(page, ["@maya asks Claude: hi", "Claude answers: Hello."]);
  await expect(page.getByTestId("cast-chat-Claude")).toContainText("Hello.", { timeout: 20_000 });
  await page.getByTestId("cast-chat-close").click();
  await expect(page.getByTestId("cast-chat")).toHaveCount(0);
});
