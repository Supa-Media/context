import { describe, expect, test } from "@jest/globals";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { HERO_LINE_ONE, HERO_LINE_TWO, LANDING_COPY } from "../features/landing/copy";

/**
 * The vocabulary decisions, enforced on the copy they govern.
 *
 * `docs/decisions/vocabulary-and-workspaces.md` settled two things that bind
 * anything a visitor reads, and until now nothing checked either of them —
 * `landing.test.ts` is about sign-in redirects and has never looked at a word
 * on the page.
 *
 * This is the cheapest guard in the repo and the one most likely to catch a
 * real mistake, because copy is what gets edited in a hurry by whoever is
 * closest to a launch.
 */
describe("the landing page obeys the vocabulary decisions", () => {
  test("there is copy to check", () => {
    // A rule applied to an empty list is a rule that always passes.
    expect(LANDING_COPY.length).toBeGreaterThan(3);
    expect(LANDING_COPY.every((line) => line.trim().length > 0)).toBe(true);
  });

  test("the retired noun appears nowhere", () => {
    // "Brain" is retired: no new user-facing copy uses it. Retiring a word
    // does not free its *name* — that is why it stays reserved in
    // `functions/lib/names.ts` — but it is gone from what people read.
    const offenders = LANDING_COPY.filter((line) => /\bbrains?\b/i.test(line));
    expect(offenders).toEqual([]);
  });

  test("'context' is never used for a single unit", () => {
    // Context is the aggregate and the product name. A single unit is a
    // **workspace**. So "your context" (the whole of what you can reach) is
    // allowed and "a context" / "two contexts" / "this context" are not.
    const asAUnit = /\b(a|an|another|each|every|this|that|these|those|\d+)\s+contexts?\b|\bcontexts\b/i;
    const offenders = LANDING_COPY.filter((line) => asAUnit.test(line));
    expect(offenders).toEqual([]);
  });

  test("the hero says what the product is, not how it is plumbed", () => {
    // The hero used to lead with the endpoint and a list of the assistants it
    // reaches, which asks a reader to know what MCP is before it tells them
    // what they are looking at. Whatever the words become, the first line is
    // about the thing, and the plumbing is not in it.
    const hero = `${HERO_LINE_ONE} ${HERO_LINE_TWO}`;
    expect(hero).toMatch(/notes/i);
    expect(hero).not.toMatch(/\bMCP\b|endpoint|bucket|markdown/i);
  });
});

/**
 * ...AND THE LIST IS THE PAGE, AND THE RULES REACH THE CLAIMS.
 *
 * The suite above is careful that a rule is not applied to an *empty* list —
 * "a rule applied to an empty list always passes" — and that is the right
 * instinct one step short. `LANDING_COPY` was **four of the six strings a
 * visitor reads**: a button's `label` and a `PressRow`'s `accessibilityLabel`
 * lived as literals in `Landing.tsx`, so every rule above was silent on them.
 * An incomplete list passes for the same reason an empty one does.
 *
 * And the rules it did hold are about **vocabulary** — the retired noun, the
 * countable "context", the hero naming the product. Those protect a naming
 * decision. The page also makes one **factual** claim, *"Everything stays
 * plain Markdown in storage you own"*, which is non-negotiables #1 and #3 said
 * to somebody who has not signed up yet, and nothing held that class at all.
 * The cheapest guard in the repo was guarding the cheaper half.
 */
