import { expect, test, type Page } from "@playwright/test";

/*
  Developer casts (Dev2, 2026-10-01): Codex and Claude Code in terminals,
  running commands, editing files, asking before they run one, and updating
  the project in Context beside them, on a phone and on a wide screen ("make
  sure there is a version that looks good on desktop mode as well").
*/

const PROJECT = ["# Checkout v2", "", "Stop double charges when a payment retries.", "", "- [ ] Idempotency key on retries", "", "## Progress", ""].join("\n");

async function preview(page: Page, lines: readonly string[]) {
  const markdown = ["# Shop API", "", "The payments service.", "", "```cast", ...lines, "```", ""].join("\n");
  const pages = [{ name: "projects/checkout-v2/overview", title: "Checkout v2", markdown: PROJECT }];
  const encoded = await page.evaluate(
    (body) => {
      const bytes = new TextEncoder().encode(body);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
    JSON.stringify({ title: "Shop API", markdown, pages }),
  );
  await page.goto(`/#cast-preview=${encoded}`);
}

const SCENE = [
  "pace: fast",
  "terminal: Codex in ~/shop-api",
  "terminal: Claude Code in ~/shop-api",
  "@sam opens: projects/checkout-v2/overview",
  "@sam asks Codex: fix the double charge",
  "Codex runs: pnpm test payments",
  "  ✓ 38 passed",
  "  ✗ refunds › partial refund after retry",
  "Codex edits: payments/retry.ts",
  "  - return chargeCard(order)",
  "  + return chargeCard(order, { key: order.id })",
  "Codex ticks: Idempotency key on retries",
  "Codex adds task to checkout-v2: Fix partial refund after retry",
  "Codex marks checkout-v2 as: in progress",
  "@sam asks Claude Code: finish checkout-v2",
  "Claude Code asks to run: pnpm test refunds",
  "wait 2s",
  "@sam allows",
  "Claude Code runs: pnpm test refunds",
  "  ✓ 4 passed",
  "Claude Code marks checkout-v2 as: done",
  "Claude Code writes: Partial refunds fixed too.",
  "wait 3s",
];

async function playsThrough(page: Page) {
  const codex = page.getByTestId("cast-terminal-Codex");
  await expect(codex).toContainText("fix the double charge", { timeout: 20_000 });
  await expect(codex).toContainText("~/shop-api");
  // The command, then what it printed, a line at a time.
  await expect(codex).toContainText("pnpm test payments", { timeout: 15_000 });
  await expect(codex).toContainText("✗ refunds › partial refund after retry", { timeout: 15_000 });
  await expect(codex).toContainText("Ran pnpm test payments");
  await expect(codex).toContainText("Edited payments/retry.ts +1 −1", { timeout: 15_000 });
  await expect(codex).toContainText("+ return chargeCard(order, { key: order.id })");
  // Its Context work, in its own terminal, while the project changes beside it.
  await expect(codex).toContainText("Ticked context Idempotency key on retries", { timeout: 15_000 });
  await expect(page.getByTestId("app-frame")).toContainText(/Fix partial refund after retry/, { timeout: 15_000 });
  await expect(codex).toContainText("Marked context Checkout v2 as in progress", { timeout: 15_000 });
}

test.describe("on a wide screen", () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test("two terminals beside the workspace, each doing its part", async ({ page }) => {
    test.setTimeout(90_000);
    await preview(page, SCENE);
    await playsThrough(page);
    // Its own window, beside Context's, not a panel inside it.
    const codexBox = (await page.getByTestId("cast-terminal-Codex").boundingBox())!;
    const contextBox = (await page.getByTestId("cast-workspace-bar").boundingBox())!;
    expect(contextBox.x).toBeGreaterThan(codexBox.x + codexBox.width + 8);

    // Asking first: the question waits for somebody, then says who allowed it.
    const claude = page.getByTestId("cast-terminal-Claude Code");
    await expect(claude.getByTestId("cast-terminal-approval")).toContainText("Run this command?", { timeout: 20_000 });
    await expect(claude.getByTestId(`cast-terminal-prompt-Claude Code`)).toContainText("Waiting for approval");
    await expect(claude).toContainText("@sam allowed pnpm test refunds", { timeout: 15_000 });
    await expect(claude).toContainText("Marked context Checkout v2 as done", { timeout: 15_000 });
    // Both terminals stay up, one above the other.
    await expect(page.getByTestId("cast-terminal-Codex")).toBeVisible();
    await expect(page.getByTestId("app-frame")).toContainText("Partial refunds fixed too.", { timeout: 15_000 });
  });
});

test.describe("on a phone", () => {
  test("Context above one terminal, and a tab for the other", async ({ page }) => {
    test.setTimeout(90_000);
    await preview(page, SCENE);
    await playsThrough(page);
    const terminal = (await page.getByTestId("cast-phone-chat").boundingBox())!;
    const context = (await page.getByTestId("cast-phone-context").boundingBox())!;
    expect(context.y + context.height).toBeLessThanOrEqual(terminal.y + 1);
    expect(terminal.y + terminal.height).toBeLessThanOrEqual(844);

    // Claude Code takes the one window when it is asked; Codex is a tab away.
    await expect(page.getByTestId("cast-terminal-Claude Code")).toContainText("Run this command?", { timeout: 20_000 });
    await expect(page.getByTestId("cast-terminal-Codex")).toHaveCount(0);
    await expect(page.getByTestId("cast-terminal-Claude Code")).toContainText("@sam allowed", { timeout: 15_000 });
    await page.getByTestId("cast-chat-tab-Codex").click();
    await expect(page.getByTestId("cast-terminal-Codex")).toContainText("Edited payments/retry.ts");
  });
});
