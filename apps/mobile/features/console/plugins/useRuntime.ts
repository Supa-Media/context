import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { EMPTY_QUERY_SPEC } from "../querySpec";
import { PluginSandboxFarm } from "./PluginSandboxFarm";
import { newSandboxNonce } from "./sandboxNonce";
import type { ActiveFileRef, SandboxEvent, StatusItem, VaultEventMessage } from "./sandboxTypes";
import type {
  AppliedPluginNoteWrite,
  CommandOutcome,
  InvokeRequest,
  OpenModal,
  OpenSettingsPane,
  OpenTextModal,
  PendingCommand,
  PluginWorkReason,
  PreviewRequest,
  SuggestRequest,
} from "./runtime";
import type { LinkPreview } from "./sandboxTypes";
import type { PluginGrant } from "./grants";
import { shouldResumeRuntime } from "./runtime";
import type { ActiveSandbox, PluginRegistration, RuntimeState, RuntimeView } from "./runtime";
import { pruneDepartedFrames } from "./runtimePrune";
import { handleSandboxEvent } from "./runtimeEvents";
import {
  applyOfferedSuggestion,
  askFramesForPreviews,
  askFramesForSuggestions,
  pressCommand,
} from "./runtimeRequests";
import {
  askDialogSuggestions,
  closeOpenSettingsPane,
  closeTextDialog,
  requestSettingsPane,
} from "./runtimeDialogs";

/**
 * What the sandbox host says each plugin is doing.
 *
 * A live subscription, like `useGrants` and unlike `usePlugins`: these are rows
 * the control plane already holds, written by `reportRuntimeStatus` after a load
 * or a bounded crash retry. It has to be live — a plugin that crash-loops while
 * somebody is looking at this screen should say so without being asked, and a
 * Revoke pressed one card away turns its runtime row to `blocked` in the same
 * transaction.
 *
 * Owner-only, decided from `role` before the call, like every other plugin view.
 *
 * Called from `useLiveConsoleData`, which owns every subscription the console
 * makes — do not call this from a pane.
 */
