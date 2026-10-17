/**
 * THE SUGGESTED ICON, BY MEANING, AGAINST THE REAL MODEL.
 *
 * Fingerprints every standard emoji's description with the model the product
 * uses (`emojiMeaning.ts`), then each name below, and prints the three
 * closest emoji and how long the name's own fingerprint took: that one call
 * is all a suggestion costs once the emoji's are built. Nothing is asserted
 * about the picks; a person reads the table in the job log.
 *
 * Runs only when the "Icon Suggest (live)" workflow is dispatched with
 * `models` ticked, which sets the account and token below. Only invented
 * names and our own descriptions are sent.
 */

import { describe, expect, test } from "vitest";
import { emojiMeaningTexts, nameMeaningText } from "@context/shared/src/emojiMeaning";
import { createRestEmbedder } from "../../mcp/src/search/meaning/embed.js";

const account = process.env.ICON_MODELS_ACCOUNT ?? "";
const token = process.env.ICON_MODELS_TOKEN ?? "";

const NAMES = [
  "tex/routines/once",
  "tex/routines",
  "tex",
  "0-inbox/calendar",
  "0-inbox/contacts",
  "1-projects/Bible study",
  "2-areas/taxes",
  "1-projects/walnut-credenza.md",
  "3-resources/recipes",
  "1-projects/wedding planning",
  "1-projects/Q4 budget.md",
  "3-resources/japan trip",
  "1-projects/podcast",
  "2-areas/dentist",
  "2-areas/garden",
  "1-projects/hiring",
  "2-areas/health",
  "3-resources/reading list",
];

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let at = 0; at < a.length; at += 1) {
    dot += a[at]! * b[at]!;
    aa += a[at]! * a[at]!;
    bb += b[at]! * b[at]!;
  }
  return dot / Math.sqrt(aa * bb);
}

describe.skipIf(!account || !token)("the suggested icon by meaning, live", () => {
  test("prints the closest emoji for each name, and the time one name takes", async () => {
    const embed = createRestEmbedder({ accountId: account, apiToken: token }) as (texts: string[]) => Promise<number[][]>;
    const emoji = emojiMeaningTexts();
    const started = Date.now();
    const vectors = await embed(emoji.map(({ text }) => text));
    console.log(`fingerprinted ${emoji.length} emoji in ${Date.now() - started} ms`);

    const lines: string[] = [];
    for (const path of NAMES) {
      const before = Date.now();
      const [name] = await embed([nameMeaningText(path)]);
      const ms = Date.now() - before;
      const ranked = vectors
        .map((vector, index) => ({ char: emoji[index]!.char, score: cosine(name!, vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      lines.push(`${path.padEnd(32)} ${String(ms).padStart(5)} ms  ${ranked.map((r) => `${r.char} ${r.score.toFixed(3)}`).join("  ")}`);
    }
    console.log(lines.join("\n"));
    expect(lines).toHaveLength(NAMES.length);
  }, 300_000);
});
