/**
 * THE SUGGESTED ICON.
 *
 * Opening the icon picker asks Clef for an emoji from the folder's or note's
 * name (decided by the owner, 2026-10-14; nothing is given one on its own).
 * What has teeth:
 *
 *  - only the name is sent, never a path's folders and never a note's text;
 *  - a name that says nothing (`untitled-…`, `New folder`) sends nothing;
 *  - the answer is always one of the emoji the list offers, so an answer
 *    outside it, or "none of these", is no suggestion rather than a guess;
 *  - switched off, nothing is sent;
 *  - a member who could not set the icon cannot ask;
 *  - every emoji the list holds is one the picker itself offers.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `nameSaysSomething` always true                                     2 failed
 *   `readEmoji` returning the raw choice                                3 failed
 *   `suggest` authorizing at "member"                                   1 failed
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  NO_TOPIC,
  SUGGEST_EMOJI,
  SUGGEST_TOPICS,
  emojiRequest,
  nameSaysSomething,
  nameWords,
  randomIcon,
  readEmoji,
  readTopic,
  topicRequest,
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

describe("the list and the questions, as data", () => {
  test("every topic fits in one Clef question, with option keys Clef accepts", () => {
    for (const topic of SUGGEST_TOPICS) {
      expect(topic.emoji.length).toBeGreaterThanOrEqual(2);
      expect(topic.emoji.length).toBeLessThanOrEqual(64);
      expect(new Set(topic.emoji.map((one) => one.name)).size).toBe(topic.emoji.length);
      for (const one of topic.emoji) expect(one.name).toMatch(/^[a-z0-9][a-z0-9_-]{0,59}$/);
    }
    expect(SUGGEST_TOPICS.length + 1).toBeLessThanOrEqual(64);
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
    for (const said of ["2-areas/taxes", "1-projects/walnut-credenza.md", "Q4 budget.md", "02-recipes", "日本語"]) {
      expect(nameSaysSomething(said)).toBe(true);
    }
    expect(nameWords("1-projects/02-walnut_credenza-2026-10-14.md")).toBe("walnut credenza");
  });

  test("the question carries the name and nothing else", () => {
    const request = topicRequest("2-areas/private-client/taxes-2026.md", "note");
    expect(request.state).toContain('"taxes"');
    expect(request.state).not.toContain("private-client");
    const criteria = (request.questions.topic as { criteria: Record<string, string> }).criteria;
    expect(Object.keys(criteria)).toContain(NO_TOPIC);
    expect(emojiRequest("taxes", "folder", "money")).not.toBeNull();
    expect(emojiRequest("taxes", "folder", "__proto__")).toBeNull();
  });

  test("an answer is an emoji the list offers, or nothing", () => {
    const pick = (question: string, choice: string) => ({ [question]: { type: "choice", choice, confidence: 0.4 } });
    expect(readTopic(pick("topic", "money"))).toBe("money");
    expect(readTopic(pick("topic", NO_TOPIC))).toBeNull();
    expect(readTopic(pick("topic", "constructor"))).toBeNull();
    expect(readTopic(null)).toBeNull();
    expect(readEmoji(pick("emoji", "moneybag"), "money")).toBe("💰");
    expect(readEmoji(pick("emoji", "pizza"), "money")).toBeNull();
    expect(readEmoji({ emoji: { type: "noul", noul: 1 } }, "money")).toBeNull();
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

async function fixture(answers: { topic?: string; emoji?: string } = {}): Promise<Fixture> {
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
    const question = Object.keys(body.questions)[0]!;
    const choice = question === "topic" ? (answers.topic ?? "money") : (answers.emoji ?? "moneybag");
    return new Response(JSON.stringify({ answers: { [question]: { type: "choice", choice, confidence: 0.7 } } }));
  });
  return { t, editor, member, workspaceId, sent };
}

const suggest = (f: Fixture, userId: Id<"users">, path: string) =>
  asUser(f.t, userId).action(api.functions.folderIcons.suggest, { workspaceId: f.workspaceId, path });

describe("folderIcons.suggest", () => {
  test("asks for a topic, then an emoji in it, from the name alone", async () => {
    const f = await fixture();
    expect(await suggest(f, f.editor, "2-areas/taxes")).toBe("💰");
    expect(f.sent).toHaveLength(2);
    expect(Object.keys(f.sent[1]!.questions.emoji!.criteria)).toContain("moneybag");
    expect(f.sent.every((one) => !one.state.includes("2-areas"))).toBe(true);
  });

  test("a name that says nothing sends nothing", async () => {
    const f = await fixture();
    expect(await suggest(f, f.editor, "0-inbox/untitled-2026-10-14.md")).toBeNull();
    expect(f.sent).toHaveLength(0);
  });

  test("none of these is no suggestion, and so is an emoji the list did not offer", async () => {
    const none = await fixture({ topic: NO_TOPIC });
    expect(await suggest(none, none.editor, "2-areas/taxes")).toBeNull();
    expect(none.sent).toHaveLength(1);
    const odd = await fixture({ emoji: "pizza" });
    expect(await suggest(odd, odd.editor, "2-areas/taxes")).toBeNull();
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
