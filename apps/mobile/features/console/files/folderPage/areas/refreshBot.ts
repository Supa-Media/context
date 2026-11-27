/**
 * Refresh: mail a bot its setup again (its own picture for its card, Context's current setup), from the bot panel's button or
 * the bots page's Refresh all (Dev2, 2026-11-27: "maybe a refresh all button?"). A line is added to the reader's mail
 * with the bot, at the version read, or that mail is started.
 *
 * When each bot was last refreshed this session is kept here, by bot, so the panel says it for the bot that was
 * refreshed and no other (Dev2, 2026-11-27: "refreshing one of my bots, updates the text for other bots to show they
 * are refreshed as well even though they aren't"). Imports nothing from React.
 */

import { withMail } from "../../../mailPage/MailThread";
import { firstMailNote } from "./areaMail";
import { botMailNote, refreshAskFor, type Bot } from "./bots";

export interface RefreshIO {
  read(path: string): Promise<{ text: string; etag?: string }>;
  write(path: string, text: string, expectedEtag?: string): Promise<unknown>;
}

export interface RefreshDeps {
  me: string;
  workspace?: string;
  /** Whether the reader's mail with this bot already exists. */
  exists: boolean;
  create: (path: string, text: string) => Promise<unknown>;
  io?: RefreshIO;
}

/** Sends one bot its Refresh: `{at, path, started}` when it went, else the reason it didn't. */
export async function refreshBot(bot: Bot, deps: RefreshDeps): Promise<{ at: string; path: string; started: boolean } | { error: string }> {
  const path = botMailNote(bot, deps.me);
  const text = refreshAskFor(bot.name, deps.workspace, bot.card.path);
  try {
    if (deps.exists) {
      if (deps.io === undefined) return { error: "open" };
      for (let attempt = 0; ; attempt += 1) {
        const note = await deps.io.read(path);
        const next = withMail(note.text, deps.me, text);
        if ("error" in next) return { error: next.error };
        try {
          await deps.io.write(path, next.text, note.etag);
          break;
        } catch (failure) {
          if (attempt >= 1) throw failure;
        }
      }
    } else {
      const note = firstMailNote(bot.name, deps.me, text);
      if ("error" in note) return { error: note.error };
      await deps.create(path, note.text);
    }
    const at = new Date().toISOString();
    noteRefreshed(bot.slug, at);
    return { at, path, started: !deps.exists };
  } catch {
    return { error: "That didn't send. Try again." };
  }
}

const refreshed = new Map<string, string>();
const started = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function noteRefreshed(slug: string, at: string): void {
  refreshed.set(slug, at);
  version += 1;
  for (const listener of listeners) listener();
}

/** When this session last sent this bot a Refresh, or undefined. */
export function refreshedThisSession(slug: string): string | undefined {
  return refreshed.get(slug);
}

/** A mail note started this session, before the page's listing shows it. */
export function startedMail(path: string): boolean {
  return started.has(path);
}

export function noteStarted(path: string): void {
  started.add(path);
}

export function subscribeRefreshes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function refreshesVersion(): number {
  return version;
}

/** Forget everything, for a test. */
export function resetRefreshes(): void {
  refreshed.clear();
  started.clear();
  version += 1;
}
