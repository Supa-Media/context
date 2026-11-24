/**
 * The app's one whole-note save: through the gateway into the note's workspace object for a person with the flag
 * `files.app-saves-in-objects` (`gatewayNoteWrite.ts`), and the control plane's `files.writeNote` otherwise, or
 * whenever the gateway hands the save back (decided by the owner, 2026-11-24;
 * `docs/decisions/storage-and-credentials/app-saves-through-gateway.md`).
 *
 * The same callable `useAction(api.functions.files.writeNote)` hands back, so every caller (the editor, the offline
 * outbox's drain, folder lists, the browse pane's tasks, the admin AI notes) swaps one line and nothing past it
 * changes. Its identity is stable: what it reads changes through a ref, so effects that list it do not re-run.
 *
 * The flag and the slugs are read when a save is made (`saveRouteReader`), never subscribed to on render.
 */

import { useCallback, useRef } from "react";
import { useAction, useConvex } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { useConsoleGrant } from "../../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../placeholderData";
import { APP_SAVES_FLAG, noteWriteUrl, writeNoteThroughGateway } from "./gatewayNoteWrite";

type WriteNoteAction = ReturnType<typeof useAction<typeof api.functions.files.writeNote>>;

/**
 * The save, given what it reads: the Convex action, whether the flag is on, the slug of each workspace, and the grant.
 * Apart from the hook so a test can drive it with no React and no Convex.
 */
export function gatewayFirstWriter(deps: {
  action: WriteNoteAction;
  /** Whether this person's saves go to the gateway, and the slug of the save's own workspace (`saveRouteReader`). */
  route: (workspaceId: string) => Promise<{ on: boolean; slug: string | null }>;
  token: (workspaceId: string, refresh: false | { rejected: string }) => Promise<string>;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}): WriteNoteAction {
  return (async (args: Parameters<WriteNoteAction>[0]) => {
    // Asked for this save's own workspace, so two saves at once can never be addressed by each other's slug.
    const route = typeof globalThis.fetch === "function" || deps.fetchImpl !== undefined ? await deps.route(args.workspaceId) : null;
    const url = route?.on === true ? noteWriteUrl(deps.endpoint ?? MCP_ENDPOINT, route.slug) : null;
    if (url !== null) {
      const written = await writeNoteThroughGateway({
        url,
        token: (refresh) => deps.token(args.workspaceId, refresh),
        workspaceId: args.workspaceId,
        path: args.path,
        text: args.text,
        ...(args.expectedEtag === undefined ? {} : { expectedEtag: args.expectedEtag }),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      });
      if (written !== null) return written as Awaited<ReturnType<WriteNoteAction>>;
    }
    return await deps.action(args);
  }) as WriteNoteAction;
}

/** How long one answer about the flag and the slugs is used before it is asked again. */
export const SAVE_ROUTE_TTL_MS = 60_000;

/**
 * Whether the person has the flag, and each workspace's slug, asked of the control plane once a minute at most and
 * only when a save is made: a one-off read through the client, so a screen that never saves subscribes to nothing.
 * Off for anything unsure: no answer, an error, or no slug.
 */
export function saveRouteReader(read: () => Promise<{ flags: readonly string[]; slugs: Map<string, string> }>, now = () => Date.now()) {
  let held: { at: number; flags: readonly string[]; slugs: Map<string, string> } | null = null;
  let pending: Promise<void> | null = null;
  const refresh = () => {
    pending ??= read()
      .then((answer) => {
        held = { at: now(), ...answer };
      })
      .catch(() => {
        held = { at: now(), flags: [], slugs: new Map() };
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return async (workspaceId: string): Promise<{ on: boolean; slug: string | null }> => {
    if (held === null || now() - held.at > SAVE_ROUTE_TTL_MS) await refresh();
    return { on: held?.flags.includes(APP_SAVES_FLAG) === true, slug: held?.slugs.get(workspaceId) ?? null };
  };
}

export function useWriteNote(): WriteNoteAction {
  const action = useAction(api.functions.files.writeNote);
  const client = useConvex();
  const mintGrant = useConsoleGrant();
  const now = useRef({ action, client, mintGrant });
  now.current = { action, client, mintGrant };
  const writer = useRef<WriteNoteAction | null>(null);
  if (writer.current === null) {
    const route = saveRouteReader(async () => {
      const convex = now.current.client;
      const [flags, workspaces] = await Promise.all([
        convex.query(api.functions.featureFlags.myFlags, {}),
        convex.query(api.functions.workspaces.listMyWorkspaces, {}),
      ]);
      return { flags, slugs: new Map(workspaces.map((workspace) => [workspace.workspaceId as string, workspace.slug])) };
    });
    writer.current = gatewayFirstWriter({
      action: ((args: Parameters<WriteNoteAction>[0]) => now.current.action(args)) as WriteNoteAction,
      route,
      token: async (workspaceId, refresh) =>
        (await now.current.mintGrant({ workspaceId: workspaceId as Parameters<WriteNoteAction>[0]["workspaceId"] }, refresh)).accessToken,
    });
  }
  return useCallback(((args: Parameters<WriteNoteAction>[0]) => writer.current!(args)) as WriteNoteAction, []);
}
