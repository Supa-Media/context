/**
 * The Fetch from a URL sources' sync states, asked of the gateway once for every url source the page lists
 * (`dataSync.ts`), and the arm that Connect a source and Sync now call. An arm's answer is the run it made, so the
 * page says "Synced just now" or why the address was refused as soon as the person presses it.
 *
 * Absent where it can't be asked: no workspace or slug, a demo, or no gateway address. Then a url source says
 * "Not synced yet" and offers no Sync now.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../../../agent/useConsoleGrant";
import { useOptionalConsoleData } from "../../ConsoleDataContext";
import { selectedContext } from "../../types";
import { MCP_ENDPOINT } from "../../placeholderData";
import { Platform } from "react-native";
import { callDataSync, dataSyncUrl, syncStateOf, type DataSyncAnswer, type DataSyncBody, type SourceSync } from "./dataSync";
import { githubCalls, type GithubCalls } from "./githubSync";
import type { DataSource } from "./sources";
import type { SyncState } from "./words";

export interface SourceSyncs {
  /** The state of the source in `folder`, when it is a url source the sync was asked about. */
  readonly syncOf: (folder: string) => SyncState | undefined;
  /** Arm a url source by its about.md and run it now: null once armed, or the sentence saying why not. Absent for who may not. */
  readonly arm?: (aboutPath: string) => Promise<string | null>;
  /** An owner's Connect of an app source (Stripe, Cloudflare) with its read-only key, run now. Absent for anyone else. */
  readonly connect?: (aboutPath: string, key: string, account?: string) => Promise<string | null>;
  /** An owner's Disconnect: the app's key forgotten and its sources stopped. Absent for anyone else. */
  readonly disconnect?: (app: string) => Promise<string | null>;
  /** An owner's GitHub install and repository pick (`githubSync.ts`), on the web only. Absent for anyone else. */
  readonly github?: GithubCalls;
  /** Ask again how the sources' last runs went: after GitHub finished in another window. */
  readonly refresh: () => void;
}

/** The sources whose runs the sync object keeps: a url source's, the usage source's, and an app's an owner connected. */
const SYNCED = new Set(["fetch", "usage", "stripe", "cloudflare", "github"]);

/**
 * How long to wait before asking the status again, one entry per retry: a status ask that failed, or a first run
 * the gateway has started in the background and not finished. At most this many retries; then the page says what
 * it last knew, and a refresh starts the schedule again.
 */
export const STATUS_RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000] as const;

/** The delay before the next status ask after `answer`, the `tries`th retry so far; null when none is due. */
export function nextStatusRetry(answer: DataSyncAnswer, tries: number): number | null {
  if (tries >= STATUS_RETRY_MS.length) return null;
  const waiting = !answer.ok || answer.sources.some((one) => one.armed && one.last === null);
  return waiting ? STATUS_RETRY_MS[tries]! : null;
}

export function useSourceSyncs(sources: readonly DataSource[]): SourceSyncs {
  const data = useOptionalConsoleData();
  const current = data === null ? null : selectedContext(data);
  const mint = useConsoleGrant();
  const url = current === null || data?.demo === true ? null : dataSyncUrl(MCP_ENDPOINT, current.slug);
  const mayArm = url !== null && (current?.role === "owner" || current?.role === "editor");
  const mayConnect = url !== null && current?.role === "owner";
  const workspaceId = current?.id ?? null;
  const [states, setStates] = useState<ReadonlyMap<string, SourceSync>>(new Map());

  const ask = useCallback(
    async (body: DataSyncBody) => {
      if (url === null || workspaceId === null) return { ok: false as const, said: "This workspace can't sync sources here." };
      return await callDataSync({
        url,
        workspaceId,
        body,
        token: async (refresh) => (await mint({ workspaceId: workspaceId as Id<"workspaces"> }, refresh)).accessToken,
      });
    },
    [url, workspaceId, mint],
  );

  const [asked, setAsked] = useState(0);
  // Retries of the status ask since the last refresh, or since the paths or the address changed; and the timer for the next.
  const retries = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const github = useMemo(
    () =>
      url === null || workspaceId === null || current?.role !== "owner" || Platform.OS !== "web"
        ? undefined
        : githubCalls({ url, workspaceId, token: async (refresh) => (await mint({ workspaceId: workspaceId as Id<"workspaces"> }, refresh)).accessToken }),
    [url, workspaceId, current?.role, mint],
  );

  const fetched = useMemo(() => sources.filter((source) => SYNCED.has(source.kind) && source.about !== null).map((source) => source.aboutPath), [sources]);
  const key = fetched.join("\n");
  // A new list of paths or address starts the retries again.
  useEffect(() => {
    retries.current = 0;
  }, [key, url]);
  useEffect(() => {
    if (fetched.length === 0 || url === null) return;
    let live = true;
    void ask({ op: "status", about: fetched }).then((answer) => {
      if (!live) return;
      if (answer.ok) {
        setStates((held) => {
          const next = new Map(held);
          for (const path of fetched) if (!answer.sources.some((one) => one.about === path)) next.set(path, { about: path, armed: false, last: null });
          for (const one of answer.sources) next.set(one.about, one);
          return next;
        });
      }
      // A failed ask, or a first run still going in the background, is asked again on the schedule.
      const delay = nextStatusRetry(answer, retries.current);
      if (delay === null) return;
      retries.current += 1;
      retryTimer.current = setTimeout(() => setAsked((n) => n + 1), delay);
    });
    return () => {
      live = false;
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
    // `key` stands for the list of paths, so a new array with the same paths asks nothing again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, url, ask, asked]);

  const arm = useCallback(
    async (aboutPath: string): Promise<string | null> => {
      const answer = await ask({ op: "arm", about: aboutPath });
      if (!answer.ok) return answer.said;
      setStates((held) => {
        const next = new Map(held);
        for (const one of answer.sources) next.set(one.about, one);
        return next;
      });
      return null;
    },
    [ask],
  );

  const refresh = useCallback(() => {
    retries.current = 0;
    setAsked((n) => n + 1);
  }, []);

  const byFolder = useMemo(() => {
    const out = new Map<string, SyncState>();
    for (const source of sources) {
      if (!SYNCED.has(source.kind)) continue;
      const held = states.get(source.aboutPath);
      if (held !== undefined) out.set(source.folder, syncStateOf(held));
    }
    return out;
  }, [sources, states]);

  const connect = useCallback(
    async (aboutPath: string, key: string, account?: string): Promise<string | null> => {
      const answer = await ask({ op: "connect", about: aboutPath, key, ...(account === undefined ? {} : { account }) });
      if (!answer.ok) return answer.said;
      setStates((held) => {
        const next = new Map(held);
        for (const one of answer.sources) next.set(one.about, one);
        return next;
      });
      return null;
    },
    [ask],
  );

  const disconnect = useCallback(
    async (app: string): Promise<string | null> => {
      const answer = await ask({ op: "disconnect", app });
      if (!answer.ok) return answer.said;
      // Its sources read again as stopped.
      setStates((held) => {
        const next = new Map(held);
        for (const source of sources) {
          if (source.kind !== app) continue;
          next.set(source.aboutPath, { about: source.aboutPath, armed: false, last: { at: Date.now(), outcome: "stopped", said: "Disconnected. An owner can connect it again here." } });
        }
        return next;
      });
      return null;
    },
    [ask, sources],
  );

  return {
    syncOf: (folder) => byFolder.get(folder),
    ...(mayArm ? { arm } : {}),
    ...(mayConnect ? { connect, disconnect } : {}),
    ...(github === undefined ? {} : { github }),
    refresh,
  };
}
