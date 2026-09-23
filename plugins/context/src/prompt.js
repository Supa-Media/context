/**
 * The two questions `install` asks, on a plain terminal with no dependency.
 *
 * Both have a default that is right for most people, so pressing Enter works,
 * and `-y` skips them entirely (it never needs a terminal, so scripts and CI
 * can install too).
 */

import { createInterface } from "node:readline/promises";

async function ask(question, { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Pick agents from a numbered list. Everything detected starts ticked; typing
 * numbers (`1 3`) keeps only those.
 */
export async function chooseAgents(agents, io) {
  if (!agents.length) return [];
  const lines = agents.map((agent, index) => `  ${index + 1}. ${agent.name}`).join("\n");
  const answer = await ask(`Install Context into:\n${lines}\nPress Enter for all, or type the numbers to keep: `, io);
  if (!answer) return agents;
  const picked = new Set(answer.split(/[\s,]+/).map((token) => Number(token) - 1));
  return agents.filter((_, index) => picked.has(index));
}

/** Pick one workspace for this folder; Enter takes the first (the default). */
export async function chooseWorkspace(workspaces, io) {
  if (workspaces.length <= 1) return workspaces[0]?.slug || null;
  const lines = workspaces.map((entry, index) => `  ${index + 1}. @${entry.slug} (${entry.kind})`).join("\n");
  const answer = await ask(`Which workspace does this folder belong to?\n${lines}\nPress Enter for 1: `, io);
  const index = answer ? Number(answer) - 1 : 0;
  return workspaces[index]?.slug || workspaces[0].slug;
}
