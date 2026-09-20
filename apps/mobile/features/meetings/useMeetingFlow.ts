import {
  createElement,
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { useRouter } from "expo-router";

import { openStore } from "../offline/store";
import type { KeyValueStore } from "../offline/memory";
import { MeetingRefusal } from "./components/MeetingRefusal";
import { MeetingsController, meetings } from "./controller";
import { automaticDestination, type DestinationContext } from "./destination";
import { recallSystemAudio } from "./machineAudio";
import { meetingHref } from "./route";
import { UNTITLED_MEETING } from "./session";

/**
 * The one way into a recording from outside this feature.
 *
 * ## Pressing the key records. It used to ask first, and that question is gone
 *
 * Every meeting ever recorded in this product went through a sheet: two
 * destination rows, an audience line on each, a sentence about the audio, and
 * a Start beside it. The owner's reading of that sheet, after using it, is that
 * it cost a decision on every single capture and taught nobody anything —
 * *"all meetings from now on should go into 0-inbox/meetings, no need to ask
 * people it will just confuse them"*. So the destination is a rule
 * (`automaticDestination`) and the press opens the microphone.
 *
 * **What the sheet was actually protecting is kept, and it was never the
 * question.** `docs/decisions/meetings.md` forbids a control that starts
 * recording with no indicator — "the same product with the indicator removed" —
 * and the indicator is what now carries the disclosure: the panel opens on the
 * running meeting with a red mark, a clock, the waveform and the path the note
 * is going to, for the whole length of the run. The sentence about how the
 * audio is handled is said once, at first run and in settings, rather than in
 * front of every conversation.
 *
 * The privacy half is kept where it always lived: the destination is the
 * person's **own** inbox, never the shared context they happen to be reading
 * in. `automaticDestination` argues that at length; it is the reason this hook
 * no longer takes a `page` at all.
 *
 * ## Two things can still stop a press, and both say so
 *
 * A device whose controller has not been pointed at a context yet
 * (`NOT_READY_REFUSAL`, the ordinary cold start — or the wiring mistake of
 * mounting the key without `useMeetingsSetup`), and somebody who owns no
 * personal workspace, who is offered their @name instead. Both raise
 * `MeetingRefusal` through the same `sheet` slot the destination sheet used, so
 * every caller that already mounted one keeps working. A control that quietly
 * did nothing would hide the wiring mistake for as long as nobody tried to
 * record.
 *
 * ## Where the meeting then shows up is the caller's business
 *
 * `onStarted` is the console: it opens the right panel on Meetings, and the
 * note stays open behind it — a meeting is no longer a page you are thrown to.
 * A caller that offers no such surface (the phone, whose frame has no panel at
 * all) gets the meeting's own screen, which is what `MEETINGS_ROUTE` has always
 * been for.
 *
 * ## What the caller still owes
 *
 * **`useMeetingsSetup()` must be mounted in the same layout**, exactly as
 * `app/(app)/meetings/_layout.tsx` and the console's layout mount it: it is
 * what points the controller at a context and builds the real recorder. It is
 * not called from here on purpose — it opens Convex subscriptions, and which
 * layout owns that is a decision for whoever mounts the key.
 */
export interface MeetingFlowInput {
  /** Every context the viewer can reach, from the console's own list. */
  contexts: readonly DestinationContext[];
  /** Where to send somebody who owns no workspace. Omitted offers no button. */
  onClaimName?: () => void;
  /** What the meeting is called until somebody renames it in the panel. */
  title?: string;
  /**
   * Where a started meeting is shown, when the caller has somewhere to show it.
   *
   * The console passes the panel. Absent means this is a surface with nowhere
   * to put a running meeting, and the meeting's own screen is pushed instead.
   */
  onStarted?: (meetingId: string) => void;
  /** Injected by tests. Defaults to this device's store. */
  store?: KeyValueStore;
  /** Injected by tests. Defaults to the app's one controller. */
  controller?: MeetingsController;
}

/** Said when this device has no context to record into yet. */
export const NOT_READY_REFUSAL =
  "This device has not opened your context yet, so there is nowhere to record into.";

/** Said when the microphone itself would not open. */
export const START_FAILED =
  "This meeting did not start. Check that your browser or system settings allow the microphone, and try again.";

/** Said to somebody who owns no workspace, above the offer to claim one. */
export const NO_WORKSPACE_REFUSAL =
  "A meeting is written into your own context, and you do not have one yet.";

export interface MeetingFlow {
  /** Start recording. Asks nothing, and files into your own inbox. */
  startMeetingFlow: () => void;
  /** Mount this once, wherever the key is. `null` unless a press was refused. */
  sheet: ReactElement | null;
}

export function useMeetingFlow(input: MeetingFlowInput): MeetingFlow {
  const { contexts, onClaimName, onStarted, title = UNTITLED_MEETING } = input;
  const router = useRouter();
  const controller = input.controller ?? meetings;

  const [refusal, setRefusal] = useState<string | null>(null);
  const [claim, setClaim] = useState(false);

  const store = useMemo(() => input.store ?? openStore(), [input.store]);

  /*
    Subscribed rather than read once: the controller is configured by an effect
    in another layout, so a press during a cold start has to see it land.
  */
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  const canSystemAudio = snapshot.capture.systemAudio;
  const needsPicker = snapshot.capture.systemAudioNeedsPicker;
  const live = snapshot.live;

  /*
    One press, one meeting. `start()` is async — it mints an id and opens a
    device — and a second press before it resolves used to be a second
    recording of the same conversation, in two files, with one clock on screen.
    A ref rather than state because nothing renders from it and a render would
    be one frame too late.
  */
  const starting = useRef(false);

  const show = useCallback(
    (id: string) => {
      if (onStarted !== undefined) {
        onStarted(id);
        return;
      }
      router.push(meetingHref(id));
    },
    [onStarted, router],
  );

  const startMeetingFlow = useCallback(() => {
    setRefusal(null);
    setClaim(false);

    /*
      Already recording: show the one that is running rather than starting a
      second. There is one microphone on this machine, and the panel this opens
      is the only place to stop the run — pressing New meeting while one is live
      is somebody looking for it.
    */
    if (live !== null) {
      show(live.session.id);
      return;
    }

    if (snapshot.status !== "ready") {
      setRefusal(NOT_READY_REFUSAL);
      return;
    }

    const answer = automaticDestination({ contexts });
    if (answer.kind === "claimName") {
      setClaim(true);
      return;
    }

    if (starting.current) return;
    starting.current = true;

    void (async () => {
      try {
        /*
          Read at the press rather than held in state: it is a device setting
          changed in another pane, and a value captured on mount would record
          the wrong thing for anybody who changed it without reloading. The
          read is a local store hit, and `recallSystemAudio` swallows its own
          failures — a device that cannot answer records without the tap, which
          is the same default as never having chosen.

          Sent only where the recorder offers it at all: absent means "whatever
          this build can do without asking again", which is the honest answer
          for a surface that never drew the switch.
        */
        const systemAudio = canSystemAudio ? await recallSystemAudio(store, needsPicker) : false;
        const id = await controller.start({
          title,
          destination: answer.destination,
          ...(canSystemAudio ? { systemAudio } : {}),
        });
        show(id);
      } catch {
        /*
          A start that rejects used to be an unhandled rejection with nothing
          on screen: the press did nothing, twice over. `RecordingBar`'s End
          makes the same argument about the other end of a meeting — *"I don't
          know if it succeeded, if it failed. Just nothing at all."* — and the
          answer is the same, a sentence rather than a silence. What went wrong
          is not quoted: `controller.start` throws for a device that is not
          configured and for a recorder that would not open, and neither has a
          message written to be read by the person holding the machine.
        */
        setRefusal(START_FAILED);
      } finally {
        starting.current = false;
      }
    })();
  }, [canSystemAudio, contexts, controller, live, needsPicker, show, snapshot.status, store, title]);

  const dismiss = useCallback(() => {
    setRefusal(null);
    setClaim(false);
  }, []);

  const sheet =
    claim || refusal !== null
      ? createElement(MeetingRefusal, {
          reason: claim ? NO_WORKSPACE_REFUSAL : (refusal ?? NOT_READY_REFUSAL),
          onClaimName:
            claim && onClaimName !== undefined
              ? () => {
                  dismiss();
                  onClaimName();
                }
              : null,
          onClose: dismiss,
        })
      : null;

  return { startMeetingFlow, sheet };
}
