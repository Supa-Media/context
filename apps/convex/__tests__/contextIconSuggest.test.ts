/**
 * THE SUGGESTED CONTEXT ICON (owner, 2026-10-21: the picker opens on Context's
 * own hundred icons, so Suggested comes from them).
 *
 *  - a word of the name that is one of an icon's words answers with no model;
 *  - otherwise Clef picks a family, then an icon in the two likeliest, and
 *    every question stays inside Clef's 64 options;
 *  - an answer outside what was offered is no suggestion;
 *  - a name that says nothing asks nothing.
 */

import { describe, expect, test } from "vitest";
import { CONTEXT_ICONS, contextIconOf } from "@context/shared/src/contextIcons.cjs";
import { contextIconByWords, familyRequest, iconRequest, suggestContextIconFor } from "@context/shared/src/contextIconSuggest";
import type { SuggestRequest } from "@context/shared/src/iconSuggest";

describe("a name's own words", () => {
  test.each([
    ["2-areas/recipes", "utensils"],
    ["2-areas/Money and taxes", "coin"],
    ["receipts-2026", "receipt"],
    ["1-projects/Masters applications/university.md", "cap"],
    ["Small group (Thursdays)", "group"],
    ["Setlists", "music"],
  ])("%j is %s", (path, name) => {
    expect(contextIconByWords(path)?.name).toBe(name);
  });

  test("a name no icon's words hold has none", () => {
    expect(contextIconByWords("Biscuit")).toBeNull();
  });
});

describe("Clef over the hundred", () => {
  test("twelve families, then at most two dozen icons: inside Clef's 64 options", () => {
    expect(Object.keys(familyRequest("Biscuit").questions.group!.criteria)).toHaveLength(12);
    const second = iconRequest("Biscuit", [0, 1])!;
    const options = Object.keys(second.questions.emoji!.criteria);
    expect(options.length).toBeGreaterThan(0);
    expect(options.length).toBeLessThanOrEqual(64);
  });

  test("asks the family, then the icon in it, and answers that icon", async () => {
    const asked: SuggestRequest[] = [];
    const home = CONTEXT_ICONS.findIndex((icon) => icon.name === "paw");
    const icon = await suggestContextIconFor("Biscuit", async (request) => {
      asked.push(request);
      if ("group" in request.questions) return { group: { type: "choice", choice: "g2", probabilities: { g2: 0.8, g3: 0.1 } } };
      return { emoji: { type: "choice", choice: `e${home}` } };
    });
    expect(contextIconOf(icon)?.name).toBe("paw");
    expect(asked).toHaveLength(2);
    // Only the name's words reach the model.
    expect(asked[0]!.state).toBe('A folder in someone\'s notes is named "Biscuit".');
  });

  test("an answer it was not offered is no suggestion", async () => {
    const icon = await suggestContextIconFor("Biscuit", async (request) =>
      "group" in request.questions ? { group: { type: "choice", choice: "g2" } } : { emoji: { type: "choice", choice: "e0" } },
    );
    expect(icon).toBeNull();
  });

  test("a name that says nothing, or one its words answer, never asks", async () => {
    let calls = 0;
    const decide = async () => {
      calls += 1;
      return null;
    };
    expect(await suggestContextIconFor("untitled-2026-10-21", decide)).toBeNull();
    expect(await suggestContextIconFor("recipes", decide)).toBe("context:icon:utensils");
    expect(calls).toBe(0);
  });
});
