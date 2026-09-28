import { useEffect, useMemo, useRef } from "react";
import { Platform } from "react-native";
import { useConvex } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { memoryStore } from "../../offline/memory";
import { createRecorderFor, setTranscriptionClient } from "../../meetings/capture";
import { meetings } from "../../meetings/controller";
import { HOME_MEETINGS_WORKSPACE, homeMeetingsGateway, newVisitorId } from "./homeMeetings";

/** Minted once per tab: every demo meeting in it spends the same allowance. */
let visitorId: string | null = null;

/**
 * Point the app's meetings controller at the homepage while it is on screen.
 *
 * The console's `useMeetingsSetup` does this for a signed-in person's own
 * context; this is the same call for a visitor's tab: an in-memory store, the
 * tab's notes as the bucket (`homeMeetingsGateway`), the browser's real
 * recorder (call audio shared by default, as everywhere else), and the demo's
 * transcription (`transcribeDemoChunk`), which needs no account and is capped
 * server-side.
 *
 * **It never takes over a meeting that is running.** Somebody signed in who
 * walks from the console to `/` mid-meeting keeps their meeting, and pressing
 * New meeting here shows it rather than starting a demo. Leaving the homepage
 * ends a demo meeting (so the microphone is let go) and forgets the
 * configuration, and the console configures its own again when it mounts.
 *
 * Web only: the homepage is the website.
 */
export function useHomeMeetings(put: (path: string, text: string) => boolean): void {
  const convex = useConvex();
  const putRef = useRef(put);
  putRef.current = put;
  const gateway = useMemo(() => homeMeetingsGateway((path, text) => putRef.current(path, text)), []);
  const enabled = Platform.OS === "web";

  useEffect(() => {
    if (!enabled) return;
    const snapshot = meetings.getSnapshot();
    if (snapshot.live !== null && snapshot.workspaceId !== HOME_MEETINGS_WORKSPACE) return;
    let cancelled = false;
    visitorId ??= newVisitorId();
    const id = visitorId;
    setTranscriptionClient({
      action: (_reference, args) =>
        convex.action(api.functions.meetings.demoTranscribe.transcribeDemoChunk, {
          ...args,
          visitorId: id,
        }),
    });
    void (async () => {
      const recorder = await createRecorderFor("web");
      if (cancelled) return;
      await meetings.configure({
        workspaceId: HOME_MEETINGS_WORKSPACE,
        store: memoryStore(),
        gateway,
        recorder,
        device: { platform: "web", appVersion: undefined },
      });
    })();
    return () => {
      cancelled = true;
      setTranscriptionClient(null);
      const now = meetings.getSnapshot();
      if (now.workspaceId !== HOME_MEETINGS_WORKSPACE) return;
      const forget = () => {
        if (meetings.getSnapshot().workspaceId === HOME_MEETINGS_WORKSPACE) meetings.reset();
      };
      if (now.live !== null) void meetings.end().finally(forget);
      else forget();
    };
  }, [enabled, convex, gateway]);
}