export function useRuntime(options: {
  workspaceId: Id<"workspaces"> | null;
  role: string | undefined;
  /**
   * The note the console has open, or `null`.
   *
   * Passed down to every loaded sandbox so `workspace.getActiveFile()` answers
   * and `file-open` fires. Path and etag only — a plugin that wants the body
   * reads it through the audited RPC like any other file.
   */
  activeFile?: ActiveFileRef | null;
  /**
   * What each plugin was approved for.
   *
   * Required for the host to know who may be told a note's path at all — see
   * `maySeePaths`. Absent (the query has not answered) means nobody is told
   * anything, which is the right way round: a plugin that hears about a change
   * a moment late is a plugin working; one told a path it was never granted is
   * a read nobody approved.
   */
  grants?: readonly PluginGrant[];
  /** Update the trusted editor after Convex confirms a plugin note write. */
  onNoteWrite?: (write: AppliedPluginNoteWrite) => void;
}): RuntimeView {
  const { workspaceId, role, activeFile = null, grants, onNoteWrite } = options;
  const isOwner = role === "owner";
  const loadBundle = useAction(api.functions.obsidianPlugins.loadPluginBundle);
  const executeRequest = useAction(api.functions.obsidianPlugins.executePluginRequest);
  const reportStatus = useMutation(api.functions.obsidianPlugins.reportRuntimeStatus);
  const stopPlugin = useMutation(api.functions.obsidianPlugins.stopPlugin);
  const [sandboxes, setSandboxes] = useState<ActiveSandbox[]>([]);
  /*
    What each running plugin told the shim it registered.

    Local to this tab and to this load, because that is exactly what it
    describes: a command exists while the frame that registered it is alive,
    and a list surviving the frame would claim the console has something it
    does not. Every path that removes a sandbox clears its entry.
  */
  const [registrations, setRegistrations] = useState<Record<string, PluginRegistration[]>>({});
  /*
    The command the owner last pressed, and how the last one turned out.

    One slot each rather than a queue, matching `vaultEvent`: a person presses
    one command at a time, and a second press replaces the first rather than
    stacking behind it. `seq` is what makes a repeat of the same command a
    second message instead of no message at all.
  */
  const [invoke, setInvoke] = useState<InvokeRequest | undefined>(undefined);
  const [outcomes, setOutcomes] = useState<Record<string, CommandOutcome>>({});
  /*
    What each running plugin has in its status bar.

    The guest reports the whole list every time it changes, so this replaces
    rather than merges — there is no removal message to lose, and a plugin that
    empties its status bar sends an empty list rather than nothing at all.
  */
  const [statusItems, setStatusItems] = useState<Record<string, StatusItem[]>>({});
  const presses = useRef(0);
  /*
    EDITOR SUGGESTIONS: A ROUND TRIP THE EDITOR AWAITS, WITH A CLOCK ON IT.

    CodeMirror's completion source is a promise, and the answer comes back as a
    message from a frame this host does not control. So a query is a sequence
    number, a promise, and a timer — and **the timer is the part #533 said was
    missing**. That change shipped a command with no timeout and named it: "a
    pending state that can hang for ever is worse than none". A completion menu
    that never resolves is that, on every keystroke, in the editor. A guest that
    does not answer inside the window resolves to nothing and the person keeps
    typing.
  */
  const [suggest, setSuggest] = useState<SuggestRequest | undefined>(undefined);
  const [suggestApply, setSuggestApply] = useState<
    { seq: number; pluginId: string; nonce: string; index: number } | undefined
  >(undefined);
  const suggestSeq = useRef(0);
  const waiting = useRef(new Map<number, {
    resolve: (items: { text: string }[]) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());
  const applying = useRef(new Map<number, {
    resolve: (line: string | null) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());
  const lastAsked = useRef<number | null>(null);
  /*
    Which walk is current. Two keystrokes overlap, so an answer is only used
    while the walk that asked for it is still the one the editor waits on —
    see `currentWalk` for the race this closes.
  */
  const walk = useRef(0);
  const offeredBy = useRef<{ pluginId: string; nonce: string } | null>(null);

  /*
    THE SUGGESTION DIALOG, WHICH IS THE SAME ROUND TRIP WITH A DIFFERENT OWNER.

    A completion menu is asked for by the *editor*, so the host walks the frames
    and the first that offers anything owns it. A dialog is asked for by the
    *plugin*, so ownership is settled before any query happens: whoever sent
    `suggest-modal` is the only frame that will ever be queried or picked from.
    That is why this keeps a `modal` rather than an `offeredBy`.

    One at a time. A second plugin opening one replaces the first, which is what
    a single dialog surface means and matches what the guest does with its own
    `openModal`.
  */
  const [modal, setModal] = useState<OpenModal | null>(null);
  const modalSeq = useRef(0);
  const [modalQuery, setModalQuery] = useState<
    { seq: number; pluginId: string; nonce: string; query: string } | undefined
  >(undefined);
  const [modalPick, setModalPick] = useState<
    { seq: number; pluginId: string; nonce: string; index: number } | undefined
  >(undefined);
  const [modalDismiss, setModalDismiss] = useState<
    { seq: number; pluginId: string; nonce: string } | undefined
  >(undefined);
  /*
    The plain dialog, held beside the suggestion one rather than in it.

    Also one at a time, and also replaced by whoever opens next. It carries no
    query and no pick — a `Modal` shows something — so the only thing that
    travels back is a dismissal.
  */
  const [textModal, setTextModal] = useState<OpenTextModal | null>(null);
  /*
    The last pick that could not be applied, and whose it was.

    Held beside the dialog rather than on it, because by the time this is known
    the dialog is gone: the guest closes its own modal before running
    `onChooseSuggestion`, exactly as Obsidian does, so there is nothing left to
    put a banner inside. One slot, replaced by the next failure and cleared when
    another dialog opens — it describes the last thing the reader pressed, and
    two of them stacked would be a queue of complaints about one press.
  */
  const [pickFailure, setPickFailure] = useState<
    { pluginId: string; reason: PluginWorkReason } | null
  >(null);
  const [textModalDismiss, setTextModalDismiss] = useState<
    { seq: number; pluginId: string; nonce: string } | undefined
  >(undefined);
  /*
    Whose dialog is on screen, held in a ref rather than read off state inside
    `onEvent`.

    The reason is the one the suggestion dialog's `modalWaiting` states two
    hundred lines below: `onEvent` is a `useCallback` whose dependency list does
    not name this, so a state read inside it is fresh only while some *other*
    dependency keeps the callback unstable. That is true today and it is not a
    property anybody is holding — and the two failure directions are not equal.
    A stale `settingsPane` fails CLOSED: the pane stops opening, somebody
    notices within a day. A stale owner here would fail OPEN, silently, and the
    check would go on looking exactly like a check.
  */
  const textModalOwner = useRef<{ pluginId: string; nonce: string } | null>(null);
  /*
    A plugin's own settings pane, and which plugins have one to offer.

    `settingsTabs` is a set rather than a list because `addSettingTab` is
    announced once per load and a restarted plugin announces again; the ids
    are what the plugins panel reads to decide whether to draw a Settings
    control on a row.
  */
  const [settingsTabs, setSettingsTabs] = useState<string[]>([]);
  const [settingsPane, setSettingsPane] = useState<OpenSettingsPane | null>(null);
  const [settingsRequest, setSettingsRequest] = useState<
    { seq: number; pluginId: string; nonce: string; open: boolean } | undefined
  >(undefined);
  const [settingsChange, setSettingsChange] = useState<
    { seq: number; pluginId: string; nonce: string; index: number; value: boolean | string | number }
    | undefined
  >(undefined);
  /*
    WHOSE PANE WAS ASKED FOR, IN A REF, AND THE BUG THAT PUT IT THERE.

    This check used to read `settingsPane` and `settingsRequest` state from
    inside `onEvent` — and the paragraph beside `textModalOwner` already said
    why that is not safe, then accepted it here on the grounds that it "fails
    CLOSED: the pane stops opening, somebody notices within a day".

    It failed closed, permanently, and somebody did notice: `onEvent` is a
    `useCallback` whose dependencies — two Convex actions, two mutations, a
    workspace id and a `useCallback(…, [])` from the file browser — are every
    one of them stable, so the callback is built on the first render and keeps
    the `settingsRequest` it saw then, which is `undefined`. Every pane any
    plugin ever drew was dropped as one nobody had asked for, and pressing
    Settings… did nothing at all.

    A ref is read at the moment the answer arrives, which is the only moment the
    question "did I ask this frame for this?" has an answer. It carries the same
    two fields the check needs and nothing else.
  */
  const settingsOwner = useRef<{ pluginId: string; nonce: string } | null>(null);
  /*
    The owner is recorded ON the pending entry, not looked up when the answer
    arrives. `onEvent` would otherwise have to read `modal` state to know who it
    asked, and a dialog replaced between the question and the answer would make
    that the wrong owner. What was asked is a property of the asking.
  */
  const modalWaiting = useRef(new Map<number, {
    resolve: (items: { text: string }[]) => void;
    timer: ReturnType<typeof setTimeout>;
    pluginId: string;
    nonce: string;
  }>());
  const lastModalAsked = useRef<number | null>(null);

  /*
    AND THE SAME THREE THINGS FOR THE READ PREVIEW.

    A separate slot, sequence and pending map rather than a shared one, because
    the two questions have different clocks and different answers: a suggestion
    is a keystroke waiting 1.2 seconds for one plugin's list, and a preview is a
    note opening and waiting eight for every plugin's text. Sharing `suggestSeq`
    would let a preview's slow answer be mistaken for a keystroke's stale one.
  */
  /*
    WHAT IS IN FLIGHT, AND THE CLOCK #533 SAID WAS MISSING.

    A press used to set `invoke` and then nothing happened on screen until the
    guest answered — which, for a wedged or departed frame, was never. The
    pending row says the press landed; the timer turns a silence into a stated
    outcome rather than an indefinite blank.
  */
  const [pending, setPending] = useState<Record<string, PendingCommand>>({});
  const commandTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const [preview, setPreview] = useState<PreviewRequest | undefined>(undefined);
  const previewSeq = useRef(0);
  const previewing = useRef(new Map<number, {
    resolve: (previews: LinkPreview[]) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());
  const lastPreviewAsked = useRef<number | null>(null);
  const previewWalk = useRef(0);


  /*
    REGISTRATIONS FOLLOW THE FRAMES, RATHER THAN EACH PATH REMEMBERING TO CLEAR.

    A command exists while the frame that registered it is alive, and there are
    five ways a frame goes: Stop, a crash past its retries, a disowned document,
    a restart that replaces it, and the effect below that drops a sandbox whose
    server-side session was revoked from another device. Clearing at each of
    those is five things to remember and, as a self-review of the first draft
    found, two of them had already been missed — a restart kept the previous
    load's commands, and a revoke from another device left them on screen for a
    plugin that was no longer running.

    Deriving from `sandboxes` instead makes that structural: a plugin with no
    frame has no registrations, whatever removed the frame, including whatever
    removes one next.
  */
  useEffect(() => {
    pruneDepartedFrames(sandboxes, {
      waiting,
      applying,
      previewing,
      offeredBy,
      settingsOwner,
      commandTimers,
      setRegistrations,
      setStatusItems,
      setOutcomes,
      setPending,
      setSettingsTabs,
      setSettingsPane,
    });
  }, [sandboxes]);
  const resumed = useRef(new Set<string>());
  /*
    The last change Context made, handed to every loaded guest.

    **Only what Context did.** A write from Obsidian or rclone never passes
    through this console, so it is not here and no plugin is told about it — the
    limit the product took on 2026-09-14, and the reason the consent screen says
    so out loud rather than leaving somebody to find out from a stale panel.

    One slot rather than a queue: a guest is sent the message as soon as the
    number changes, and two writes in the same frame are two renders.
  */
  const [vaultEvent, setVaultEvent] = useState<VaultEventMessage | undefined>(undefined);
  const seq = useRef(0);
  const publish = useCallback((event: Omit<VaultEventMessage, "seq">) => {
    seq.current += 1;
    setVaultEvent({ ...event, seq: seq.current });
  }, []);

  /*
    A save in the console's own editor, derived rather than reported.

    `useFileBrowser` does not call anybody back on save, and threading a
    callback through it to reach here would be a large change to the editor for
    a small one here. It does not need to: a save is exactly "the same path came
    back with a different etag", which is visible from the two fields already
    handed down. A path *change* is somebody opening another note and is not a
    write.
  */
  const lastSeen = useRef<{ path: string; etag: string | null } | null>(null);
  useEffect(() => {
    const previous = lastSeen.current;
    lastSeen.current = activeFile === null
      ? null
      : { path: activeFile.path, etag: activeFile.etag };
    if (activeFile === null || previous === null) return;
    if (previous.path !== activeFile.path) return;
    if (previous.etag === activeFile.etag) return;
    if (previous.etag === null) return;
    publish({ kind: "modify", path: activeFile.path, etag: activeFile.etag });
  }, [activeFile, publish]);

  const spec = useMemo<RequestForQueries>(() => {
    if (workspaceId === null || !isOwner) return EMPTY_QUERY_SPEC;
    return {
      states: { query: api.functions.obsidianPlugins.listRuntimeStates, args: { workspaceId } },
    };
  }, [workspaceId, isOwner]);

  const results = useQueries(spec);
  const raw = results.states;
  /*
    `undefined` in flight, `Error` when the query threw — `useQueries`, never
    `useQuery`, so one failing subscription does not take the console down.
    Both leave `states` absent rather than empty: an empty array is the claim
    that nothing is running, which is a different sentence from not knowing.
  */
  const states = raw === undefined || raw instanceof Error ? undefined : (raw as RuntimeState[]);

  const reportCrash = useCallback(async (
    pluginId: string,
    bundleFingerprint: string,
    attempts: number,
    error: unknown,
  ) => {
    if (workspaceId === null) return;
    const message = error instanceof Error ? error.message : String(error);
    await reportStatus({
      workspaceId,
      pluginId,
      bundleFingerprint,
      status: "crash-looped",
      attempts,
      errorCode: "PLUGIN_LOAD_FAILED",
      errorMessage: message.slice(0, 500),
    }).catch(() => undefined);
  }, [reportStatus, workspaceId]);

  const start = useCallback(async (pluginId: string, bundleFingerprint: string) => {
    if (workspaceId === null || !isOwner) return;
    resumed.current.add(`${workspaceId}:${pluginId}:${bundleFingerprint}`);
    setSandboxes((was) => was.filter((one) => one.bundle.pluginId !== pluginId));
    let lastError: unknown = new Error("Plugin did not start");
    for (let attempts = 1; attempts <= 3; attempts += 1) {
      try {
        const bundle = await loadBundle({ workspaceId, pluginId, bundleFingerprint });
        setSandboxes((was) => [
          ...was.filter((one) => one.bundle.pluginId !== pluginId),
          { bundle, nonce: newSandboxNonce(), attempts },
        ]);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    await reportCrash(pluginId, bundleFingerprint, 3, lastError);
    throw lastError;
  }, [isOwner, loadBundle, reportCrash, workspaceId]);

  const stop = useCallback(async (pluginId: string, bundleFingerprint: string) => {
    if (workspaceId === null || !isOwner) return;
    // Remove the frame first. Its bearer token is deleted by the mutation next;
    // a racing final request is refused server-side even if unmount is delayed.
    resumed.current.add(`${workspaceId}:${pluginId}:${bundleFingerprint}`);
    setSandboxes((was) => was.filter((one) => one.bundle.pluginId !== pluginId));
    await stopPlugin({ workspaceId, pluginId, bundleFingerprint });
  }, [isOwner, stopPlugin, workspaceId]);

  /** See `pressCommand`. */
  const run = useCallback(
    (pluginId: string, id: string) =>
      pressCommand(
        { isOwner, sandboxes, presses, commandTimers, setInvoke, setOutcomes, setPending },
        pluginId,
        id,
      ),
    [isOwner, sandboxes],
  );

  /** See `askFramesForSuggestions`. */
  const askSuggestions = useCallback(
    (line: string, ch: number) =>
      askFramesForSuggestions(
        { isOwner, sandboxes, grants, walk, suggestSeq, lastAsked, waiting, setSuggest },
        line,
        ch,
      ),
    [grants, isOwner, sandboxes],
  );

  /** See `askDialogSuggestions`. */
  const askModalSuggestions = useCallback(
    (query: string) =>
      askDialogSuggestions(
        { isOwner, modal, modalSeq, lastModalAsked, modalWaiting, setModalQuery },
        query,
      ),
    [isOwner, modal],
  );

  const pickModalSuggestion = useCallback((index: number) => {
    if (!isOwner || modal === null) return;
    modalSeq.current += 1;
    setModalPick({ seq: modalSeq.current, pluginId: modal.pluginId, nonce: modal.nonce, index });
  }, [isOwner, modal]);

  /*
    Closed here as well as told to the guest. The reader pressed Escape and the
    dialog goes now — waiting for the guest to confirm would leave it on screen
    while a wedged plugin decides, which is the one thing a dismiss must not do.
  */
  const dismissModal = useCallback(() => {
    if (modal === null) return;
    modalSeq.current += 1;
    setModalDismiss({ seq: modalSeq.current, pluginId: modal.pluginId, nonce: modal.nonce });
    setModal(null);
  }, [modal]);

  /** The reader has read why their pick did nothing. Nothing crosses. */
  const dismissPickFailure = useCallback(() => setPickFailure(null), []);

  /** See `closeTextDialog`. */
  const dismissTextModal = useCallback(
    () => closeTextDialog({ textModal, modalSeq, textModalOwner, setTextModalDismiss, setTextModal }),
    [textModal],
  );

  /** See `requestSettingsPane`. */
  const openSettingsPane = useCallback(
    (pluginId: string) =>
      requestSettingsPane(
        { sandboxes, modalSeq, settingsOwner, setSettingsPane, setSettingsRequest },
        pluginId,
      ),
    [sandboxes],
  );

  const changeSetting = useCallback(
    (index: number, value: boolean | string | number) => {
      if (settingsPane === null) return;
      modalSeq.current += 1;
      setSettingsChange({
        seq: modalSeq.current,
        pluginId: settingsPane.pluginId,
        nonce: settingsPane.nonce,
        index,
        value,
      });
    },
    [settingsPane],
  );

  /** See `closeOpenSettingsPane`. */
  const closeSettingsPane = useCallback(
    () =>
      closeOpenSettingsPane({ settingsPane, modalSeq, settingsOwner, setSettingsPane, setSettingsRequest }),
    [settingsPane],
  );

  /** See `askFramesForPreviews`. */
  const askPreviews = useCallback(
    (links: LinkPreview[]) =>
      askFramesForPreviews(
        { isOwner, sandboxes, grants, previewWalk, previewSeq, lastPreviewAsked, previewing, setPreview },
        links,
      ),
    [grants, isOwner, sandboxes],
  );

  /** See `applyOfferedSuggestion`. */
  const applySuggestion = useCallback(
    (index: number) => applyOfferedSuggestion({ offeredBy, suggestSeq, applying, setSuggestApply }, index),
    [],
  );

  const onEvent = useCallback((sandbox: ActiveSandbox, event: SandboxEvent) => {
    handleSandboxEvent(
      {
        workspaceId,
        executeRequest,
        loadBundle,
        onNoteWrite,
        publish,
        reportCrash,
        reportStatus,
        setRegistrations,
        setStatusItems,
        setModal,
        setPickFailure,
        setSettingsTabs,
        setSettingsPane,
        setTextModal,
        setPending,
        setOutcomes,
        setSandboxes,
        waiting,
        applying,
        previewing,
        modalWaiting,
        lastAsked,
        lastModalAsked,
        lastPreviewAsked,
        offeredBy,
        settingsOwner,
        textModalOwner,
        commandTimers,
      },
      sandbox,
      event,
    );
  }, [executeRequest, loadBundle, onNoteWrite, publish, reportCrash, reportStatus, workspaceId]);

  useEffect(() => {
    if (!states || workspaceId === null || !isOwner) return;
    for (const state of states) {
      if (!shouldResumeRuntime(state)) continue;
      const key = `${workspaceId}:${state.pluginId}:${state.bundleFingerprint}`;
      if (resumed.current.has(key) || sandboxes.some((one) => one.bundle.pluginId === state.pluginId)) continue;
      resumed.current.add(key);
      void start(state.pluginId, state.bundleFingerprint).catch(() => undefined);
    }
  }, [isOwner, sandboxes, start, states, workspaceId]);

  // A revoke or Stop on another signed-in device invalidates every runtime
  // session server-side. Remove the now-authority-less local frame when the
  // live status row catches up; never leave third-party code running merely
  // because it can no longer reach the broker.
  useEffect(() => {
    if (!states) return;
    setSandboxes((was) => was.filter((sandbox) => states.some((state) =>
      state.status === "loaded" &&
      state.pluginId === sandbox.bundle.pluginId &&
      state.bundleFingerprint === sandbox.bundle.bundleFingerprint
    )));
  }, [states]);

  useEffect(() => {
    setSandboxes([]);
    resumed.current.clear();
  }, [workspaceId]);

  /*
    Restart each frame just before its session expires.

    The delay is clamped to what a timer can actually hold. A delay past 2^31-1
    milliseconds does not mean "later": `setTimeout` truncates it to a 32-bit
    int and fires almost immediately, so a bundle whose session expires far
    enough out would restart its plugin on every tick for ever — the failure
    mode furthest from the one this timer exists for. Real sessions are minutes
    away and never reach the clamp; a deployment that issues a long-lived one
    gets a restart in twenty-five days instead of a loop.
  */
  useEffect(() => {
    const timers = sandboxes.map((sandbox) => setTimeout(
      () => {
        void start(sandbox.bundle.pluginId, sandbox.bundle.bundleFingerprint).catch(() => undefined);
      },
      Math.min(2_147_483_647, Math.max(0, sandbox.bundle.expiresAt - Date.now() - 5_000)),
    ));
    return () => timers.forEach(clearTimeout);
  }, [sandboxes, start]);

  return {
    states,
    loading: isOwner && workspaceId !== null && raw === undefined,
    host: isOwner
      ? createElement(PluginSandboxFarm, {
          sandboxes, onEvent, activeFile, vaultEvent, invoke, suggest, suggestApply, preview, grants,
          modalQuery, modalPick, modalDismiss, textModalDismiss, settingsRequest, settingsChange,
        })
      : undefined,
    registrations,
    outcomes,
    pending,
    statusItems,
    /*
      The path only, and only so the card can tell whether an editor command
      can run. It does not cross to a guest from here — that delivery is
      `PluginSandboxFarm`'s and stays behind `maySeePaths`.
    */
    openNote: activeFile?.path ?? null,
    modal,
    textModal,
    pickFailure,
    settingsPane,
    settingsTabs,
    actions: isOwner && workspaceId !== null
      ? {
          start,
          stop,
          run,
          askSuggestions,
          applySuggestion,
          askPreviews,
          askModalSuggestions,
          pickModalSuggestion,
          dismissModal,
          dismissPickFailure,
          dismissTextModal,
          openSettingsPane,
          changeSetting,
          closeSettingsPane,
        }
      : undefined,
  };
}
