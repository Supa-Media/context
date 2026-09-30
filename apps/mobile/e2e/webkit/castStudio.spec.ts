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

test("sounds: chosen in the panel, kept in the note, and only for what plays", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Every cue the stage sends the studio, in order.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cues: string[] }).__cues = seen;
    window.addEventListener("message", (event) => {
      const data = event.data as { tag?: string; kind?: string; moment?: string };
      if (window.parent === window && data?.tag === "context-cast-studio" && data.kind === "cue") seen.push(data.moment!);
    });
  });
  await page.goto(PAGE);
  await expect(page.getByTestId("cast-studio")).toBeVisible({ timeout: 20_000 });

  await page.getByTestId("studio-sounds-toggle").click();
  await expect(page.getByTestId("studio-sounds")).toContainText("Sounds in this scene");
  await expect(page.getByTestId("studio-sound-comment")).toContainText("2 times");
  await expect(page.getByTestId("studio-sound-note")).toContainText("not in this scene");
  await page.getByTestId("studio-sound-comment").click();
  await page.getByTestId("studio-sound-comment-bell").click();
  await expect(page.getByTestId("studio-sound-comment")).toContainText("Bell");
  await page.getByTestId("studio-sound-typing").click();
  await page.getByTestId("studio-sound-typing-off").click();
  const note = () => page.evaluate(() => (window as unknown as { __castStudioNote?: string }).__castStudioNote ?? "");
  await expect.poll(note).toContain("sounds: [typing off, comment bell]");

  // Played from the resolve: the comment and the reply before it land without a sound.
  await expect(stage(page)).toContainText("Free is free", { timeout: 20_000 });
  await page.getByTestId("studio-step-3").click();
  const cues = () => page.evaluate(() => (window as unknown as { __cues: string[] }).__cues.slice());
  await expect.poll(cues, { timeout: 15_000 }).toContain("resolve");
  expect(await cues()).not.toContain("comment");
});

test("sounds: your own sound is uploaded and chosen for its moment", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(PAGE);
  await expect(page.getByTestId("cast-studio")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("studio-sounds-toggle").click();
  await page.getByTestId("studio-sound-agent").click();

  // A tiny WAV: a header and a few silent samples.
  const wav = Buffer.concat([
    Buffer.from("RIFF"), Buffer.from([44, 0, 0, 0]), Buffer.from("WAVEfmt "),
    Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x80, 0x3e, 0, 0, 2, 0, 16, 0]),
    Buffer.from("data"), Buffer.from([8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  ]);
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("studio-sound-agent-upload").click();
  await (await chooser).setFiles({ name: "whoosh.wav", mimeType: "audio/wav", buffer: wav });

  await expect(page.getByTestId("studio-sound-agent")).toContainText("Your sound");
  const sent = await page.evaluate(() => (window as unknown as { __castStudioUpload?: unknown }).__castStudioUpload);
  expect(sent).toEqual({ size: wav.length, contentType: "audio/wav" });
  const note = await page.evaluate(() => (window as unknown as { __castStudioNote?: string }).__castStudioNote ?? "");
  expect(note).toContain("sounds: [agent sound-0123456789abcdef.wav]");
});

test("a scene goes on to another page, and the stage follows it there", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/e2e-fixture?screen=cast-studio-pages");
  await expect(page.getByTestId("cast-studio")).toBeVisible({ timeout: 20_000 });
  await expect(stage(page)).toContainText("Free is free", { timeout: 20_000 });
  await expect(page.getByTestId("studio-step-4")).toContainText("opens team");

  // Played from the open: the steps before it land at once, then the stage is on Team.
  await page.getByTestId("studio-step-4").click();
  await expect(stage(page)).toContainText("Who builds this.", { timeout: 20_000 });
  await expect(stage(page)).toContainText("and the team is on it.", { timeout: 20_000 });
  await expect(stage(page)).not.toContainText("Free is free");
  await expect(page.getByTestId("studio-step-5")).toHaveAttribute("aria-current", "step", { timeout: 15_000 });
});

test("sounds are heard: Play wakes the audio, and the first cue starts a sound", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __audio: { started: number; states: string[] } };
    w.__audio = { started: 0, states: [] };
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...args: Parameters<typeof start>) {
      w.__audio.started += 1;
      w.__audio.states.push(this.context.state);
      return start.apply(this, args);
    };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(PAGE);
  await expect(page.getByTestId("cast-studio")).toBeVisible({ timeout: 20_000 });
  await expect(stage(page)).toContainText("Free is free", { timeout: 20_000 });
  await page.getByTestId("studio-play").click();
  const audio = () => page.evaluate(() => (window as unknown as { __audio: { started: number; states: string[] } }).__audio);
  await expect.poll(async () => (await audio()).started, { timeout: 15_000 }).toBeGreaterThan(0);
  expect((await audio()).states.every((state) => state === "running")).toBe(true);
});

test("pace: chosen in the studio, kept in the note, and the scene's times follow it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(PAGE);
  await expect(page.getByTestId("cast-studio")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("studio-pace-lively")).toHaveAttribute("aria-checked", "true");
  const length = async () => {
    const text = (await page.getByTestId("cast-studio").getByText(/steps · \d+:\d\d/).first().textContent()) ?? "";
    const [m, s] = text.slice(text.lastIndexOf(" ") + 1).split(":").map(Number);
    return m! * 60 + s!;
  };
  const lively = await length();
  await page.getByTestId("studio-pace-slow").click();
  await expect(page.getByTestId("studio-pace-slow")).toHaveAttribute("aria-checked", "true");
  const note = () => page.evaluate(() => (window as unknown as { __castStudioNote?: string }).__castStudioNote ?? "");
  await expect.poll(note).toContain("```cast\npace: slow\n");
  await expect.poll(length).toBeGreaterThan(lively);
  // The stage starts over at the new pace and still plays.
  await expect(stage(page)).toContainText("Free is free", { timeout: 20_000 });
  await page.getByTestId("studio-play").click();
  await expect(stage(page)).toContainText("this page is live", { timeout: 20_000 });
});
