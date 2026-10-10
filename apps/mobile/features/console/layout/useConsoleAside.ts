import { useCallback, useMemo, useState } from "react";
import { WELCOME_ROUTE } from "../../onboarding/route";
import { useApprovals } from "../../approvals/useApprovals";
import { useCarriesMeeting } from "../../meetings/carried";
import { RESUME_RECENT_WINDOW_MS, resumeRowFor } from "../../meetings/resume";
import { useMeetingFlow } from "../../meetings/useMeetingFlow";
import { useMeetingsSnapshot, useTick } from "../../meetings/useMeetings";
import { useResumeMeeting } from "../../meetings/useResumeMeeting";
import type { VoiceHost } from "../../voice/VoiceHost";
import { canCreateAnything } from "../files/createSheet";
import type { entryAt } from "../files/tree";
import { useContextHref, useContextPlaces } from "../useLastPlace";
import type { ConsoleContext, ConsoleData } from "../types";
import type { ConsoleRouter } from "./types";

/**
 * The right panel, the + menu's meeting rows, and the microphone's host:
 * everything the console layout builds for meetings and approvals.
 *
 * Lifted out whole and in order. It is one hook rather than three because its
 * callbacks reach state declared further down it — `showMeetings` opens the
 * panel through `setOpenAsideAt` — and
 * the recently-visited places are read in the middle of it, so they are
 * returned from here too rather than moved and made to run in a different
 * position.
 */
