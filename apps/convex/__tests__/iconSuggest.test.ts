/**
 * THE SUGGESTED ICON.
 *
 * Opening the icon picker asks Clef for an emoji from the folder's or note's
 * name, out of every emoji the picker offers (decided by the owner,
 * 2026-10-14; nothing is given one on its own). What has teeth:
 *
 *  - every standard emoji is in exactly one of 64 even groups, and both
 *    questions are ones the Worker accepts;
 *  - only the name is sent, never a path's folders and never a note's text;
 *  - a name that says nothing (`untitled-…`, `New folder`) sends nothing;
 *  - the answer is always one of the emoji a question offered, so an answer
 *    outside it is no suggestion rather than a guess;
 *  - a failed request is asked once more;
 *  - switched off, nothing is sent;
 *  - a member who could not set the icon cannot ask.
 *
 * `iconSuggest.live.test.ts` asks the real model about real names.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `nameSaysSomething` always true                                     2 failed
 *   `readPicks` without the offered-options check                       1 failed
 *   `suggestGroups` dropping the table's last emoji                     1 failed
 *   `suggest` authorizing at "member"                                   1 failed
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  GROUPS,
  SUGGEST_EMOJI,
  emojiRequest,
  groupRequest,
  nameSaysSomething,
  nameWords,
  randomIcon,
  readPicks,
  suggestCandidates,
  suggestGroups,
} from "@context/shared/src/iconSuggest";
import { readDecideRequest } from "../../../infra/transcribe-worker/src/decide";
import { TRANSCRIBE_WORKER_SECRET_ENV_VAR, TRANSCRIBE_WORKER_URL_ENV_VAR } from "../functions/meetings/transcribe";
import {
  type TestConvex,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const WORKER = "https://inference.example.invalid";
const PUSHPIN = "📌";

describe("the questions, as data", () => {
  test("every standard emoji is in exactly one of 64 even groups, and both questions are ones the Worker takes", () => {
    const total = suggestCandidates().length;
    expect(total).toBeGreaterThan(1800);
    const groups = suggestGroups();
    expect(groups).toHaveLength(GROUPS);
    const sizes = groups.map((group) => group.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64);
    expect(groups.flat()).toEqual(Array.from({ length: total }, (_, at) => at));

    const first = groupRequest("tex/routines/once", "folder");
    expect(readDecideRequest(first).ok).toBe(true);
    expect(Object.keys(first.questions.group!.criteria)).toHaveLength(GROUPS);
    for (const [group] of groups.entries()) {
      const second = emojiRequest("tex/routines/once", "folder", group)!;
      expect(readDecideRequest(second).ok).toBe(true);
    }
    expect(emojiRequest("x", "folder", GROUPS)).toBeNull();
    expect(emojiRequest("x", "folder", -1)).toBeNull();
  });

  test("a name that says nothing is not worth asking about", () => {
    for (const empty of [
      "0-inbox/untitled-2026-10-14.md",
      "untitled-2026-10-14-2.md",
      "1-projects/New folder",
      "New note 3.md",
      "asdf",
      "2026-10-14.md",
      "x.excalidraw.md",
      "1-projects/01-",
    ]) {
      expect(nameSaysSomething(empty)).toBe(false);
    }
    for (const said of ["2-areas/taxes", "1-projects/walnut-credenza.md", "Q4 budget.md", "02-recipes", "日本語", "tex/routines/once"]) {
      expect(nameSaysSomething(said)).toBe(true);
    }
    expect(nameWords("1-projects/02-walnut_credenza-2026-10-14.md")).toBe("walnut credenza");
  });

  test("the question carries the name and nothing else", () => {
    const request = groupRequest("2-areas/private-client/taxes-2026.md", "note");
    expect(request.state).toContain('"taxes"');
    expect(request.state).not.toContain("private-client");
    expect(emojiRequest("2-areas/private-client/taxes-2026.md", "note", 3)!.state).not.toContain("private-client");
  });

  test("an answer is an emoji the question offered, or nothing", () => {
    const request = emojiRequest("taxes", "folder", 1)!;
    const inside = suggestGroups()[1]![0]!;
    const outside = suggestGroups()[2]![0]!;
    const pick = (choice: string) => ({ emoji: { type: "choice", choice, confidence: 0.4 } });
    expect(readPicks(request, pick(`e${inside}`))).toEqual([inside]);
    expect(readPicks(request, pick(`e${outside}`))).toEqual([]);
    expect(readPicks(request, pick("constructor"))).toEqual([]);
    expect(readPicks(request, { emoji: { type: "noul", noul: 1 } })).toEqual([]);
    expect(readPicks(request, null)).toEqual([]);
  });

  test("a random roll is one of the list's emoji, and never the one already shown", () => {
    const chars = new Set(SUGGEST_EMOJI.map((one) => one.char));
    for (const r of [0, 0.25, 0.5, 0.999999, 1]) expect(chars.has(randomIcon(() => r))).toBe(true);
    const first = randomIcon(() => 0);
    expect(randomIcon(() => 0, first)).not.toBe(first);
  });
});

interface Fixture {
  t: TestConvex;
  editor: Id<"users">;
  member: Id<"users">;
  workspaceId: Id<"workspaces">;
  sent: { state: string; questions: Record<string, { criteria: Record<string, string> }> }[];
}

type Answerer = (question: string, criteria: Record<string, string>) => string;

/** Picks the pushpin, or the group that lists it, and otherwise the first option. */
const likesPushpins: Answerer = (_question, criteria) =>
  Object.keys(criteria).find((key) => criteria[key]!.startsWith(PUSHPIN) || criteria[key]!.includes(`, ${PUSHPIN} `)) ??
  Object.keys(criteria)[0]!;

