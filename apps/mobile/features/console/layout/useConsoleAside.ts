import { useCallback, useMemo, useState } from "react";
import { WELCOME_ROUTE } from "../../onboarding/route";
import { agentPage } from "../../agent/page";
import { useOpenNote } from "../../agent/openNote";
import { useAgentEngine } from "../../agent/useAgentEngine";
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
 * The right panel, the + menu's meeting and chat rows, and the microphone's
 * host: everything the console layout builds for the agent and for meetings.
 *
 * Lifted out whole and in order. It is one hook rather than three because its
 * callbacks reach state declared further down it — `showMeetings` and
 * `startNewChat` open the panel through `setOpenAsideAt` and `setAsked` — and
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
  pathname,
}: {
  data: ConsoleData;
  router: ConsoleRouter;
  phone: boolean;
  insideContext: boolean;
  current: ConsoleContext | null;
  selectedEntry: ReturnType<typeof entryAt> | null;
  pathname: string;
}) {
  /**
   * When something last asked for the panel's Meetings tab.
   *
   * The + menu's New meeting, and the title-bar pill that a folded panel
   * leaves behind. A counter for `asked`'s reason — recording twice in a
   * session is ordinary, and a boolean looks unchanged the second time.
   */
  const [meetingsAt, setMeetingsAt] = useState<number | null>(null);
  /** When the + menu last asked for a fresh conversation. See `AsidePanel`. */
  const [newChatAt, setNewChatAt] = useState<number | null>(null);
  /**
   * When a phone last asked for one, or `null` for "no card on screen".
   *
   * A timestamp rather than a boolean, for `asked`'s reason and `meetingsAt`'s:
   * asking twice in a session is ordinary, and it is also the `key` that gives
   * the card a fresh conversation each time rather than the last one reopened.
   */
  const [phoneChatAt, setPhoneChatAt] = useState<number | null>(null);
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
  const { startMeetingFlow, sheet: meetingSheet } = useMeetingFlow({
    contexts: data.contexts,
    onClaimName: data.demo ? undefined : () => router.push(WELCOME_ROUTE),
    onStarted: hasAside ? showMeetings : undefined,
  });

  /**
   * A FRESH CONVERSATION, OR `null` WHERE THERE IS NOWHERE FOR ONE TO GO.
   *
   * Defined once because two surfaces offer it now — the corner's menu and the
   * phone's `+` sheet — and two copies of a gate is one copy that eventually
   * disagrees with the other about when it is open.
   *
   * Three conditions, and the third is the owner's: a panel to answer in (so not
   * a phone), an engine behind it (so not the demo console), and **a model key
   * on this context** — *"new chat should be off if no LLM api key configured"*.
   * `=== true` rather than truthiness, because `modelConnected` is `undefined`
   * until the subscription answers and the row is better absent for that moment
   * than offered and withdrawn.
   */
  const startNewChat = useMemo(
    () =>
      !data.demo && data.modelConnected === true
        ? () => {
            const at = Date.now();
            /*
              TWO SURFACES, ONE OFFER.

              A pointer layout opens the panel beside the note. **A phone opens
              `AgentPanel` over it**, which is what closed the gap this used to
              have: `hasAside` was part of the condition above, so the Chat row
              was simply absent from the phone's `+` while the corner's menu
              offered it. That was never a decision — it was a fact about the
              code, because the only thing that raised `AgentPanel` was the
              floating microphone `NoteEditor` mounts, so the way to the agent on
              a phone was to open a note, put the keyboard up until the bottom
              row hid, and press the microphone that came back.

              `AgentPanel` is a `Modal` and says in its own header that it is one
              so it can "appear identically on a surface that has no console
              around it at all". So this layout raises it, and neither density
              has to be told about the other's furniture.
            */
            if (!hasAside) return setPhoneChatAt(at);
            setOpenAsideAt(at);
            setAsked(null);
            setNewChatAt(at);
          }
        : null,
    [data.demo, data.modelConnected, hasAside],
  );
  /** Recording, or `null` on a console with no controller behind one. */
  const startMeeting = data.demo ? null : startMeetingFlow;
  /*
    Whether the phone's `+` has anything to offer — asked through the same
    function that decides which rows its sheet draws, so the key and its contents
    cannot disagree. See `files/createSheet.ts`.
  */
  const canCreate = canCreateAnything({
    canEdit: data.files.canEdit,
    chat: startNewChat !== null,
    meeting: startMeeting !== null,
  });

  /**
   * What the microphone over the note needs, which is only what this layout
   * already knows.
   *
   * `context` is the whole `ConsoleContext` rather than its slug: the dictation
   * sheet has to say who can read the open note before the microphone opens,
   * and that is a question about `kind` and `role` — see
   * `features/voice/audience.ts` for why an unrecognised `kind` is never
   * answered "only you".
   *
   * `writable` is the entry's own answer, not the membership's. `privacy.md`
   * and an encrypted envelope are read-only inside a context you own outright,
   * and `NoteEditor` narrows this again with its own `editable` — reading mode
   * and a conflict both close the note to typing without changing either of
   * these.
   */
  /*
    The agent's own engine, built here and not in the editor.

    It mints this app's gateway grant on demand — an ordinary, revocable OAuth
    grant clamped to this person's role — and holds it in memory for the hour
    it lives. `features/agent/useAgentEngine.ts` has the argument for why it is
    never written to the device.
  */
  /*
    Whether something is recording, for the panel's ambient place. Read here
    rather than inside `AsidePanel` so that what the agent is told about the
    room is assembled in one place — `agentPage` is that place's only builder,
    and a second caller filling one field from a different source is how two
    surfaces end up describing different rooms.
  */
  const meetingsSnapshot = useMeetingsSnapshot();
  const liveMeeting = meetingsSnapshot.live;
  const openNote = useOpenNote();
  /**
   * WHERE THE PERSON IS, FOR THE AGENT — BUILT ONCE.
   *
   * Two surfaces answer a question now: the panel beside the note, and the card
   * a phone raises over it. `agentPage`'s own comment asks for exactly this —
   * *"the room is assembled in one place, and `agentPage` is that place's only
   * builder"* — because the object is a set of **references** and a second copy
   * is a second chance to put a note body in one.
   *
   * `meetingLive` is read from the store rather than passed `false` the way
   * `NoteEditor` passes it, and that is not a disagreement: the editor's own
   * control returns `null` for the whole of a meeting, so its conversation
   * cannot be on screen while one runs, and these two can.
   */
  const agentPlace = agentPage({
    context: insideContext ? current : null,
    /*
      What the editor published, rather than a reference rebuilt from
      `selectedEntry`. A tree row carries a path and a visibility and knows
      nothing about the etag, the encryption or the draft — so three of the five
      fields would be claims, and `unsaved: false` on a note somebody is typing
      into is the opposite of the honesty that field exists for.
    */
    editor: { reference: openNote },
    route: pathname,
    meetingLive: liveMeeting !== null,
    query: null,
  });
  /**
   * A question handed over from ⌘K, if one has been.
   *
   * The counter is the event rather than the text — see `AsidePanel`, which
   * explains it where it is read. Held here rather than inside the panel
   * because the palette is a sibling of it: both are children of the frame,
   * and this layout is the one thing above both.
   */
  const [asked, setAsked] = useState<{ text: string; at: number } | null>(null);
  /**
   * When something last asked for the panel to be opened, without a question.
   *
   * The note's right-click menu is the caller. A counter rather than a
   * boolean, for the reason `asked` carries one: asking twice is ordinary, and
   * the second ask must not look like a re-render. `null` is "nobody has".
   */
  const [openAsideAt, setOpenAsideAt] = useState<number | null>(null);

  const agentEngine = useAgentEngine({
    workspaceId: data.selectedContextId,
    endpoint: data.endpoint,
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
        The note's right-click menu, reaching the right panel. Absent on the
        demo console — there is no engine behind it — and the row is then gone
        rather than pressable and inert. Whether the *density* has a panel is
        `OpenAsideOn`'s to answer, because that is a frame question and this is
        above the frame.
      */
      onAskAgent: data.demo ? undefined : () => setOpenAsideAt(Date.now()),
      /*
        The one place holding both halves the engine needs: the workspace the
        grant is minted for, and the endpoint its `/agent` route is derived
        from. `NoteEditor` has never seen either, and the surfaces that render
        `BrowsePane` without this provider get the stub instead.
      */
      agent: agentEngine,
      /*
        The corner is the `+` at every pointer density, so the editor draws no
        resting microphone there. Published rather than derived, because the
        fixture and the demo console are desktop-width consoles with no `+` —
        see `VoiceHost.createButton`.
      */
      createButton: !phone,
    }),
    [insideContext, current, selectedEntry, startMeetingFlow, agentEngine, data.demo, phone],
  );
  return {
    meetingsAt,
    newChatAt,
    phoneChatAt,
    setPhoneChatAt,
    showMeetings,
    places,
    contextHrefFrom,
    startMeetingFlow,
    meetingSheet,
    startNewChat,
    startMeeting,
    canCreate,
    agentPlace,
    asked,
    setAsked,
    openAsideAt,
    agentEngine,
    resumeRow,
    voiceHost,
  };
}

export type ConsoleAside = ReturnType<typeof useConsoleAside>;