export function useConsoleAside({
  data,
  router,
  phone,
  insideContext,
  current,
  selectedEntry,
}: {
  data: ConsoleData;
  router: ConsoleRouter;
  phone: boolean;
  insideContext: boolean;
  current: ConsoleContext | null;
  selectedEntry: ReturnType<typeof entryAt> | null;
}) {
  /**
   * When something last asked for the panel's Meetings tab.
   *
   * The + menu's New meeting, and the title-bar pill that a folded panel
   * leaves behind. A counter for `asked`'s reason — recording twice in a
   * session is ordinary, and a boolean looks unchanged the second time.
   */
  const [meetingsAt, setMeetingsAt] = useState<number | null>(null);
  /*
    Whether this console has a right panel at all. `regionsFor` answers
    `hidden` at compact, and `asideToggleFor` is the question asked in the one
    place that decides it — a phone's meeting goes to its own screen instead,
    which is what `useMeetingFlow` does with no `onStarted`.
  */
  const hasAside = !phone;
  /*
    Open the panel on Meetings. Two counters because they are two facts — the
    panel has to be open (`OpenAsideOn`, which is inside the frame) and the tab
    has to be Meetings (`AsidePanel`, which is below it) — and nothing above
    `AppFrame` can call either directly.
  */
  const showMeetings = useCallback(() => {
    const at = Date.now();
    setOpenAsideAt(at);
    setMeetingsAt(at);
  }, []);

  /*
    This console is showing the running meeting, so the floating `RecordingBar`
    stands down. It is the *console* that claims it rather than the panel,
    because a folded panel still carries it — in the title bar. See
    `features/meetings/carried.ts`.
  */
  useCarriesMeeting(hasAside, showMeetings);

  const places = useContextPlaces();
  const contextHrefFrom = useContextHref(data.contexts);
  /**
   * Starting a meeting, and where it lands on this screen.
   *
   * **No `page`**, and that is the destination decision rather than a
   * simplification: a meeting is written into the person's own inbox wherever
   * they are standing (`automaticDestination`), which is the privacy rule the
   * destination sheet used to hold with a row and an audience line. The sheet
   * is gone; the rule is not.
   *
   * `onStarted` is what makes a meeting stop being a page. It opens the right
   * panel and puts it on Meetings, so the note somebody was reading stays open
   * behind the recording — `router.push(meetingHref(id))` is what this
   * replaced, and the owner's words for that page were "the big ugly page".
   */
  /*
    The homepage's visitor records too, into their tab: a fixed destination,
    and on a phone a meeting shown by the homepage rather than pushed to a
    route that needs an account. See `features/home/meeting`.
  */
  const visitorMeetings = data.visitor?.meetings;
  const { startMeetingFlow, sheet: meetingSheet } = useMeetingFlow({
    contexts: data.contexts,
    destination: visitorMeetings?.destination,
    onClaimName: data.demo ? undefined : () => router.push(WELCOME_ROUTE),
    onStarted: hasAside ? showMeetings : visitorMeetings?.showOnPhone,
  });

  /** Recording, or `null` on a console with no controller behind one. */
  const startMeeting = data.demo && visitorMeetings === undefined ? null : startMeetingFlow;
  /*
    Whether the phone's `+` has anything to offer — asked through the same
    function that decides which rows its sheet draws, so the key and its contents
    cannot disagree. See `files/createSheet.ts`.
  */
  const canCreate = canCreateAnything({
    canEdit: data.files.canEdit,
    meeting: startMeeting !== null,
  });

  /**
   * When something last asked for the panel to be opened.
   *
   * `showMeetings` is the caller. A counter rather than a boolean: asking
   * twice is ordinary, and the second ask must not look like a re-render.
   * `null` is "nobody has".
   */
  const [openAsideAt, setOpenAsideAt] = useState<number | null>(null);

  const meetingsSnapshot = useMeetingsSnapshot();
  /*
    What the egress gate is holding for this context, for the right panel's
    Approvals tab and its count. Read here because the count has to be known
    before anybody opens the tab. Off where there is no panel (a phone's
    console has none), on the demo, and with no context to ask about.
  */
  const approvals = useApprovals({
    workspaceId: data.selectedContextId,
    endpoint: data.endpoint,
    enabled: !phone && !data.demo && data.selectedContextId !== null,
  });

  const resumeMeeting = useResumeMeeting();
  /*
    The `+`'s Resume meeting row — the open note's meeting first, then the one
    that just stopped (`resumeRowFor`). Built here because this is where the
    recorder and the context meet: nothing below this layout knows whether this
    device can continue a meeting, whether one is recording, or which context a
    part started from the open note would be addressed to.

    The note is read from `baseline`, the saved text, so the row is about the
    meeting in the bucket and is not re-derived on every keystroke. No row on
    the demo console, to somebody who cannot write the note the part would be
    added to, or before the recorder has read what this device holds — a part
    in flight it has not loaded yet is exactly what `mayResume` refuses over.

    The clock ticks once a minute, and only while the newest meeting is inside
    the window, so "ended 4 min ago" stays true without re-rendering this layout
    for a meeting from last week.
  */
  const newestEnd = meetingsSnapshot.records[0]?.session.endedAt ?? null;
  const newestEndMs = newestEnd === null ? Number.NaN : Date.parse(newestEnd);
  const resumeClock = useTick(
    Number.isFinite(newestEndMs) && Date.now() - newestEndMs < RESUME_RECENT_WINDOW_MS,
    60_000,
  );
  const editorPath = data.files.editor.path;
  const editorBaseline = data.files.editor.baseline;
  const editorLocked = data.files.editor.readOnly || data.files.editor.encrypted;
  const resumeRow = useMemo(() => {
    if (data.demo || !data.files.canEdit || !insideContext || current === null) return null;
    if (meetingsSnapshot.status !== "ready") return null;
    const row = resumeRowFor({
      records: meetingsSnapshot.records,
      live: meetingsSnapshot.live,
      canContinue: meetingsSnapshot.canContinue,
      now: resumeClock === 0 ? Date.now() : resumeClock,
      openNote:
        editorPath === null || editorLocked
          ? null
          : { contextSlug: current.slug, path: editorPath, markdown: editorBaseline },
    });
    if (row === null) return null;
    return { detail: row.detail, onResume: () => void resumeMeeting(row.input) };
  }, [
    data.demo,
    data.files.canEdit,
    insideContext,
    current,
    meetingsSnapshot,
    resumeClock,
    editorPath,
    editorBaseline,
    editorLocked,
    resumeMeeting,
  ]);

  /** What the microphone over the note needs, which is only what this layout already knows. */
  const voiceHost = useMemo<VoiceHost>(
    () => ({
      page: {
        context: insideContext ? current : null,
        notePath: selectedEntry?.kind === "file" ? selectedEntry.path : null,
        writable: selectedEntry !== null && !selectedEntry.readOnly,
        /*
          The entry's own answer to who can read it, which is the question the
          sheet asks and the one `kind` cannot answer: a personal workspace
          takes members, so `team` on a note inside one means real people. Left
          absent when a folder is on screen, and `audience.ts` treats absent as
          "not established" rather than as private.
        */
        noteVisibility: selectedEntry?.kind === "file" ? selectedEntry.visibility : undefined,
      },
      onRecordMeeting: startMeetingFlow,
      /*
        The corner is the `+` at every pointer density, so the editor draws no
        resting microphone there. Published rather than derived, because the
        fixture and the demo console are desktop-width consoles with no `+` —
        see `VoiceHost.createButton`.
      */
      createButton: !phone,
    }),
    [insideContext, current, selectedEntry, startMeetingFlow, phone],
  );
  return {
    meetingsAt,
    showMeetings,
    places,
    contextHrefFrom,
    startMeetingFlow,
    meetingSheet,
    startMeeting,
    canCreate,
    openAsideAt,
    approvals,
    resumeRow,
    voiceHost,
  };
}

export type ConsoleAside = ReturnType<typeof useConsoleAside>;