async function fixture(answer: Answerer = likesPushpins, fail: "never" | "once" | "always" = "never"): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "seyi@example.invalid");
  const editor = await createUser(t, "sayo@example.invalid");
  const member = await createUser(t, "john@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas", { kind: "shared" });
  await addMember(t, workspaceId, editor, "editor", owner);
  await addMember(t, workspaceId, member, "member", owner);

  const sent: Fixture["sent"] = [];
  vi.stubEnv(TRANSCRIBE_WORKER_URL_ENV_VAR, WORKER);
  vi.stubEnv(TRANSCRIBE_WORKER_SECRET_ENV_VAR, "test-only-secret");
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(WORKER)) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    if (body.questions.group !== undefined && (fail === "always" || (fail === "once" && sent.filter((one) => one.questions.group).length === 1))) {
      return new Response("no", { status: 503 });
    }
    const answers: Record<string, unknown> = {};
    for (const [name, question] of Object.entries(body.questions as Fixture["sent"][number]["questions"])) {
      answers[name] = { type: "choice", choice: answer(name, question.criteria), confidence: 0.7 };
    }
    return new Response(JSON.stringify({ answers }));
  });
  return { t, editor, member, workspaceId, sent };
}

const suggest = (f: Fixture, userId: Id<"users">, path: string) =>
  asUser(f.t, userId).action(api.functions.folderIcons.suggest, { workspaceId: f.workspaceId, path });

describe("folderIcons.suggest", () => {
  test("asks which group, then which emoji in it, from the name alone", async () => {
    const f = await fixture();
    expect(await suggest(f, f.editor, "tex/routines/once")).toBe(PUSHPIN);
    expect(f.sent).toHaveLength(2);
    expect(Object.keys(f.sent[0]!.questions.group!.criteria)).toHaveLength(GROUPS);
    expect(Object.values(f.sent[1]!.questions.emoji!.criteria).some((about) => about.startsWith(PUSHPIN))).toBe(true);
    expect(f.sent.every((one) => one.state.includes('"once"') && !one.state.includes("routines"))).toBe(true);
  });

  test("a name that says nothing sends nothing", async () => {
    const f = await fixture();
    expect(await suggest(f, f.editor, "0-inbox/untitled-2026-10-14.md")).toBeNull();
    expect(f.sent).toHaveLength(0);
  });

  test("an emoji the question did not offer is no suggestion", async () => {
    const f = await fixture(() => "e99999");
    expect(await suggest(f, f.editor, "2-areas/taxes")).toBeNull();
    expect(f.sent).toHaveLength(1);
  });

  test("a request that fails once is asked again", async () => {
    const f = await fixture(likesPushpins, "once");
    expect(await suggest(f, f.editor, "tex/routines/once")).toBe(PUSHPIN);
    expect(f.sent.filter((one) => one.questions.group)).toHaveLength(2);
  });

  test("a request that fails twice is no suggestion", async () => {
    const f = await fixture(likesPushpins, "always");
    expect(await suggest(f, f.editor, "tex/routines/once")).toBeNull();
    expect(f.sent).toHaveLength(2);
  });

  test("switched off, nothing is sent", async () => {
    const f = await fixture();
    await f.t.run((ctx) => ctx.db.insert("jevSwitches", { feature: "iconSuggest", off: true, updatedAt: Date.now() }));
    expect(await suggest(f, f.editor, "2-areas/taxes")).toBeNull();
    expect(f.sent).toHaveLength(0);
  });

  test("a member who could not set the icon cannot ask", async () => {
    const f = await fixture();
    const error = await captureError(() => suggest(f, f.member, "2-areas/taxes"));
    expect(errorCode(error)).toBe("INSUFFICIENT_ROLE");
    expect(f.sent).toHaveLength(0);
  });
});
