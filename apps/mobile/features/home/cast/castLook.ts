import { Platform } from "react-native";
import type { CastTerminal } from "@context/shared";
import { castTerminalLooks, type CastTerminalLookColors } from "../../design/tokens";

/*
  A chat app or terminal that is nobody's in particular: the system's own
  sans, not the console's, so the window reads as another app beside Context
  rather than a panel of it.
*/
export const SYSTEM_FONT = Platform.select({ web: "ui-sans-serif, system-ui, -apple-system, sans-serif", default: undefined });

/**
 * The look of an assistant's terminal: a Claude in the warm one, anything
 * else in the cool one, so a Claude Code and a Codex side by side are two
 * windows at a glance. No product's colours are borrowed beyond that warmth.
 */
export function terminalLook(agent: string): CastTerminalLookColors {
  return /claude/i.test(agent) ? castTerminalLooks.ember : castTerminalLooks.cool;
}

/** The terminal a window is, if the scene put its assistant in one. */
export function terminalOf(terminals: readonly CastTerminal[] | undefined, agent: string): CastTerminal | undefined {
  return terminals?.find((terminal) => terminal.agent.toLowerCase() === agent.toLowerCase());
}

/** How a printed line reads: a pass, a failure, or plain output. */
export function outputTone(line: string): "ok" | "fail" | "plain" {
  const text = line.trim();
  if (/^(✓|✔|PASS\b|ok\b)/.test(text)) return "ok";
  if (/^(✗|✘|×|FAIL\b|error\b|Error\b)/.test(text)) return "fail";
  return "plain";
}

/** A diff line's side: added, removed, or unchanged context. */
export function diffSide(line: string): "add" | "remove" | "same" {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-") || line.startsWith("−")) return "remove";
  return "same";
}

/** `+1 −1`: how many lines an edit added and removed. */
export function diffCount(diff: readonly string[]): string {
  const added = diff.filter((line) => diffSide(line) === "add").length;
  const removed = diff.filter((line) => diffSide(line) === "remove").length;
  return `+${added} −${removed}`;
}
