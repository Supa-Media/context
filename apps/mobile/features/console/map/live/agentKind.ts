import type { MapColors } from "../../../design/tokens/colors";

/**
 * Which AI an actor is, and the colour it is drawn in.
 *
 * One pure module that the React faces and the canvas engine both read, so
 * the feed, the face pile and the drawing on the map always agree. Nothing
 * here knows React or the canvas.
 *
 * The rule (owner, 2026-10-09): every AI tool has a colour, and people keep
 * their faces. An agent is always a robot (PR #1097), so the colour is what
 * tells Claude from Codex on the map. The texting assistant is not a robot: it
 * is a round teal badge with a speech bubble.
 *
 * Classification reads the tool's name, the part after the owner's
 * possessive: "@maya's Claude" is Claude because of "Claude", and "@claude's
 * Codex" is Codex because of "Codex". The owner's name never decides which
 * tool it is. A name is display text a client asserted when it registered, so
 * this decides how a thing is drawn, never who may do what.
 */

/** The kinds of AI the map knows by name. `other` is any tool it does not. */
export type AgentKind = "claude" | "codex" | "chatgpt" | "context" | "other";

/** The map colours an agent is drawn with (the tokens in `design/tokens/colors.ts`). */
export type AgentTintColors = Pick<
  MapColors,
  "agentClaude" | "agentCodex" | "agentChatgpt" | "agentContext" | "agentBlue" | "agentPink" | "agentAmber" | "agentGlyph"
>;

/**
 * The name the texting assistant's client is registered under
 * (`TEXTS_CLIENT_NAME` in `apps/convex/functions/textLinks.ts`). The activity
 * file records a tool by this name, not by its client id, so this is the
 * identifier the phone can see. `apps/mobile/__tests__/liveMapAgentKind.test.ts`
 * fails if the two drift apart.
 */
export const TEXTS_CLIENT_NAME = "Texts (iMessage)";

/**
 * The name the app's own console is registered under
 * (`CONSOLE_CLIENT_NAME` in `apps/convex/functions/agentGrant.ts`). Its edits
 * are recorded under it, and they are a person's hand, not a tool's.
 */
export const CONSOLE_CLIENT_NAME = "Context (this app)";

const POSSESSIVE = "'s ";

/** The tool part of a name: "@maya's Claude Code" is "Claude Code"; "Cursor" is "Cursor". */
export function toolNameOf(name: string): string {
  const at = name.lastIndexOf(POSSESSIVE);
  return (at >= 0 ? name.slice(at + POSSESSIVE.length) : name).trim();
}

/** The owner part of a name: "@maya's Claude" is "@maya"; a name with no owner is null. */
export function ownerNameOf(name: string): string | null {
  const at = name.lastIndexOf(POSSESSIVE);
  return at >= 0 ? name.slice(0, at).trim() || null : null;
}

/**
 * Which AI an actor is, or null when it is not an AI at all.
 *
 * A person is never an AI, whatever their name, and neither is the app's own
 * console: its edits are a person's hand (`consoleHandOf`).
 */
export function agentKindOf(actor: { kind: "person" | "agent"; name: string }): AgentKind | null {
  if (actor.kind !== "agent") return null;
  const tool = toolNameOf(actor.name);
  if (tool === CONSOLE_CLIENT_NAME) return null;
  if (tool === TEXTS_CLIENT_NAME) return "context";
  if (/claude/i.test(tool)) return "claude";
  if (/codex/i.test(tool)) return "codex";
  if (/chatgpt|openai/i.test(tool)) return "chatgpt";
  return "other";
}

/**
 * The person whose hand an app edit is, when `name` is the app's own console;
 * null for anything else. "@dev2's Context (this app)" is "@dev2".
 */
export function consoleHandOf(name: string): string | null {
  if (toolNameOf(name) !== CONSOLE_CLIENT_NAME) return null;
  return ownerNameOf(name) ?? "Someone";
}

/**
 * A stable spare index for a tool the map does not know: FNV-1a over the tool
 * name's lowercase characters, then Murmur3's finaliser (FNV's low bits move
 * little between short, similar names). Deliberately fixed, never seeded, so
 * the same tool is the same colour on every device and in every session.
 */
export function spareIndexOf(name: string, count: number): number {
  const key = toolNameOf(name).toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return (hash >>> 0) % count;
}

/**
 * The tint an AI is drawn in. Claude, Codex, ChatGPT and the texting assistant
 * have their own; any other tool takes one of three spare colours from its name.
 */
export function agentTint(kind: AgentKind, name: string, colors: AgentTintColors): string {
  switch (kind) {
    case "claude":
      return colors.agentClaude;
    case "codex":
      return colors.agentCodex;
    case "chatgpt":
      return colors.agentChatgpt;
    case "context":
      return colors.agentContext;
    case "other": {
      const spare = [colors.agentBlue, colors.agentPink, colors.agentAmber] as const;
      return spare[spareIndexOf(name, spare.length)]!;
    }
  }
}

/** How an agent is drawn: a robot on a square tile, or the texting assistant's round badge. */
export type AgentPaint = {
  kind: AgentKind;
  shape: "robot" | "bubble";
  tint: string;
  /** The glyph's colour, chosen to read on the tint in this theme. */
  glyph: string;
};

/** The paint for an agent, by its name. Every agent has one. */
export function agentPaint(name: string, colors: AgentTintColors): AgentPaint {
  const kind = agentKindOf({ kind: "agent", name }) ?? "other";
  return {
    kind,
    shape: kind === "context" ? "bubble" : "robot",
    tint: agentTint(kind, name, colors),
    glyph: colors.agentGlyph,
  };
}

/** The paint for an actor, or null for a person: a person is drawn as their face, not as paint. */
export function agentPaintOf(actor: { kind: "person" | "agent"; name: string }, colors: AgentTintColors): AgentPaint | null {
  if (actor.kind !== "agent") return null;
  return agentPaint(actor.name, colors);
}
