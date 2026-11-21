/**
 * The signed-in UI matrix: every combination of the console's two panels,
 * with a note open and with none, at the desktop, medium and phone layouts,
 * and the right panel folded and unfolded while Tex is answering.
 *
 * Dev2, 2026-11-21: folding the side panel with Tex open left the chat drawn
 * over the note, a state no single screenshot had visited. So this walks the
 * states rather than the pages, screenshots each one, and checks the two
 * things a picture alone hides: a folded panel draws nothing of itself but
 * its rail, and nothing makes the page scroll sideways.
 *
 * Run from `screenshots.mjs` when `MATRIX=1` (the Preview screenshots Action,
 * on every pull request that touches the app). The pictures go to
 * `<out>/matrix/`, one per state; the problems are returned.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Notes every persona's workspace has, tried in order: the tree shows
 * `activity` at the root, and the phone's Notes list shows the root `index`
 * under Top level instead.
 */
const NOTES = ["activity", "index"];
/** What Tex is asked while the panel is folded under it: a read, so a preview never sends anything. */
const ASK = "what notes do I have?";

const visible = async (page, id) => {
  const node = page.getByTestId(id);
  return (await node.count()) > 0 && (await node.first().isVisible().catch(() => false));
};

const press = async (page, id) => {
  if (!(await visible(page, id))) return false;
  await page.getByTestId(id).first().click();
  await page.waitForTimeout(700);
  return true;
};

/** Opens the right panel on Tex, from the open rail or the folded one. */
async function openTex(page) {
  if (await press(page, "aside-tab-tex")) return;
  await press(page, "aside-strip-tex");
  if (!(await visible(page, "aside-tex"))) await press(page, "aside-tab-tex");
}

/** What is wrong in this state that a screenshot might not show. */
export async function stateProblems(page, name, right) {
  const problems = [];
  if (right !== "open") {
    for (const id of ["aside-tex", "aside-panel"]) if (await visible(page, id)) problems.push(`${name}: ${id} is drawn while the panel is ${right}`);
    const warm = page.getByTestId("aside-tex-warm");
    if ((await warm.count()) > 0) {
      const box = await warm.first().boundingBox();
      if (box !== null && box.width > 0) problems.push(`${name}: the hidden Tex chat takes ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
  }
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (sideways > 1) problems.push(`${name}: the page scrolls sideways by ${sideways}px`);
  return problems;
}

/**
 * Walks the matrix in one signed-in browser context per layout and note
 * state. `newContext(layout)` returns a context that is already signed in.
 */
export async function runMatrix({ origin, layouts, newContext, out, log = console.log }) {
  const dir = join(out, "matrix");
  mkdirSync(dir, { recursive: true });
  const problems = [];
  let pictures = 0;

  for (const layout of layouts) {
    for (const note of ["none", "note"]) {
      const context = await newContext(layout);
      const page = await context.newPage();
      page.on("pageerror", (error) => problems.push(`${layout.name}-${note}: ${String(error?.message ?? error).split("\n")[0].slice(0, 160)}`));
      const shot = async (state, right) => {
        const name = `${layout.name}-${note}-${state}`;
        problems.push(...(await stateProblems(page, name, right)));
        await page.screenshot({ path: join(dir, `${name}.png`) });
        pictures += 1;
      };
      try {
        await page.goto(`${origin}/console`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(2500);
        await page.keyboard.press("Escape");
        if (note === "note") {
          const row = NOTES.map((name) => page.getByText(name, { exact: true }).first());
          const shown = [];
          for (const candidate of row) shown.push(await candidate.isVisible().catch(() => false));
          const at = shown.indexOf(true);
          if (at < 0) throw new Error(`none of ${NOTES.join(", ")} is shown to open`);
          await row[at].click({ timeout: 10_000 });
          await page.waitForTimeout(2000);
        }
        if (layout.name === "phone") {
          await shot("phone", "none");
          continue;
        }
        for (const tree of ["open", "closed"]) {
          if (tree === "closed") await press(page, "frame-toggle-explorer");
          for (const tab of ["tex", "meetings"]) {
            if (tab === "tex") await openTex(page);
            else await press(page, "aside-tab-meetings");
            await shot(`tree${tree}-${tab}-open`, "open");
            await press(page, "aside-fold");
            await shot(`tree${tree}-${tab}-folded`, "folded");
            await press(page, "aside-unfold");
          }
          if (tree === "closed") await press(page, "frame-toggle-explorer");
        }
        // Tex answering while the panels move under it.
        await openTex(page);
        if (!(await visible(page, "tex-input"))) {
          problems.push(`${layout.name}-${note}: the Tex chat has no input`);
          continue;
        }
        await page.getByTestId("tex-input").first().click();
        await page.keyboard.type(ASK);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2500);
        await shot("tex-running", "open");
        await press(page, "aside-fold");
        await shot("tex-running-folded", "folded");
        await press(page, "frame-toggle-explorer");
        await shot("tex-running-folded-treeclosed", "folded");
        await press(page, "frame-toggle-explorer");
        await press(page, "aside-unfold");
        await page.waitForTimeout(20_000);
        await shot("tex-done", "open");
      } catch (error) {
        problems.push(`${layout.name}-${note}: ${String(error?.message ?? error).split("\n")[0].slice(0, 160)}`);
        await page.screenshot({ path: join(dir, `${layout.name}-${note}-FAILED.png`) }).catch(() => {});
      } finally {
        await context.close();
      }
    }
  }
  log(`matrix: ${pictures} state(s) in ${dir}, ${problems.length} problem(s).`);
  return problems;
}
