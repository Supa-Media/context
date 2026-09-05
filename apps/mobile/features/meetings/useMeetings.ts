import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { useConvex, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { MCP_ENDPOINT } from "../console/placeholderData";
import { defaultContext } from "../console/nav";
import { useReachability } from "../offline/reachability";
import { openStore } from "../offline/store";
import { createRecorder, setTranscriptionClient } from "./capture";
import {
  createHttpGateway,
  gatewayOriginFrom,
  type MeetingsGateway,
} from "./gateway";
import { meetings, type MeetingsSnapshot } from "./controller";

/**
 * The wiring between the controller and React.
 *
 * Everything interesting is in the pure modules beside this one, tested without
 * a renderer — the shape `features/offline/useOfflineNotes.ts` established.
 * What is here is: reading the snapshot, choosing the context, building the
 * gateway and the recorder once, and running a drain when the connection comes
 * back.
 */

/**
 * The meetings state, from anywhere.
 *
 * `useSyncExternalStore` rather than a context, because the persistent
 * recording bar has to work on screens that know nothing about this feature and
 * under layouts this feature does not own. See `controller.ts`.
 */
export function useMeetingsSnapshot(): MeetingsSnapshot {
  return useSyncExternalStore(
    meetings.subscribe,
    meetings.getSnapshot,
    meetings.getSnapshot,
  );
}

/**
 * A clock that ticks while something is running, and not otherwise.
 *
 * Every screen that shows elapsed time derives it from the session's own log
 * (`recordElapsedMs`), so this hook exists only to cause a re-render — it does
 * not hold the time. That is what makes the number right after a navigation, a
 * backgrounding, or a cold start into a running meeting: it is computed from
 * `startedAt` and the log, never accumulated by a timer that was not running.
 *
 * It returns `0` and starts nothing when `running` is false, so a list screen
 * with no live meeting costs no timer at all.
 */
export function useTick(running: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [running, everyMs]);
  return running ? now : 0;
}

/**
 * The platform, in the protocol's vocabulary.
 *
 * The protocol's `MeetingDevice["platform"]` also names `macos`, `windows`,
 * `linux` and `watchos`, because the desktop app and the watch write sessions
 * too. This app reaches three of them, and a desktop browser is `web` rather
 * than the operating system underneath it — what the note is recording is which
 * *client* captured the meeting, and this client is the web one wherever it is
 * running.
 */
export function platformFor(): "ios" | "android" | "web" {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return "web";
}

/**
 * Hand the recorders the app's Convex client, for as long as a recording can
 * exist.
 *
 * Cloud transcription is a Convex action, and `capture/` is outside React by
 * design — a recording outlives the screen that started it. `SupaConvexProvider`
 * keeps the app's single `ConvexReactClient` as a module singleton and does not
 * export it, so a hook inside the provider is the only thing that can put it
 * where `audio.ts` and `audio.web.ts` reach it. Building a second client would
 * be a second websocket, a second auth state and a second set of credentials on
 * the device.
 *
 * **Where it is called is the whole of this hook.** It used to live in
 * `useMeetingsSetup`, which is mounted in `app/(app)/meetings/_layout.tsx` — the
 * layout that unmounts the moment somebody leaves `/meetings/*`, while
 * `RecordingBar` is mounted a level up precisely because a recording outlives
 * those screens. So the install was wired to the half that does not: leave the
 * section mid-meeting and from the next chunk on `resolveTranscriber()` answered
 * `null`, and audio was recorded, base64-ed, deleted and thrown away while the
 * bar went on drawing a live timer.
 *
 * It belongs where the bar is, and for the same reason. `app/(app)/_layout.tsx`
 * calls it, and it is cleared on unmount for the reason it is set: a recorder
 * still holding the previous session's client after a sign-out would be
 * shipping one person's audio under another person's credentials.
 */
export function useTranscriptionClient(): void {
  const convex = useConvex();
  useEffect(() => {
    setTranscriptionClient(convex);
    return () => setTranscriptionClient(null);
  }, [convex]);
}

/**
 * Point the controller at the signed-in person's context, once.
 *
 * ## Why the workspace comes from the same query the console uses
 *
 * `listMyWorkspaces` plus `defaultContext` — a context you own, and the first
 * of the list only when you own none. That rule is `nav.ts`'s and is not
 * re-derived here: a meetings screen that picked "the first workspace" would
 * record somebody's meeting into a colleague's context, which is a tenancy
 * mistake rather than a cosmetic one.
 *
 * Convex dedupes identical subscriptions, so this adds no round trip the app
 * was not already making.
 *
 * ## Why the gateway may be `null`
 *
 * See `gateway.ts`: which credential this app presents to the gateway is not
 * settled, and inventing one here would be guessing about somebody else's auth.
 * With no token the gateway refuses to send, the controller keeps the meeting
 * on the device, and the screens say so. A meeting is never lost by this; what
 * it does not do is reach the bucket.
 */
export function useMeetingsSetup(options: { gateway?: MeetingsGateway } = {}): void {
  const spec = useMemo<RequestForQueries>(
    () => ({ workspaces: { query: api.functions.workspaces.listMyWorkspaces, args: {} } }),
    [],
  );
  const results = useQueries(spec);
  const raw = results.workspaces;
  const workspaces = raw instanceof Error || raw === undefined ? undefined : raw;
  const workspaceId =
    defaultContext((workspaces ?? []) as ReadonlyArray<{ role: string; workspaceId: string }>)
      ?.workspaceId ?? null;

  const reachability = useReachability();
  const snapshot = useMeetingsSnapshot();

  const gateway = useMemo(
    () => options.gateway ?? defaultGateway(),
    [options.gateway],
  );

  useEffect(() => {
    if (workspaceId === null) return;
    void meetings.configure({
      workspaceId,
      store: openStore(),
      gateway,
      recorder: createRecorder(platformFor()),
      device: { platform: platformFor(), appVersion: undefined },
    });
  }, [workspaceId, gateway]);

  /*
    A drain when the connection comes back, and whenever something is waiting.
    Not on a repeating poll — that would spend somebody's quota to learn nothing
    for the hours a day their queue is empty — and **`requestSync`, never
    `sync`**: `snapshot.records` changes on every keystroke, so an effect that
    drained directly would POST the notes once per character. The throttle in
    the controller is what turns that stream of requests into one drain every
    few seconds. See `SYNC_THROTTLE_MS`.
  */
  useEffect(() => {
    if (reachability === "offline") return;
    if (snapshot.status !== "ready") return;
    meetings.requestSync();
  }, [reachability, snapshot.status, snapshot.records]);
}

/**
 * The gateway this build talks to, or one that always refuses.
 *
 * `MCP_ENDPOINT` is the console's own deployment constant — one URL for every
 * customer, overridable so a self-hoster points at their own gateway — and
 * `gatewayOriginFrom` takes its origin, because `ROUTES` are siblings of `/mcp`
 * rather than paths under it.
 *
 * `authorization` answers `null` today. That is the one unfinished seam in this
 * feature and it is deliberately visible: see `gateway.ts`.
 */
function defaultGateway(): MeetingsGateway {
  const origin = gatewayOriginFrom(MCP_ENDPOINT);
  return createHttpGateway({
    origin: origin ?? "",
    authorization: async () => null,
  });
}
