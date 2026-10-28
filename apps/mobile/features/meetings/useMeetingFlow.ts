import {
  createElement,
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { Linking } from "react-native";
import { useRouter } from "expo-router";

import { CallAudioPrimer } from "./components/CallAudioPrimer";
import { MeetingRefusal } from "./components/MeetingRefusal";
import { callAudioGivenUp, readCallAudioMemory } from "./capture";
import { MeetingsController, meetings } from "./controller";
import { automaticDestination, type DestinationContext, type MeetingDestination } from "./destination";
import { joinStartInput } from "./join";
import type { CalendarEvent } from "./protocol";
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
  /**
   * Where every meeting started here lands, instead of the person's own inbox.
   *
   * Only the homepage passes it: a visitor has no workspace, and their demo
   * meeting is written into the tab they are reading (`features/home/meeting`).
   * Absent everywhere else, where `automaticDestination` is the rule.
   */
  destination?: MeetingDestination;
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
  /**
   * "Join and take notes" for a meeting on the calendar: the same start, named
   * after the event with its guests, and the call opened in the same press
   * wherever this build hears the call without a browser's share prompt (the
   * Mac app, a phone). A browser opens its prompt first and offers the call on
   * the live card after (docs/decisions/meetings/joining-from-the-calendar.md).
   */
  joinMeetingFlow: (meeting: CalendarEvent) => void;
  /** Mount this once, wherever the key is. `null` unless a press was refused. */
  sheet: ReactElement | null;
}

export function useMeetingFlow(input: MeetingFlowInput): MeetingFlow {
  const { contexts, destination, onClaimName, onStarted, title = UNTITLED_MEETING } = input;
  const router = useRouter();
  const controller = input.controller ?? meetings;

  const [refusal, setRefusal] = useState<string | null>(null);
  const [claim, setClaim] = useState(false);
  /*
    The first-time note before a browser's screen picker (`CallAudioPrimer`),
    holding the destination the press resolved so Continue records into it.
  */
  const [primer, setPrimer] = useState<{ destination: MeetingDestination; meeting?: CalendarEvent } | null>(null);

  /*
    Subscribed rather than read once: the controller is configured by an effect
    in another layout, so a press during a cold start has to see it land.
  */
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

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

  const begin = useCallback(
    (into: MeetingDestination, systemAudio?: boolean, meeting?: CalendarEvent) => {
      if (starting.current) return;
      starting.current = true;

      void (async () => {
        try {
          /*
            No `systemAudio` unless the person chose to record the room: the
            controller takes the machine's own audio wherever this build can,
            always (Dev2, 2026-10-01 — there is no setting for it any more).
          */
          const id = await controller.start({
            title,
            ...(meeting === undefined ? {} : joinStartInput(meeting)),
            destination: into,
            ...(systemAudio === undefined ? {} : { systemAudio }),
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
    },
    [controller, show, title],
  );

  const flow = useCallback((meeting?: CalendarEvent) => {
    setRefusal(null);
    setClaim(false);
    setPrimer(null);

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

    const answer =
      destination === undefined
        ? automaticDestination({ contexts })
        : ({ kind: "destination", destination } as const);
    if (answer.kind === "claimName") {
      setClaim(true);
      return;
    }

    /*
      A browser that has never handed over a call's sound here is told what
      its picker is about to ask, first. Once a share has worked, or once this
      browser has stopped being asked (`callAudioMemory`), Record records.
    */
    /*
      The call opens in this press where nothing else needs it: a window.open
      spends the press a browser's share prompt also needs, so there the live
      card offers the call once the prompt is answered.
    */
    if (meeting?.conferenceUrl !== undefined && !snapshot.capture.systemAudioNeedsPicker) {
      void Linking.openURL(meeting.conferenceUrl).catch(() => {});
    }

    const memory = readCallAudioMemory();
    if (snapshot.capture.systemAudioNeedsPicker && !memory.worked && !callAudioGivenUp(memory)) {
      setPrimer({ destination: answer.destination, ...(meeting === undefined ? {} : { meeting }) });
      return;
    }

    begin(answer.destination, undefined, meeting);
  }, [begin, contexts, destination, live, show, snapshot.capture.systemAudioNeedsPicker, snapshot.status]);

  const startMeetingFlow = useCallback(() => flow(), [flow]);
  const joinMeetingFlow = useCallback((meeting: CalendarEvent) => flow(meeting), [flow]);

  const dismiss = useCallback(() => {
    setRefusal(null);
    setClaim(false);
    setPrimer(null);
  }, []);

  const sheet =
    primer !== null
      ? createElement(CallAudioPrimer, {
          onContinue: () => {
            setPrimer(null);
            begin(primer.destination, undefined, primer.meeting);
          },
          onRoom: () => {
            setPrimer(null);
            begin(primer.destination, false, primer.meeting);
          },
          onClose: dismiss,
        })
      : claim || refusal !== null
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

  return { startMeetingFlow, joinMeetingFlow, sheet };
}
