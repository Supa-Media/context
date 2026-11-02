/**
 * Which chat a history file in the app is (owner, 2026-11-02: the history file
 * opens as the chat's history, "a special object", never as text). Pure.
 *
 * - `tex/history.ledger.json` in the viewer's own personal workspace is their
 *   own chat with Tex ("me").
 * - `tex/groups/<words>/history.ledger.json` is the group chat whose home is
 *   that folder in that workspace, found among the viewer's own chats, so a
 *   chat they are not one of the people of is never named here (the gateway
 *   refuses it anyway).
 * - Anything else (someone else's personal workspace) is null: it is that
 *   person's to open, on their own page.
 */

import type { ChatRef } from "../page/texPageTypes";

const OWN = "tex/history.ledger.json";
const HOME = /^(tex\/groups\/[^/]+)\/history\.ledger\.json$/;

export type HistoryFileChat = { kind: "me" } | { kind: "group"; folder: string } | { kind: "none" };

/** What the path and workspace say before any chat list is read. */
export function historyFileChat(path: string, workspace: { id: string; slug: string }, own: { id: string } | null): HistoryFileChat {
  if (path === OWN) return own !== null && own.id === workspace.id ? { kind: "me" } : { kind: "none" };
  const home = HOME.exec(path);
  return home ? { kind: "group", folder: home[1]! } : { kind: "none" };
}

/** The group chat whose home is `folder` in the workspace `@slug`, among the viewer's chats, or null. */
export function groupChatAt(chats: readonly ChatRef[], slug: string, folder: string): ChatRef | null {
  const context = `@${slug.replace(/^@+/, "")}`.toLowerCase();
  return chats.find((c) => c.key !== "me" && c.home?.context.toLowerCase() === context && c.home.folder === folder) ?? null;
}
