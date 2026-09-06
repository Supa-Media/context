import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { useConvex, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { defaultContext } from "../console/nav";
import { useReachability } from "../offline/reachability";
import { openStore } from "../offline/store";
import { createRecorder, setTranscriptionClient } from "./capture";
import { createConvexGateway, writeNoteThrough } from "./convexGateway";
import { meetingWorkspaceId, type RoutableContext } from "./destination";
import { type MeetingsGateway } from "./gateway";
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
 * ## What `workspaceId` here is, and — since it was read as more — what it is not
 *
 * It is the **device key**: `keys.ts` files a meeting under it so that one
 * person's several contexts do not share a drawer on the phone, and
 * `loadMeetings` reads that drawer back. It is not a routing decision and it
 * never was one. Where a meeting's note *lands* is `MeetingRecord.destination`,
 * which addresses every gateway call about that meeting — see `gateway.ts`.
 *
 * That distinction is written down because the two were conflated, in the
 * direction that matters, and then conflated again by the fix. `defaultContext`
 * filters on `role === "owner"` and nothing else, while the sheet's own "your
 * context" is `ownPersonalContext` — `kind === "personal"` **and**
 * `role === "owner"`. Two notions of the same phrase, and one of them is wrong
 * about a bucket: somebody who owns a shared workspace older than their brain
 * has a `defaultContext` that is shared, so a meeting filed by it lands in a
 * shared bucket at whatever visibility that folder carries, under a row that
 * said "Only you" — or, for somebody who owns nothing at all, in `contexts[0]`,
 * which is another person's context.
 *
 * **That is exactly what the first fix shipped**: the writer's `null`
 * destination fell back to `defaultContext(workspaces)`, so a paragraph
 * arguing that nothing here decides routing sat directly above the line that
 * did. The rule is now `meetingWorkspaceId` in `destination.ts`, beside every
 * other rule about where a meeting lands, pure and tested without a renderer.
 *
 * `defaultContext` stays exactly as `nav.ts` argues it and is used *only* for
 * the device key below: the rule for which context somebody lands in, which is
 * a question about a first screen and not about a bucket.
 *
 * Convex dedupes identical subscriptions, so this adds no round trip the app
 * was not already making.
 *
 * ## Which writer a meeting takes, and why it is this one
 *
 * **This is where the app chose the MCP gateway and got a meeting that never
 * reached a bucket.** `createHttpGateway` authenticates by per-client OAuth
 * grant and this app holds none, so `authorization()` answered `null`, the
 * gateway correctly refused to send, and every meeting stopped on the device.
 * Meanwhile the editor has been writing notes into the same customer's bucket
 * on every save, through `files.writeNote`.
 *
 * So a meeting takes the note's path: `createConvexGateway`, over the control
 * plane, with this account's own session. `createHttpGateway` is not deleted —
 * it is the right answer for a client that *does* hold a grant, which is the
 * desktop app — and this is the one line in the feature that knows there are
 * two. See `convexGateway.ts` for what that path gives up (the enhancement
 * pass, the session record in the bucket, `list()`) and how idempotency is
 * bought without a claimed path.
 *
 * The workspace list is what turns a destination's `@name` into the id
 * `writeNote` takes. It is read through a ref rather than captured, because it
 * lands *after* the controller is configured and a meeting can be finalized at
 * any point after that — a gateway rebuilt on every list change would
 * reconfigure the controller mid-recording, which is the thing
 * `configure`'s own recorder guard exists to prevent.
 */
export function useMeetingsSetup(
  options: {
    gateway?: MeetingsGateway;
    /**
     * Whether there is a session to subscribe on behalf of. Default `true`.
     *
     * This hook is mounted by the app gate, which runs it **above** its own
     * early returns so that a cold start into a running meeting configures the
     * controller on the first render rather than a render late. That means it
     * also runs while the stored token is still being restored — before the
     * client has an identity — and `useQueries` with a real spec there is a
     * request from nobody. `appLayoutGate.test.ts` asserts zero subscriptions
     * in that window and caught exactly that.
     *
     * So the spec empties rather than the hook not running, which is the same
     * shape the gate already uses for its own two queries. Convex dedupes, and
     * an empty spec opens nothing.
     */
    enabled?: boolean;
  } = {},
): void {
  const enabled = options.enabled ?? true;
  /*
    Two `return`s **and** an explicit return annotation, both of which are a
    type-level requirement rather than a style.

    A conditional expression unions its arms, so the empty arm widens to
    `{ workspaces?: undefined }` — and `undefined` is not assignable to
    `RequestForQueries`' index signature, which is what `tsc` refused. Splitting
    it into two `return`s is not enough on its own: the arrow's return type is
    still inferred as that same union and only then checked against `useMemo`'s
    type argument. Annotating the arrow is what gets each `return` checked
    against `RequestForQueries` separately, and `{}` is a perfectly good one.
  */
  const spec = useMemo<RequestForQueries>((): RequestForQueries => {
    if (!enabled) return {};
    return { workspaces: { query: api.functions.workspaces.listMyWorkspaces, args: {} } };
  }, [enabled]);
  const results = useQueries(spec);
  const raw = results.workspaces;
  const workspaces = raw instanceof Error || raw === undefined ? undefined : raw;
  const workspaceId =
    defaultContext((workspaces ?? []) as ReadonlyArray<{ role: string; workspaceId: string }>)
      ?.workspaceId ?? null;

  const reachability = useReachability();
  const snapshot = useMeetingsSnapshot();

  const convex = useConvex();

  /*
    The list, where the gateway can read it at call time. A ref rather than a
    dependency: `gateway` is a `configure` input, and rebuilding it whenever the
    workspace list re-renders would hand the controller a new gateway during a
    live recording.
  */
  const directory = useRef<ReadonlyArray<RoutableContext>>([]);
  directory.current = (workspaces ?? []) as ReadonlyArray<RoutableContext>;

  /*
    The rule itself is in `destination.ts` and not here, which is the point:
    what this closure does is read the ref. Everything about *which* context a
    meeting lands in is a pure function a test reaches without a renderer —
    `console/capabilities.ts`'s measured rule, and the reason it now is one is
    that the version expressed here was wrong for a year and nothing could
    fail. See `meetingWorkspaceId`.
  */
  const resolveWorkspaceId = useCallback(
    (contextSlug: string | null): string | null =>
      meetingWorkspaceId(directory.current, contextSlug),
    [],
  );

  const gateway = useMemo(
    () =>
      options.gateway ??
      createConvexGateway({
        writeNote: writeNoteThrough(convex as never),
        resolveWorkspaceId,
      }),
    [options.gateway, convex, resolveWorkspaceId],
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
