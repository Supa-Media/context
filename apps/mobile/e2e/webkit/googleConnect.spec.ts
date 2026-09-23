import { expect, test } from "@playwright/test";

// The exported app registers its production service worker. Once it controls
// this page, Playwright cannot intercept the callback action request with
// `page.route`, so WebKit can race into a real DNS lookup for the deliberately
// invalid fixture host. This spec is about the browser HTTP action path, not
// service-worker behavior (covered by offlineShell.spec.ts), so keep the
// request observable by Playwright here.
test.use({ serviceWorkers: "block" });

test("Google callback completes through the real browser HTTP action route", async ({ page }) => {
  const actionRequests: Array<{ url: string; body: unknown }> = [];

  await page.route("https://e2e-fixture.invalid/api/action", async (route) => {
    const request = route.request();
    actionRequests.push({
      url: request.url(),
      body: request.postDataJSON(),
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "success",
        value: { workspaceId: "workspace:e2e" },
        logLines: [],
      }),
    });
  });

  await page.goto(
    "/connect/google?code=google-code&state=google-state&completionSecret=google-completion-secret",
  );

  await expect(page.getByRole("heading", { name: "Google is connected" })).toBeVisible();
  expect(actionRequests).toHaveLength(1);
  expect(actionRequests[0]?.body).toMatchObject({
    path: "functions/googleConnect:completeGoogleConnect",
    format: "convex_encoded_json",
  });
  expect(JSON.stringify(actionRequests[0]?.body)).toContain("google-code");
  expect(JSON.stringify(actionRequests[0]?.body)).toContain("google-state");
  expect(JSON.stringify(actionRequests[0]?.body)).toContain("google-completion-secret");
});

test("Google callback without the browser secret does not call completion", async ({ page }) => {
  let actionCalls = 0;
  await page.route("https://e2e-fixture.invalid/api/action", async (route) => {
    actionCalls += 1;
    await route.abort();
  });

  await page.goto("/connect/google?code=google-code&state=missing-state");

  await expect(page.getByRole("heading", { name: "Google did not connect" })).toBeVisible();
  expect(actionCalls).toBe(0);
});
