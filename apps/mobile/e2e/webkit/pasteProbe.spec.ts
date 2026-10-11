import { expect, test, type Page } from "@playwright/test";

// DIAGNOSTIC PROBE: not for merge.
const sizes = { desktop: { width: 1400, height: 900 }, phone: { width: 390, height: 844 } };

async function setup(page: Page, withComments: boolean) {
  await page.goto("/e2e-fixture");
  const first = page.locator(".cm-line", { hasText: "Tenancy is bucket-level" });
  await expect(first).toBeVisible();
  const box = await first.boundingBox();
  await page.mouse.click(box!.x + 4, box!.y + box!.height / 2);
  await page.keyboard.press("ControlOrMeta+End");
  const filler = Array.from({ length: 120 }, (_, i) => (withComments && i === 100 ? `<!--c:aa01-->Filler<!--/c:aa01--> paragraph ${i + 1}.` : `Filler paragraph ${i + 1}.`)).join("\n\n");
  const tail = withComments ? '\n\n```comments\naa01 "Filler"\n- 2026-10-10T04:00:00Z @sayo: A note.\n```\n' : "";
  await page.keyboard.insertText(`\n\n${filler}\n\nWords far down the note.\n\nLast.${tail}`);
  const far = page.locator(".cm-line", { hasText: "Words far down the note." });
  await far.scrollIntoViewIfNeeded();
  const farBox = await far.boundingBox();
  await page.mouse.click(farBox!.x + farBox!.width - 2, farBox!.y + farBox!.height / 2);
  await page.keyboard.press("End");
  await page.waitForTimeout(400);
}
const scrolls = (page: Page) => page.evaluate(() => {
  const o: Record<string, number> = {};
  for (const el of [document.scrollingElement!, ...document.querySelectorAll("*")]) if (el.scrollTop > 0) o[(el.className?.toString?.() || el.tagName).slice(0, 14)] = Math.round(el.scrollTop);
  return JSON.stringify(o);
});
const texts = { short: " hello", lines: "\n\nline one\n\nline two\n\n- a\n- b\n", big: "\n\n" + Array.from({ length: 40 }, (_, i) => `Pasted ${i}`).join("\n\n") };
for (const [size, viewport] of Object.entries(sizes)) {
  for (const comments of [false, true]) {
    for (const [name, text] of Object.entries(texts)) {
      test(`probe ${size} comments=${comments} ${name}`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await setup(page, comments);
        const before = await scrolls(page);
        await page.evaluate(() => {
          (window as any).__log = [];
          document.addEventListener("scroll", (e) => { const t = e.target as HTMLElement; (window as any).__log.push(`${(t.className?.toString?.() || "doc").slice(0, 14)}=${Math.round((t as any).scrollTop ?? 0)}`); }, { capture: true, passive: true });
          document.addEventListener("focusin", (e) => (window as any).__log.push(`focus:${(e.target as HTMLElement).tagName}.${(e.target as HTMLElement).className?.toString?.().slice(0, 20)}`), true);
        });
        await page.evaluate((t) => {
          const dt = new DataTransfer();
          dt.setData("text/plain", t);
          document.querySelector(".cm-content")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        }, text);
        await page.waitForTimeout(800);
        const after = await scrolls(page);
        const log = await page.evaluate(() => (window as any).__log.slice(0, 12).join(" "));
        console.log(`PROBE ${size} comments=${comments} ${name} before=${before} after=${after} log=${log}`);
      });
    }
  }
}