describe("the landing page's list is the page, and its claims are ones we keep", () => {
  /**
   * Everything `Landing.tsx` renders as a sentence has to come from the list.
   *
   * Scoped to the two props that carry sentences and to JSX text runs long
   * enough to be one. The twelve-character floor is what keeps the wordmark's
   * `.lc` — a JSX child, and the product's name rather than a claim — out of a
   * copy list, while admitting anything with something to say.
   */
  test("no sentence a visitor reads is outside the list", () => {
    /*
      TWELVE CHARACTERS IS THE BOUND, AND IT IS STATED RATHER THAN IMPLIED.
      Under it are the wordmark's `.lc`, `MIT`, `(soon)` and two aria-hidden
      glyphs — labels and ornament. A three-word label cannot carry the kind of
      claim these rules exist to catch, and a scan with no floor would drag
      every glyph on the page into a copy list. Anything long enough to say
      something is in scope, whether its run ends at a tag or at an
      interpolation: `Also on your phone:` is followed by `{" "}` rather than
      by `<`, and an earlier draft that only stopped at `<` walked past it.
    */
    const source = readFileSync(join(__dirname, "../features/landing/Landing.tsx"), "utf8");
    const spoken: string[] = [];
    for (const match of source.matchAll(/(?:\baccessibilityLabel|\blabel)="([^"]+)"/g)) {
      spoken.push(match[1]!);
    }
    /*
      Across lines, and whitespace-normalised before comparing. The first draft
      of this scan forbade a newline inside the run — and so walked straight
      past the **longest paragraph on the page**, three lines of JSX text, while
      reporting that the list was the page. The claim this test makes about
      itself was false when it was written, in exactly the way the claim it
      checks had been.
    */
    // `(?<!=)` so an arrow function is not read as a tag: terminating a run at
    // an interpolation made `=> StyleSheet.create(` look exactly like JSX text.
    for (const match of source.matchAll(/(?<!=)>\s*([A-Za-z][^<>{}]{11,}?)\s*[<{]/gs)) {
      spoken.push(match[1]!.replace(/\s+/g, " ").trim());
    }
    const unguarded = spoken.filter(
      (text) => !LANDING_COPY.some((line) => line.replace(/\s+/g, " ").includes(text)),
    );
    expect(unguarded).toEqual([]);
  });

  /**
   * ...and every line the page can reach is in the list.
   *
   * The scan above only sees **literals**, so on its own it is satisfied the
   * moment a sentence becomes a constant — after which `LANDING_COPY` could be
   * trimmed back and the page would go on rendering the line with no rule
   * touching it. That is the same incompleteness this suite was extended to
   * close, wearing the fix's own clothes, and sabotage is what surfaced it:
   * dropping a constant from the list reddened nothing.
   *
   * So the two halves meet in the middle — **every sentence is a constant, and
   * every constant is in the list** — and neither direction is left to
   * somebody remembering.
   */
  test("no line this file exports is left out of the list", () => {
    const source = readFileSync(join(__dirname, "../features/landing/copy.ts"), "utf8");
    const strings = [...source.matchAll(/export const [A-Z_0-9]+(?:\s*=\s*|\s*=\s*\n\s*)"([^"]*)"/g)].map(
      (match) => match[1]!,
    );
    /*
      Every exported name except the list itself, counted separately — so a
      constant written in a shape this reader cannot parse **fails here** rather
      than being quietly skipped. A reader that can silently return less than it
      was given is the failure this whole test exists about, one level down.
    */
    const names = [...source.matchAll(/export const ([A-Z_0-9]+)\s*[:=]/g)]
      .map((match) => match[1]!)
      .filter((name) => name !== "LANDING_COPY");
    expect(strings.length).toBe(names.length);
    expect(strings.length).toBeGreaterThan(8);
    const missing = strings.filter((text) => !LANDING_COPY.some((line) => line.includes(text)));
    expect(missing).toEqual([]);
  });

  /**
   * The page does not claim a confidentiality the product does not hold.
   *
   * Grounded in `docs/decisions/encryption.md` rather than in taste. A note is
   * encrypted **deliberately, per note**, and its `workspace` recipient exists
   * *so that the gateway can decrypt at request time* — that is what keeps
   * members, MCP clients, the console and opt-in search working. Only a
   * `passphrase` note is one "we cannot recover", and that is a choice a person
   * makes on one note, not a property of the product.
   *
   * So every phrase below would be **false on the front page**, and false about
   * the threat model specifically — the reader would be deciding to trust us
   * with something on a promise we do not make. The commit that built this
   * file said the risk out loud: *"copy is what gets edited in a hurry by
   * whoever is closest to a launch."* This is that risk pointed at the half
   * that matters.
   */
  test("the page claims no confidentiality the product does not keep", () => {
    const OVERCLAIMS: Array<[label: string, pattern: RegExp]> = [
      ["end-to-end", /end[- ]to[- ]end/i],
      ["zero-knowledge", /zero[- ]knowledge/i],
      /*
        A negation and a verb, in that order, inside one sentence — rather than
        a fixed list of contractions. The first draft spelled the contractions
        out and **missed "we can never read your notes"**, which is the most
        natural way anybody would write the claim: "can never" is neither
        "cannot" nor a bare "never". Sabotage caught it; reading it did not.
      */
      ["we cannot read it", /\bwe\b[^.]{0,40}\b(never|cannot|can ?not|can'?t|could ?n[o']t|do ?n[o']t|do not|wo ?n[o']t|will not)\b[^.]{0,40}\b(read|see|access|decrypt|look at)\b/i],
      ["only you can read it", /\bonly you\b[^.]{0,40}\b(can|could)\b[^.]{0,40}\b(read|see|open|decrypt)\b/i],
      ["nobody else can read it", /\bno[- ]?(one|body)\b[^.]{0,40}\b(can|could)\b[^.]{0,40}\b(read|see|open|decrypt)\b/i],
      ["encrypted by default", /\bencrypted\b[^.]*\bby default\b/i],
      ["we hold nothing", /\bwe (hold|store|keep) (nothing|none)\b/i],
      /*
        AND A CUSTODY CLAIM, WHICH EVERY RULE ABOVE MISSES.

        The seven rules above are about **reading** — can we look at it, can
        anyone else. A visitor deciding whether to sign up asks a different
        question first: *do you keep a copy of my notes at all?* The assurance
        block answers it, and nothing checked the answer.

        It matters because the honest answer has an exception. `CLAUDE.md`'s
        first non-negotiable scopes its promise to **the control plane** —
        "the control plane holds metadata only ... and never note content" —
        and its second names what else we hold: managed buckets "and the
        per-context search databases". `functions/lib/fastSearch.ts` says what
        that is in as many words: turning Fast Search on "adds a derived copy
        of that context's note text, including private notes, in a database
        Supa Media owns".

        So an unqualified "we never hold your note content" is a promise the
        product does not keep, and it is the most load-bearing sentence on the
        page. Both orders are caught, because either is how somebody would
        write it.
      */
      ["we hold no note content", /\bwe\b[^.]{0,60}\b(hold|store|keep|retain)\b[^.]{0,60}\b(never|no|not)\b[^.]{0,40}\b(note|notes|content)\b/i],
      ["we never hold note content", /\bwe\b[^.]{0,40}\b(never|do ?n[o']t|do not|will not|wo ?n[o']t)\b[^.]{0,40}\b(hold|store|keep|retain|have)\b[^.]{0,60}\b(note|notes|content)\b/i],
    ];
    const offenders: string[] = [];
    for (const [label, pattern] of OVERCLAIMS) {
      for (const line of LANDING_COPY) if (pattern.test(line)) offenders.push(`${label}: ${line}`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * ...AND WHILE THE EXCEPTION EXISTS, THE PAGE SAYS SO.
   *
   * The rules above catch a claim that is **false**. They are silent on one
   * that is true and incomplete — and that is the version this page had:
   * scoping the promise to the control plane makes the sentence accurate while
   * leaving out the one feature that puts a copy of somebody's note text in a
   * database we run.
   *
   * Sabotage said so: deleting the Fast Search clause reddened **nothing**.
   *
   * So the fact is read out of the control plane's own schema rather than
   * restated here, the way the route guard reads the gateway's source. While
   * `fastSearch` is a field on a workspace, the assurance block must name it.
   * **Remove the feature and this test stops asking** — which is the direction
   * it should fail in, and is why the presence of the field is the condition
   * rather than a constant somebody has to remember to flip.
   */
  test("while an opt-in stores note text, the assurances name it", () => {
    const schema = readFileSync(
      join(__dirname, "../../convex/schema.ts"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // The two-condition gate lives in `functions/lib/fastSearch.ts`; this is
    // the stored half — the per-workspace opt-in, off by default.
    const optInExists = /\bfastSearch:\s*v\.boolean\(\)/.test(schema);
    if (!optInExists) return;

    // Not "some line mentions search" — the line carrying the storage promise
    // is the one that has to carry the exception, because that is the sentence
    // a visitor reads as the answer.
    const promise = LANDING_COPY.filter((line) => /\bnever your note content\b/i.test(line));
    expect(promise).toHaveLength(1);
    expect(promise[0]).toMatch(/fast search/i);
  });
});

/**
 * ...AND THE PAGE IS THE FOLDER, NOT THE ONE FILE THE FIX HAPPENED TO OPEN.
 *
 * The scan above reads `Landing.tsx`. The landing page is not `Landing.tsx` —
 * it is a folder, and `ContinuityDemo` is the section a visitor meets **first**,
 * above the proof block every rule here was extended to cover. Five sentences
 * rendered there and a demo transcript beside them were literals nothing read,
 * including the page's strongest confidentiality claims:
 *
 *  - *"Context carries the decision to every client and teammate you
 *    allowed—not the private notes you didn't."*
 *  - *"The note moves. The boundary doesn't."*
 *  - *"his private notes were never available to me."*
 *
 * That is the same defect the block above was written for — **an incomplete
 * list passes for the reason an empty one does** — surviving inside its own
 * fix, because the fix named a file where the hazard is a directory. A
 * component added next week is the same bug again, so the directory is read
 * rather than a list of names being typed out.
 */
describe("the landing page is every component in the folder", () => {
  const LANDING_DIR = join(__dirname, "../features/landing");

  /** JSX carries `&apos;` where a constant carries `'`. Decoded, not tolerated. */
  function decodeEntities(text: string): string {
    return text
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }

  test("no sentence any landing component renders is outside the list", () => {
    const files = readdirSync(LANDING_DIR)
      .filter((name) => name.endsWith(".tsx"))
      .sort();
    // A `readdirSync` that returns nothing, or a filter that matches nothing,
    // is a scan that passes because it checked no files. Five components render
    // this page today.
    expect(files.length).toBeGreaterThanOrEqual(5);

    const unguarded: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(LANDING_DIR, file), "utf8");
      const spoken: string[] = [];
      for (const match of source.matchAll(/(?:\baccessibilityLabel|\blabel)="([^"]+)"/g)) {
        spoken.push(match[1]!);
      }
      // The same two patterns and the same twelve-character floor as the scan
      // over `Landing.tsx`, applied to every file beside it.
      for (const match of source.matchAll(/(?<!=)>\s*([A-Za-z][^<>{}]{11,}?)\s*[<{]/gs)) {
        spoken.push(match[1]!.replace(/\s+/g, " ").trim());
      }
      for (const text of spoken.map(decodeEntities)) {
        if (!LANDING_COPY.some((line) => line.replace(/\s+/g, " ").includes(text))) {
          unguarded.push(`${file}: ${text}`);
        }
      }
    }
    expect(unguarded).toEqual([]);
  });

  /**
   * ...and the demo's transcript is copy, even though it is a data structure.
   *
   * `CONTINUITY_STEPS` is prose a visitor reads word for word — a prompt, a
   * reply and a receipt for each of three assistants — that no JSX scan can
   * see, because it never appears between two tags. It is where the sharpest
   * claim on the page lives, and it is the shape a future section will reach
   * for the moment its copy has more than one field.
   *
   * So the folder's plain modules are read for their string literals rather
   * than for their exports: a string that says something, wherever it sits in
   * the structure, has to be in the list. The twelve-character floor is the one
   * the scans above state, and it is what keeps `id: "chatgpt"` and a one-glyph
   * `mark` out of a copy list.
   *
   * **Every `.ts` in the folder, not `demoCopy.ts` by name.** Naming the file
   * is the defect this whole block is about, one directory in: a second module
   * of prose would be invisible to the JSX scan — which sees `{FOO}` and no
   * words — and to a reader that only opens the file today's copy happens to be
   * in. `copy.ts` is the one exclusion, because it IS the list and the test
   * above holds it to its own exports.
   */
  test("every sentence in the folder's copy modules is in the list", () => {
    const modules = readdirSync(LANDING_DIR)
      .filter((name) => name.endsWith(".ts") && name !== "copy.ts")
      .sort();
    expect(modules).toContain("demoCopy.ts");
    const source = modules
      .map((name) => readFileSync(join(LANDING_DIR, name), "utf8"))
      .join("\n");
    // Comments stripped first: this file's own header quotes the claims it
    // exists to guard, and a reader that took those for copy would report the
    // docblock as unguarded prose.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    /*
      EVERY string is matched and the short ones are dropped AFTERWARDS, which
      is not a tidy-up. A pattern that puts the floor inside the quotes —
      `"([^"]{12,})"` — skips a short literal and then pairs its CLOSING quote
      with the next literal's opening one, so `", access: "` arrives as a
      sentence. It reported six of those before this comment existed.
    */
    const literals = [...code.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
      .map((match) => match[1]!)
      .filter((text) => text.length >= 12);
    // These modules are prose; a reader that found none of it has stopped
    // working, and so has a `readdirSync` that matched nothing.
    expect(literals.length).toBeGreaterThanOrEqual(15);

    const missing = literals.filter((text) => !LANDING_COPY.some((line) => line.includes(text)));
    expect(missing).toEqual([]);
  });
});
