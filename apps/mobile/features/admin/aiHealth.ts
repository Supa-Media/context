/**
 * A job's overview (board 21 of the AI tools plan): what waits on a person,
 * when each case group last ran on today's live, and the live prompt's
 * health. The ML review of 2026-10-16 asked for two checks a person cannot
 * do by eye on a 30,000-character prompt: a rule written twice (prompts grow
 * by appending, and the copies drift apart), and a case whose answer is
 * written into the prompt, which makes its score worthless: the setup passes
 * it by reading the answer, not by doing the job.
 *
 * Both are text matches, so they flag what to look at rather than prove
 * anything; a contradiction needs a reader, and is not attempted.
 */

import { splitFront } from "./aiNotes";
import { DRAFTED_KEY } from "./aiModel";
import type { JobPage, RunRead } from "./aiModel";
import { runsPassed, type Passed } from "./aiExperiments";
import { groupTitle, parseTestList } from "./testList";

/** A sentence this short says too little to count as a rule written twice. */
const MIN_RULE_WORDS = 7;
/** A rule or question this short is too common to mean the answer is in the prompt. */
const MIN_ANSWER_WORDS = 5;

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
const norm = (text: string): string => words(text).join(" ");

/** The prompt's sentences, one per line or full stop, without list marks and headings. */
function sentences(prompt: string): string[] {
  const { body } = splitFront(prompt);
  return body
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .flatMap((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => words(sentence).length >= MIN_RULE_WORDS);
}

/** Sentences the prompt says more than once, with how many times, most first. */
export function repeatedRules(prompt: string): { text: string; times: number }[] {
  const counts = new Map<string, { text: string; times: number }>();
  for (const sentence of sentences(prompt)) {
    const key = norm(sentence);
    const found = counts.get(key);
    if (found) found.times += 1;
    else counts.set(key, { text: sentence, times: 1 });
  }
  return [...counts.values()].filter((item) => item.times > 1).sort((a, b) => b.times - a.times);
}

export interface AnsweredCase {
  group: string;
  number: number;
  title: string;
  /** What of the case the prompt carries word for word. */
  found: string;
}

/** Cases whose question, or one of whose `must` lines, the prompt carries word for word. */
export function casesInPrompt(prompt: string, groups: readonly { title: string; text: string }[]): AnsweredCase[] {
  const haystack = ` ${norm(splitFront(prompt).body)} `;
  const out: AnsweredCase[] = [];
  for (const group of groups) {
    for (const item of parseTestList(group.text).cases) {
      const candidates = [item.title, ...item.rules.filter((rule) => rule.key === "must").map((rule) => rule.value)];
      const hit = candidates.find((text) => words(text).length >= MIN_ANSWER_WORDS && haystack.includes(` ${norm(text)} `));
      if (hit !== undefined) out.push({ group: group.title, number: item.number, title: item.title, found: hit });
    }
  }
  return out;
}

/** Cases the improver drafted and nobody has checked, by group. */
export function draftedCases(groups: readonly { title: string; text: string }[]): { group: string; count: number }[] {
  return groups
    .map((group) => ({ group: group.title, count: parseTestList(group.text).cases.filter((item) => item.other.some((line) => line.key === DRAFTED_KEY)).length }))
    .filter((item) => item.count > 0);
}

/** A case group's name: its `title:`, else its note's. */
export function caseGroupTitle(text: string | undefined, fallback: string): string {
  return (text === undefined ? null : groupTitle(parseTestList(text))) ?? fallback;
}

export interface GroupOnLive {
  path: string;
  name: string;
  /** The day of its newest round, or null when it was never run. */
  day: string | null;
  /** True when that round ran on the setup that is live today. */
  onLive: boolean;
  /** Live's runs passed in that round, when it wrote a case table. */
  passed: Passed | null;
}

/**
 * Each case group's newest round and whether it ran on today's live: a round
 * from before `live_since` measured a setup that is no longer what people get.
 */
export function groupsOnLive(page: JobPage, liveSince: string | null): GroupOnLive[] {
  const liveColumn = (read: RunRead): string => (read.setups.some((setup) => setup.setup === page.live) ? (page.live as string) : "production");
  return page.row.tests.map((test) => {
    const last = [...page.runs].reverse().find((run) => run.row.test === test.name);
    if (last === undefined) return { path: test.path, name: test.name, day: null, onLive: false, passed: null };
    const day = last.row.day;
    return {
      path: test.path,
      name: test.name,
      day,
      onLive: liveSince === null || (day !== null && day >= liveSince.slice(0, 10)),
      passed: last.read === null ? null : runsPassed(last.read, liveColumn(last.read)),
    };
  });
}
