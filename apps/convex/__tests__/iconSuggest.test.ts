/**
 * THE SUGGESTED ICON.
 *
 * Opening the icon picker asks Clef for an emoji from the folder's or note's
 * name, out of every emoji the picker offers (decided by the owner,
 * 2026-10-14; nothing is given one on its own). What has teeth:
 *
 *  - every standard emoji is asked about, each exactly once, in questions
 *    and requests Clef accepts;
 *  - only the name is sent, never a path's folders and never a note's text;
 *  - a name that says nothing (`untitled-…`, `New folder`) sends nothing;
 *  - the answer is always one of the emoji a question offered, so an answer
 *    outside it is no suggestion rather than a guess;
 *  - one failed request leaves out its groups, not the suggestion;
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
 *   `readPicks` without the offered-options check                       2 failed
 *   `groupRequests` dropping the last group                             2 failed
 *   `suggest` authorizing at "member"                                   1 failed
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  GROUP_SIZE,
  SUGGEST_EMOJI,
  finalRequest,
  groupRequests,
  nameSaysSomething,
  nameWords,
  randomIcon,
  readPicks,
  suggestCandidates,
} from "@context/shared/src/iconSuggest";
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
  test("every standard emoji is asked about exactly once, in questions and requests Clef accepts", () => {
    const requests = groupRequests("1-projects/once", "folder");
    const asked: string[] = [];
    for (const request of requests) {
      const names = Object.keys(request.questions);
      expect(names.length).toBeGreaterThanOrEqual(1);
      expect(names.length).toBeLessThanOrEqual(16);
      expect(JSON.stringify(request).length).toBeLessThan(160_000);
      for (const [name, question] of Object.entries(request.questions)) {
        expect(name).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
        const keys = Object.keys(question.criteria);
        expect(keys.length).toBeGreaterThanOrEqual(2);
        expect(keys.length).toBeLessThanOrEqual(GROUP_SIZE);
        for (const key of keys) expect(key).toMatch(/^[a-z0-9][a-z0-9_-]{0,59}$/);
        for (const about of Object.values(question.criteria)) expect(about.length).toBeLessThanOrEqual(400);
        asked.push(...keys);
      }
    }
    const total = suggestCandidates().length;
    expect(total).toBeGreaterThan(1800);
    expect(new Set(asked).size).toBe(total);
    expect(asked).toHaveLength(total);
    expect(requests.length).toBeLessThanOrEqual(2);
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
    const [request] = groupRequests("2-areas/private-client/taxes-2026.md", "note");
    expect(request!.state).toContain('"taxes"');
    expect(request!.state).not.toContain("private-client");
    expect(finalRequest("2-areas/private-client/taxes-2026.md", "note", [0, 1]).state).not.toContain("private-client");
  });

  test("an answer is an emoji the question offered, or nothing", () => {
    const request = finalRequest("taxes", "folder", [3, 40]);
    const pick = (choice: string) => ({ emoji: { type: "choice", choice, confidence: 0.4 } });
    expect(readPicks(request, pick("e40"))).toEqual([40]);
    expect(readPicks(request, pick("e41"))).toEqual([]);
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

/** Picks the pushpin wherever it is offered, and otherwise the first option. */
const likesPushpins: Answerer = (_question, criteria) =>
  Object.keys(criteria).find((key) => criteria[key]!.startsWith(PUSHPIN)) ?? Object.keys(criteria)[0]!;

async function fixture(answer: Answerer = likesPushpins, failFirst = false): Promise<Fixture> {
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
    if (failFirst && body.questions.g0 !== undefined) return new Response("no", { status: 503 });
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
  test("asks about every emoji, then about each group's best, from the name alone", async () => {
    const f = await fixture();
    expect(await suggest(f, f.editor, "tex/routines/once")).toBe(PUSHPIN);
    const rounds = groupRequests("tex/routines/once", "folder").length;
    expect(f.sent).toHaveLength(rounds + 1);
    const final = f.sent.at(-1)!.questions.emoji!.criteria;
    expect(Object.keys(final).length).toBe(Math.ceil(suggestCandidates().length / GROUP_SIZE));
    expect(Object.values(final).some((about) => about.startsWith(PUSHPIN))).toBe(true);
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
    expect(f.sent).toHaveLength(groupRequests("2-areas/taxes", "folder").length);
  });

  test("a failed request leaves out its groups, not the suggestion", async () => {
    const f = await fixture(likesPushpins, true);
    // The pushpin is far from the table's start, so a later request offers it.
    expect(await suggest(f, f.editor, "tex/routines/once")).toBe(PUSHPIN);
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
