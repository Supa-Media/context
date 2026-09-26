/**
 * The spelling member (bridge version 8): the note's right-click menu asks the
 * OS checker, through `webFrame`, what the red underline already knows.
 *
 * What is pinned here is the boundary the preload draws around a checker it
 * does not own: a word the menu could not have meant is never asked about, a
 * checker that throws is "spelled right" rather than a broken menu, and the
 * list handed to the page is capped and holds only strings.
 */

import { getDesktopBridge, BRIDGE_CHANNELS } from "@context/desktop-bridge";
import {
  checkSpelling,
  SPELLING_SUGGESTIONS_MAX,
  SPELLING_WORD_MAX,
} from "../src/core/shell/bridge.ts";
import { installed } from "./consoleBridge/fixtures.mjs";

const dictionary = {
  isWordMisspelled: (word) => word === "permissioning" || word === "zzqx",
  getWordSuggestions: (word) =>
    word === "permissioning" ? ["permission", "permissions", "permissioned", "", 7, "partitioning", "positioning", "provisioning"] : [],
};

export async function runSpellingChecks(check) {
  const shell = installed({ speller: dictionary });
  const bridge = getDesktopBridge({ desktop: shell.bridge });
  check("a version-8 shell with a checker is accepted by the page", bridge !== null);

  const flagged = await bridge.spelling.check("permissioning");
  check("a flagged word is reported misspelled", flagged.misspelled === true);
  check(
    "...with only real strings, capped for a menu",
    flagged.suggestions.length === SPELLING_SUGGESTIONS_MAX &&
      flagged.suggestions.every((s) => typeof s === "string" && s !== "") &&
      flagged.suggestions[0] === "permission",
  );

  const fine = await bridge.spelling.check("permission");
  check("a word the checker accepts is not misspelled, and offers nothing", !fine.misspelled && fine.suggestions.length === 0);

  const blank = await bridge.spelling.check("zzqx");
  check("a flagged word with no suggestions still says it is flagged", blank.misspelled && blank.suggestions.length === 0);

  check(
    "the check crosses no channel — the word never reaches the main process",
    shell.invoked.length === 0 &&
      !Object.values(BRIDGE_CHANNELS).some((channel) => channel.includes("spell")),
  );

  const asked = [];
  const recording = {
    isWordMisspelled: (word) => (asked.push(word), true),
    getWordSuggestions: () => ["x"],
  };
  checkSpelling(recording, "two words");
  checkSpelling(recording, "a".repeat(SPELLING_WORD_MAX + 1));
  checkSpelling(recording, "");
  checkSpelling(recording, { toString: () => "word" });
  check("a phrase, an overlong run, an empty string or a non-string is never asked about", asked.length === 0);

  const throwing = {
    isWordMisspelled: () => {
      throw new Error("checker gone");
    },
    getWordSuggestions: () => [],
  };
  const survived = checkSpelling(throwing, "word");
  check("a checker that throws reads as spelled right, not as a broken menu", !survived.misspelled);

  const unchecked = installed({});
  const none = await unchecked.bridge.spelling.check("permissioning");
  check("a preload with no checker answers every word as spelled right", !none.misspelled && none.suggestions.length === 0);
}
