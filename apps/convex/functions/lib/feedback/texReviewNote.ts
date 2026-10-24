/**
 * Tex's self-review, as the notes it becomes in the pinned context
 * (`docs/decisions/texting-assistant/self-review.md`).
 *
 * Pure: what the scores are, where each note goes and what it says.
 * `functions/texReviews.ts` decides who a review may carry words for and
 * writes it.
 *
 * Two kinds of note, both under the Areas folder's `tex-reviews/`:
 *
 *   - one per finished conversation, only where everybody in it is staff or
 *     said yes to sharing: the scores, what the person expected, the prompt
 *     to fix it, and the conversation itself, fenced so nothing in it renders;
 *   - one a day, `scores/YYYY-MM-DD.md`, every review's numbers and nothing
 *     else, for everybody who texts Tex.
 */

import { fenceFor } from "./bugNote";

export const REVIEW_FOLDER = "tex-reviews";
const DEFAULT_AREAS_FOLDER = "areas";

/** What each score measures, 1 to 10, higher is better, in the order the notes print them. */
export const SCORE_KEYS = ["goal", "independence", "turns", "friendly", "calm"] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];
export type Scores = Record<ScoreKey, number>;

export const SCORE_LABELS: Record<ScoreKey, string> = {
  goal: "Got them what they wanted",
  independence: "Did it without handing work back",
  turns: "Few back-and-forths",
  friendly: "Sounded like a friend, not a chatbot",
  calm: "They stayed calm (10 = no frustration)",
};

/** What made a review run. */
export const REVIEW_REASONS = ["ended", "fix_this", "frustrated"] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/** Bounds on what a review may carry, so one review cannot fill a note. */
export const MAX_REVIEW_TEXT_CHARS = 2_000;
export const MAX_REVIEW_TRANSCRIPT_CHARS = 40_000;

/** The scores, each a whole number 1 to 10, or null when any is missing or out of range. */
export function parseScores(value: unknown): Scores | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const scores = {} as Scores;
  for (const key of SCORE_KEYS) {
    const n = record[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 10) return null;
    scores[key] = n;
  }
  return scores;
}

export function parseReason(value: unknown): ReviewReason | null {
  return typeof value === "string" && (REVIEW_REASONS as readonly string[]).includes(value) ? (value as ReviewReason) : null;
}

/** The review's words, each bounded, or null when there are none to keep. */
export interface ReviewWords {
  summary: string;
  expected: string;
  improve: string;
  transcript: string;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : [...text].slice(0, max).join("");
}

export function parseWords(value: unknown): ReviewWords | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const transcript = boundedText(record.transcript, MAX_REVIEW_TRANSCRIPT_CHARS);
  if (transcript === null) return null;
  return {
    summary: boundedText(record.summary, MAX_REVIEW_TEXT_CHARS) ?? "",
    expected: boundedText(record.expected, MAX_REVIEW_TEXT_CHARS) ?? "",
    improve: boundedText(record.improve, MAX_REVIEW_TEXT_CHARS) ?? "",
    transcript,
  };
}

/** `areas/tex-reviews`, under the folder doing the Areas job. */
export function reviewFolder(areas: string | null): string {
  const root = (areas ?? DEFAULT_AREAS_FOLDER).replace(/^\/+|\/+$/g, "");
  return `${root === "" ? DEFAULT_AREAS_FOLDER : root}/${REVIEW_FOLDER}`;
}

export function scoresNotePath(folder: string, day: string): string {
  return `${folder}/scores/${day}.md`;
}

/** The lowest score first, so a listing names what went worst: `2026-10-24 1631 independence 3 a1b2c3`. */
export function reviewNotePath(folder: string, input: { now: number; scores: Scores; id: string }): string {
  const stamp = new Date(input.now).toISOString();
  const worst = [...SCORE_KEYS].sort((a, b) => input.scores[a] - input.scores[b])[0];
  return `${folder}/${stamp.slice(0, 10)} ${stamp.slice(11, 13)}${stamp.slice(14, 16)} ${worst} ${input.scores[worst]} ${input.id.slice(0, 6)}.md`;
}

/** One line of plain words for a heading or a table cell: nothing in it renders. */
function plain(text: string, max = 120): string {
  const chars = [...text.replace(/[#`*_[\]()!<>|\\]/g, " ").replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

function fenced(text: string): string[] {
  const fence = fenceFor(text);
  return [`${fence}text`, text, fence];
}

export interface ReviewNoteInput {
  id: string;
  now: number;
  kind: "one" | "group";
  reason: ReviewReason;
  /** The handles of everyone in the conversation, without `@`. */
  people: string[];
  scores: Scores;
  words: ReviewWords;
}

export function renderReviewNote(input: ReviewNoteInput): string {
  const average = SCORE_KEYS.reduce((sum, key) => sum + input.scores[key], 0) / SCORE_KEYS.length;
  const lines = [
    "---",
    "status: new",
    "source: tex-self-review",
    `reviewed: ${new Date(input.now).toISOString()}`,
    `chat: ${input.kind === "group" ? "group" : "one-to-one"}`,
    `reason: ${input.reason}`,
    `people: ${JSON.stringify(input.people.map((handle) => `@${handle}`))}`,
    ...SCORE_KEYS.map((key) => `${key}: ${input.scores[key]}`),
    `average: ${average.toFixed(1)}`,
    `reference: ${JSON.stringify(input.id)}`,
    "---",
    "",
    `# ${plain(input.words.summary) || "Tex conversation review"}`,
    "",
    "| Measure | Score |",
    "| --- | --- |",
    ...SCORE_KEYS.map((key) => `| ${SCORE_LABELS[key]} | ${input.scores[key]} |`),
    "",
  ];
  // The model's words are fenced like the conversation: they were written from it.
  if (input.words.expected !== "") lines.push("## What they expected", "", ...fenced(input.words.expected), "");
  if (input.words.improve !== "") lines.push("## How Tex should improve", "", ...fenced(input.words.improve), "");
  lines.push("## The conversation", "", ...fenced(input.words.transcript), "");
  return lines.join("\n");
}

export interface ScoresRow extends Scores {
  at: number;
  kind: "one" | "group";
  reason: string;
}

/** A day's numbers, newest last, with the averages on top. Nobody is named and nothing anybody said is in it. */
export function renderScoresNote(day: string, rows: ScoresRow[]): string {
  const averageOf = (key: ScoreKey) => (rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row[key], 0) / rows.length);
  const lines = [
    "---",
    "source: tex-self-review",
    `day: ${day}`,
    `conversations: ${rows.length}`,
    "---",
    "",
    `# Tex conversation scores, ${day}`,
    "",
    "Every finished conversation with Tex, scored 1 to 10 by a small model, higher is better. Numbers only: nobody is named and nothing anybody said is kept here.",
    "",
    "| Measure | Average |",
    "| --- | --- |",
    ...SCORE_KEYS.map((key) => `| ${SCORE_LABELS[key]} | ${averageOf(key).toFixed(1)} |`),
    "",
    `| Time (UTC) | Chat | Why | ${SCORE_KEYS.join(" | ")} |`,
    `| --- | --- | --- | ${SCORE_KEYS.map(() => "---").join(" | ")} |`,
    ...rows.map(
      (row) =>
        `| ${new Date(row.at).toISOString().slice(11, 16)} | ${row.kind === "group" ? "group" : "1:1"} | ${plain(row.reason, 20)} | ${SCORE_KEYS.map((key) => row[key]).join(" | ")} |`,
    ),
    "",
  ];
  return lines.join("\n");
}
