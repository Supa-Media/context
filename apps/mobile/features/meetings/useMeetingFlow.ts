import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { useRouter } from "expo-router";

import { openStore } from "../offline/store";
import type { KeyValueStore } from "../offline/memory";
import { DestinationSheet } from "./components/DestinationSheet";
import { MeetingsController, meetings } from "./controller";
import {
  chooseOffer,
  recallDestination,
  rememberDestination,
  resolveDestinations,
  type CurrentPage,
  type DestinationContext,
  type MeetingDestination,
} from "./destination";
import { meetingHref } from "./route";

/**
 * The one way into a recording from outside this feature.
 *
 * ## What pressing the key does, and what it deliberately does not
 *
 * It opens a sheet. It does **not** open the microphone, write a session, touch
 * the store, create a folder, or navigate. That is
 * `docs/decisions/meetings.md`'s rule for the rail entry — "it navigates. It
 * does not record", because a control that silently started recording "would be
 * the same product with the indicator removed" — applied to a key one surface
 * further out, where it matters more rather than less: the bottom row is
 * reachable from every screen in the app.
 *
 * ## The sheet opens every time, and that is the point rather than an oversight
 *
 * A remembered choice preselects a row. It never skips the question. The sheet
 * is where the sentence about the audio lives, and the decision requires the
 * record control to sit *beside* that sentence — so a version that went
 * straight to recording once the destination was known would move recording one
 * tap away from any disclosure, on exactly the path somebody uses most often.
 * `__tests__/meetingsFlow.test.ts` holds that property by name and sabotages it.
 *
 * ## The remembered choice is read on mount, not on the press
 *
 * The store is async on every platform, and a press that waited on it would
 * either delay the sheet or open it on the wrong row and correct itself a frame
 * later. Reading once when the key is mounted means the press path has no
 * `await` in it at all — which is also what makes "the sheet always opens"
 * something a test can assert rather than something a race decides.
 *
 * A device that has not answered yet, or that knows nothing, simply gets the
 * default. Nothing waits and nothing is claimed.
 *
 * ## What the caller still owes
 *
 * **`useMeetingsSetup()` must be mounted in the same layout**, exactly as
 * `app/(app)/meetings/_layout.tsx` mounts it: it is what points the controller
 * at a context and reads what is already on the device. It is not called from
 * here on purpose — it opens Convex subscriptions and builds the real recorder,
 * and which layout owns that is a decision for whoever mounts the key, not
 * something an entry point should do behind their back.
 *
 * Until it has run, `start()` would throw, so the sheet still opens and Start
 * is **refused with the reason** rather than pressed into an unhandled
 * rejection. That covers two different situations with one honest sentence: the
 * ordinary cold start, where the workspace list has not landed yet and this
 * clears itself a moment later, and the wiring mistake of mounting the key
 * without the setup, where it stays on screen until somebody fixes it. A
 * control that quietly did nothing would hide the second one for as long as
 * nobody tried to record.
 */
export interface MeetingFlowInput {
  /** Every context the viewer can reach, from the console's own list. */
  contexts: readonly DestinationContext[];
  /** Where they are standing, or `null` — the meetings list, or no context. */
  page: CurrentPage | null;
  /** Where to send somebody who owns no brain. Omitted offers no button. */
  onClaimName?: () => void;
  /** What the meeting is called until somebody renames it on the live screen. */
  title?: string;
  /** Injected by tests. Defaults to this device's store. */
  store?: KeyValueStore;
  /** Injected by tests. Defaults to the app's one controller. */
  controller?: MeetingsController;
}

/** Said on the sheet when this device has no context to record into yet. */
export const NOT_READY_REFUSAL =
  "This device has not opened your context yet, so there is nowhere to record into.";

export interface MeetingFlow {
  /** Open the sheet. Opens no microphone and writes no session. */
  startMeetingFlow: () => void;
  /** Mount this once, wherever the key is. `null` while the sheet is closed. */
  sheet: ReactElement | null;
}

/** What a meeting is called before anybody renames it. The list screen's. */
const DEFAULT_TITLE = "New meeting";

export function useMeetingFlow(input: MeetingFlowInput): MeetingFlow {
  const { contexts, page, onClaimName, title = DEFAULT_TITLE } = input;
  const router = useRouter();
  const controller = input.controller ?? meetings;

  const [open, setOpen] = useState(false);
  const [remembered, setRemembered] = useState<MeetingDestination | null>(null);
  /**
   * The row somebody has pressed, or `null` for "whatever the resolver says".
   *
   * Two values rather than one number seeded from the resolver, because the
   * resolver's answer changes while the sheet is open — a context list landing,
   * a page changing underneath — and a seeded number would silently stop
   * tracking it the moment the sheet was opened.
   */
  const [pressed, setPressed] = useState<number | null>(null);

  const store = useMemo(() => input.store ?? openStore(), [input.store]);

  /*
    Subscribed rather than read once: the controller is configured by an effect
    in another layout, so a sheet opened during a cold start has to notice when
    that lands instead of staying refused until somebody closes and reopens it.
  */
  const status = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  ).status;
  const blocked = status === "ready" ? null : NOT_READY_REFUSAL;

  useEffect(() => {
    let live = true;
    void recallDestination(store).then((answer) => {
      if (live) setRemembered(answer);
    });
    return () => {
      live = false;
    };
  }, [store]);

  const choice = useMemo(
    () => resolveDestinations({ contexts, page, remembered }),
    [contexts, page, remembered],
  );

  const selectedIndex =
    pressed ?? (choice.kind === "choose" ? choice.selectedIndex : 0);

  const startMeetingFlow = useCallback(() => {
    setPressed(null);
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setPressed(null);
  }, []);

  const select = useCallback(
    (index: number) => {
      if (choice.kind !== "choose") return;
      setPressed(chooseOffer(choice.offers, selectedIndex, index));
    },
    [choice, selectedIndex],
  );

  const confirm = useCallback(() => {
    if (choice.kind !== "choose") return;
    const offer = choice.offers[selectedIndex];
    /*
      Checked again here rather than trusted from the selection. `chooseOffer`
      already refuses a refused row, so this is unreachable today — and it is
      the last gate before somebody's meeting is pointed at a context they
      cannot write to, which is not a place to rely on an invariant holding one
      call site away.
    */
    if (offer === undefined || offer.refusal !== null) return;
    if (blocked !== null) return;

    const destination = offer.destination;
    close();
    void (async () => {
      /*
        Written down before the meeting starts, and `rememberDestination`
        swallows its own failures: a device that will not remember the choice
        still records the meeting.
      */
      await rememberDestination(store, destination);
      setRemembered(destination);
      const id = await controller.start({ title, destination });
      router.push(meetingHref(id));
    })();
  }, [blocked, choice, close, controller, router, selectedIndex, store, title]);

  const sheet = open
    ? createElement(DestinationSheet, {
        choice,
        selectedIndex,
        onSelect: select,
        onStart: confirm,
        onCancel: close,
        blocked,
        onClaimName:
          onClaimName === undefined
            ? undefined
            : () => {
                close();
                onClaimName();
              },
      })
    : null;

  return { startMeetingFlow, sheet };
}
