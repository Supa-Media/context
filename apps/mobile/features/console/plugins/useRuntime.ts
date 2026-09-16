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
  OpenTextModal,
  PendingCommand,
  PreviewRequest,
  SuggestRequest,
} from "./runtime";
import { PREVIEW_LINKS_MAX } from "@context/obsidian-runtime";
import type { LinkPreview } from "./sandboxTypes";
import type { PluginGrant } from "./grants";
import {
  COMMAND_TIMEOUT_MS,
  PREVIEW_TIMEOUT_MS,
  SUGGEST_TIMEOUT_MS,
  appliedPluginNoteWrite,
  currentWalk,
  freshPreviews,
  freshSuggestions,
  maySeeContent,
  vaultEventForOperation,
} from "./runtime";
import type { ActiveSandbox, PluginRegistration, RuntimeState, RuntimeView } from "./runtime";

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
  const [textModalDismiss, setTextModalDismiss] = useState<
    { seq: number; pluginId: string; nonce: string } | undefined
  >(undefined);
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
    const live = new Set(sandboxes.map((one) => one.bundle.pluginId));
    const prune = <T,>(was: Record<string, T>): Record<string, T> => {
      const keys = Object.keys(was);
      const keep = keys.filter((pluginId) => live.has(pluginId));
      if (keep.length === keys.length) return was;
      return Object.fromEntries(keep.map((pluginId) => [pluginId, was[pluginId]!]));
    };
    /*
      A frame leaving is an answer that is never coming. Left alone, the editor
      would hold a completion promise until its timer fired — briefly correct
      and needlessly slow, on a surface measured in keystrokes.
    */
    if (sandboxes.length === 0) {
      for (const [, pending] of waiting.current) { clearTimeout(pending.timer); pending.resolve([]); }
      waiting.current.clear();
      for (const [, pending] of applying.current) { clearTimeout(pending.timer); pending.resolve(null); }
      applying.current.clear();
      for (const [, pending] of previewing.current) { clearTimeout(pending.timer); pending.resolve([]); }
      previewing.current.clear();
      offeredBy.current = null;
    }
    setRegistrations(prune);
    /*
      And the status bar with them. A reading is worse than a name to leave
      behind: "412 words" beside a plugin whose frame is gone is not out of
      date, it is being produced by nothing.
    */
    setStatusItems(prune);
    /*
      An outcome outlives its frame no more than a registration does: "Ran"
      beside a command belonging to a plugin that has since stopped is the same
      false claim, one step further on.
    */
    setOutcomes(prune);
    /*
      And what a departed frame was still being waited on for. A plugin with no
      frame cannot answer, so leaving it pending would be a spinner nothing is
      behind — the same stale claim as the reading above, in its most misleading
      form. The timer goes with it, or it would fire "nothing answered" over a
      plugin nobody is running any more.
    */
    for (const [pluginId, timer] of [...commandTimers.current]) {
      if (live.has(pluginId)) continue;
      clearTimeout(timer);
      commandTimers.current.delete(pluginId);
    }
    setPending(prune);
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

  /*
    Ask a running plugin to run one of its commands.

    Synchronous and fire-and-forget: this only moves a slot, and the frame posts
    the message from an effect. The answer comes back as `command-result` and
    lands in `outcomes`, so a caller awaits nothing — there is no promise here
    that could resolve, because the guest may simply never answer and a hung
    command must not look like a pending one for ever.
  */
  const run = useCallback((pluginId: string, id: string) => {
    if (!isOwner) return;
    /*
      Addressed to the frame that is running right now. A press for a plugin
      with no live frame is dropped here rather than sitting in the slot waiting
      for one to appear — see `invokeFor` for why a later frame must not inherit
      it.
    */
    const frame = sandboxes.find((one) => one.bundle.pluginId === pluginId);
    if (frame === undefined) return;
    presses.current += 1;
    const seq = presses.current;
    setInvoke({ seq, pluginId, nonce: frame.nonce, id });
    setOutcomes((was) => {
      if (!(pluginId in was)) return was;
      const next = { ...was };
      delete next[pluginId];
      return next;
    });
    setPending((was) => ({ ...was, [pluginId]: { id, seq } }));
    /*
      One timer per plugin, replacing any previous one: a second press
      supersedes the first, and the first's clock must not fire a "nothing
      answered" over the second's result.
    */
    const running = commandTimers.current.get(pluginId);
    if (running !== undefined) clearTimeout(running);
    commandTimers.current.set(
      pluginId,
      setTimeout(() => {
        commandTimers.current.delete(pluginId);
        setPending((was) => {
          // Only if this press is still the one outstanding.
          if (was[pluginId]?.seq !== seq) return was;
          const next = { ...was };
          delete next[pluginId];
          return next;
        });
        setOutcomes((was) => ({
          ...was,
          // `error: null` on purpose — nothing reported anything, and the card
          // must not say the plugin did. See `CommandOutcome.timedOut`.
          [pluginId]: { id, ok: false, error: null, timedOut: true },
        }));
      }, COMMAND_TIMEOUT_MS),
    );
  }, [isOwner, sandboxes]);

  /**
   * Ask the plugins whether any of them wants to complete this line.
   *
   * **First non-empty answer wins**, which is what the guest does too: its
   * loop returns on the first suggester whose `onTrigger` matches, exactly as
   * Obsidian's does. So the frames are asked in order and the first that
   * offers anything owns the menu — and owns the pick, which is what makes
   * `applySuggestion` unambiguous.
   *
   * Only frames that pass `maySeeContent` are asked at all. The line is note
   * content, and that gate is `vault:read` alone.
   */
  const askSuggestions = useCallback(async (line: string, ch: number) => {
    if (!isOwner) return [];
    walk.current += 1;
    const mine = walk.current;
    for (const frame of sandboxes) {
      if (!currentWalk(mine, walk.current)) return [];
      if (!maySeeContent(frame.bundle, grants)) continue;
      suggestSeq.current += 1;
      const seq = suggestSeq.current;
      lastAsked.current = seq;
      const answer = new Promise<{ text: string }[]>((resolve) => {
        const timer = setTimeout(() => {
          waiting.current.delete(seq);
          resolve([]);
        }, SUGGEST_TIMEOUT_MS);
        waiting.current.set(seq, { resolve, timer });
      });
      setSuggest({ seq, pluginId: frame.bundle.pluginId, nonce: frame.nonce, line, ch });
      const items = await answer;
      if (!currentWalk(mine, walk.current)) return [];
      if (items.length > 0) return items;
    }
    return [];
  }, [grants, isOwner, sandboxes]);

  /**
   * Ask the plugins to preview the open note's links.
   *
   * **Every frame is asked, and the answers are merged** — which is the one
   * place this deliberately differs from `askSuggestions`. A completion menu
   * has to belong to one plugin, because a pick has to be routed back to
   * whoever computed it; a preview is a finished string per link, so two
   * plugins previewing different links in the same note is a note where both
   * work rather than a conflict.
   *
   * Where two do claim the same link the first frame wins, for the same reason
   * the first suggester does: the order is the order they were started in, and
   * silently showing the second plugin's words under the first plugin's link
   * would be a worse answer than a stable one.
   *
   * Only frames that pass `maySeeContent` are asked. A link is note content —
   * the address somebody wrote down and the words they wrote around it.
   */
  /*
    Ask the open dialog what to show. One frame, not a walk: the dialog already
    belongs to whoever opened it, so there is nobody else to ask.
  */
  const askModalSuggestions = useCallback(async (query: string) => {
    if (!isOwner || modal === null) return [];
    modalSeq.current += 1;
    const seq = modalSeq.current;
    lastModalAsked.current = seq;
    const answer = new Promise<{ text: string }[]>((resolve) => {
      const timer = setTimeout(() => {
        modalWaiting.current.delete(seq);
        resolve([]);
      }, SUGGEST_TIMEOUT_MS);
      modalWaiting.current.set(seq, {
        resolve,
        timer,
        pluginId: modal.pluginId,
        nonce: modal.nonce,
      });
    });
    setModalQuery({ seq, pluginId: modal.pluginId, nonce: modal.nonce, query });
    return await answer;
  }, [isOwner, modal]);

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

  /*
    Same rule as `dismissModal`: the dialog goes now and the guest is told.
    A reader closing a dialog must not be waiting on the plugin that opened it.
  */
  const dismissTextModal = useCallback(() => {
    if (textModal === null) return;
    modalSeq.current += 1;
    setTextModalDismiss({
      seq: modalSeq.current,
      pluginId: textModal.pluginId,
      nonce: textModal.nonce,
    });
    setTextModal(null);
  }, [textModal]);

  const askPreviews = useCallback(async (links: LinkPreview[]) => {
    if (!isOwner || links.length === 0) return [];
    previewWalk.current += 1;
    const mine = previewWalk.current;
    const byHref = new Map<string, string>();
    for (const frame of sandboxes) {
      if (!currentWalk(mine, previewWalk.current)) return [];
      if (!maySeeContent(frame.bundle, grants)) continue;
      previewSeq.current += 1;
      const seq = previewSeq.current;
      lastPreviewAsked.current = seq;
      const answer = new Promise<LinkPreview[]>((resolve) => {
        const timer = setTimeout(() => {
          previewing.current.delete(seq);
          resolve([]);
        }, PREVIEW_TIMEOUT_MS);
        previewing.current.set(seq, { resolve, timer });
      });
      setPreview({
        seq,
        pluginId: frame.bundle.pluginId,
        nonce: frame.nonce,
        links: links.slice(0, PREVIEW_LINKS_MAX),
      });
      const previews = await answer;
      if (!currentWalk(mine, previewWalk.current)) return [];
      for (const one of previews) {
        if (one.text === "" || byHref.has(one.href)) continue;
        byHref.set(one.href, one.text);
      }
    }
    return [...byHref].map(([href, text]) => ({ href, text }));
  }, [grants, isOwner, sandboxes]);

  /**
   * Take the suggestion somebody picked, and return the line it produced.
   *
   * Routed to the frame that offered the menu rather than to the plugin, for
   * #533's reason: a restart registers the same things, and a pick aimed at a
   * frame that has gone is not owed to its successor. Null when nothing
   * answers, so the editor leaves the line alone rather than clearing it.
   */
  const applySuggestion = useCallback(async (index: number) => {
    const offer = offeredBy.current;
    if (offer === null) return null;
    suggestSeq.current += 1;
    const seq = suggestSeq.current;
    const answer = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        applying.current.delete(seq);
        resolve(null);
      }, SUGGEST_TIMEOUT_MS);
      applying.current.set(seq, { resolve, timer });
    });
    setSuggestApply({ seq, pluginId: offer.pluginId, nonce: offer.nonce, index });
    return answer;
  }, []);

  const onEvent = useCallback((sandbox: ActiveSandbox, event: SandboxEvent) => {
    if (workspaceId === null) return;
    const { pluginId, bundleFingerprint, runtimeToken } = sandbox.bundle;
    if (event.type === "registration") {
      /*
        Appended rather than replaced, because a bundle registers each command
        in its own message as it loads. Keyed by `id` so a plugin that
        re-registers one does not list it twice.
      */
      setRegistrations((was) => {
        const mine = was[pluginId] ?? [];
        const without = mine.filter((one) => one.id !== event.id);
        return {
          ...was,
          [pluginId]: [
            ...without,
            { kind: event.kind, id: event.id, name: event.name, needsEditor: event.needsEditor },
          ],
        };
      });
      return;
    }
    if (event.type === "status-bar") {
      /*
        Replaced, not merged, which is the whole reason the guest sends a list.
        An empty one is a plugin that cleared its status bar and must clear the
        card with it.
      */
      setStatusItems((was) => ({ ...was, [pluginId]: event.items }));
      return;
    }
    if (event.type === "suggest-results") {
      const pending = waiting.current.get(event.seq);
      if (pending === undefined) return;
      /*
        Stale answers are dropped rather than shown. Typing outruns the round
        trip, and a menu for a line the cursor has left offers completions for
        text that is no longer there.
      */
      const items = freshSuggestions(event, lastAsked.current);
      waiting.current.delete(event.seq);
      clearTimeout(pending.timer);
      if (items !== null && items.length > 0) {
        offeredBy.current = { pluginId, nonce: sandbox.nonce };
      }
      pending.resolve(items ?? []);
      return;
    }
    if (event.type === "suggest-modal") {
      /*
        The plugin asked for a dialog, or said it closed its own. Recorded
        against the frame that said it, because every later query and pick is
        routed back to exactly that frame — a dialog belongs to whoever opened
        it, and a plugin restarted under a new nonce is not the same frame.
      */
      setModal(
        event.open
          ? {
              pluginId,
              nonce: sandbox.nonce,
              placeholder: event.placeholder,
              instructions: event.instructions,
            }
          : null,
      );
      return;
    }
    if (event.type === "text-modal") {
      /*
        Recorded against the frame that sent it, like the suggestion dialog and
        for the same reason: a dismissal has to reach the plugin that opened it,
        and a plugin restarted under a new nonce is not that plugin.

        An update to a dialog already open replaces it in place — the guest
        re-sends on every change to its own content, which is how an async
        `onOpen` arrives at all.
      */
      setTextModal(
        event.open
          ? { pluginId, nonce: sandbox.nonce, title: event.title, text: event.text }
          : null,
      );
      return;
    }
    if (event.type === "suggest-modal-results") {
      const pending = modalWaiting.current.get(event.seq);
      if (pending === undefined) return;
      /*
        ONLY THE FRAME THAT WAS ASKED MAY ANSWER.

        `askModalSuggestions` says it above — "whoever sent `suggest-modal` is
        the only frame that will ever be queried or picked from" — and
        `PluginSandboxFarm` holds up its end, addressing the query to one frame
        by plugin id AND nonce. This is the other end of that sentence, and it
        was missing: the answer was matched on `seq` alone, so a frame that was
        never asked could volunteer one.

        What that bought: the dialog on screen NAMES the plugin that opened it,
        so a second plugin's rows would appear under somebody else's name, and
        the reader's pick then travels to the named plugin as an index into a
        list it never produced. The completion menu can match on `seq` alone
        because every frame really is asked there; here exactly one was.

        Returned WITHOUT consuming the entry, deliberately. Deleting it would
        let an unasked frame silence the real answer as well as forge one, which
        turns a spoof into a denial — the reader would sit in front of a dialog
        that never fills. The impostor is ignored; the owner is still awaited,
        and the timeout still ends it if nobody answers.
      */
      if (pending.pluginId !== pluginId || pending.nonce !== sandbox.nonce) return;
      modalWaiting.current.delete(event.seq);
      clearTimeout(pending.timer);
      /*
        Stale answers are dropped rather than drawn, exactly as a completion's
        are: typing outruns the round trip, and a list computed for a query the
        reader has moved on from is a list of the wrong things.
      */
      pending.resolve(event.seq === lastModalAsked.current ? event.items : []);
      return;
    }
    if (event.type === "suggest-modal-picked") {
      // Closed unless the plugin opened another while handling the pick. A
      // console that closed unconditionally would shut the dialog it was just
      // asked for — see `reopened` in the protocol.
      if (!event.reopened) setModal(null);
      return;
    }
    if (event.type === "preview-results") {
      const pending = previewing.current.get(event.seq);
      if (pending === undefined) return;
      const previews = freshPreviews(event, lastPreviewAsked.current);
      previewing.current.delete(event.seq);
      clearTimeout(pending.timer);
      pending.resolve(previews ?? []);
      return;
    }
    if (event.type === "suggest-applied") {
      const pending = applying.current.get(event.seq);
      if (pending === undefined) return;
      applying.current.delete(event.seq);
      clearTimeout(pending.timer);
      pending.resolve(event.line);
      return;
    }
    if (event.type === "command-result") {
      /*
        The answer arrived, so the clock stops whatever it says. A late answer
        that beat nothing — the timeout already fired — still replaces the
        timed-out row, because what the plugin actually said is better than the
        console's guess that it would not say anything.
      */
      const running = commandTimers.current.get(pluginId);
      if (running !== undefined) {
        clearTimeout(running);
        commandTimers.current.delete(pluginId);
      }
      setPending((was) => {
        if (!(pluginId in was)) return was;
        const next = { ...was };
        delete next[pluginId];
        return next;
      });
      setOutcomes((was) => ({
        ...was,
        [pluginId]: { id: event.id, ok: event.ok, error: event.error },
      }));
      return;
    }
    if (event.type === "unloaded") {
      /*
        The frame is still mounted and has torn its plugin down, so the effect
        above does not fire — this is the one clear that is not derived.
      */
      const forget = <T,>(was: Record<string, T>): Record<string, T> => {
        if (!(pluginId in was)) return was;
        const next = { ...was };
        delete next[pluginId];
        return next;
      };
      setRegistrations(forget);
      setStatusItems(forget);
      return;
    }
    if (event.type === "loaded") {
      void reportStatus({
        workspaceId, pluginId, bundleFingerprint,
        status: "loaded", attempts: sandbox.attempts,
      }).catch(() => undefined);
      return;
    }
    if (event.type === "rpc") {
      const requestId = typeof (event.request as { requestId?: unknown }).requestId === "string"
        ? (event.request as { requestId: string }).requestId
        : "invalid";
      const operation = (event.request as {
        operation?: {
          kind?: unknown;
          path?: unknown;
          from?: unknown;
          to?: unknown;
          text?: unknown;
          expectedEtag?: unknown;
        };
      }).operation;
      void executeRequest({ runtimeToken, request: event.request }).then((response) => {
        event.respond(response);
        const noteWrite = appliedPluginNoteWrite(operation, response);
        if (noteWrite !== null) onNoteWrite?.(noteWrite);
        const change = vaultEventForOperation(operation, response);
        if (change !== null) publish(change);
      }).catch(() => {
        event.respond({
          version: 1,
          requestId,
          ok: false,
          error: { code: "PLUGIN_SESSION_INVALID", message: "Start this plugin again" },
        });
      });
      return;
    }
    /*
      A FRAME THAT NAVIGATED AWAY IS STOPPED, NOT RETRIED.

      `crashed` below reloads up to three times, which is right for a bundle
      that threw and wrong for one that left: it would simply leave again on
      each attempt. So this ends the plugin and records `blocked` — the status
      whose own copy already says "Context turned this version off" — without
      touching the owner's approval, exactly as Stop does.
    */
    if (event.type === "disowned") {
      setSandboxes((was) => was.filter((one) => one.nonce !== sandbox.nonce));
      void reportStatus({
        workspaceId, pluginId, bundleFingerprint,
        status: "blocked", attempts: sandbox.attempts,
        errorCode: "SANDBOX_DISOWNED",
        errorMessage: "This plugin's sandbox stopped being the one Context started, so Context stopped it.",
      }).catch(() => undefined);
      return;
    }
    if (event.type === "crashed") {
      setSandboxes((was) => was.filter((one) => one.nonce !== sandbox.nonce));
      if (sandbox.attempts < 3) {
        void loadBundle({ workspaceId, pluginId, bundleFingerprint }).then((bundle) => {
          setSandboxes((was) => [
            ...was.filter((one) => one.bundle.pluginId !== pluginId),
            { bundle, nonce: newSandboxNonce(), attempts: sandbox.attempts + 1 },
          ]);
        }).catch((error) => reportCrash(pluginId, bundleFingerprint, 3, error));
      } else {
        void reportCrash(pluginId, bundleFingerprint, sandbox.attempts, new Error(event.message));
      }
    }
  }, [executeRequest, loadBundle, onNoteWrite, publish, reportCrash, reportStatus, workspaceId]);

  useEffect(() => {
    if (!states || workspaceId === null || !isOwner) return;
    for (const state of states) {
      if (state.status !== "loaded") continue;
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

  useEffect(() => {
    const timers = sandboxes.map((sandbox) => setTimeout(() => {
      void start(sandbox.bundle.pluginId, sandbox.bundle.bundleFingerprint).catch(() => undefined);
    }, Math.max(0, sandbox.bundle.expiresAt - Date.now() - 5_000)));
    return () => timers.forEach(clearTimeout);
  }, [sandboxes, start]);

  return {
    states,
    loading: isOwner && workspaceId !== null && raw === undefined,
    host: isOwner
      ? createElement(PluginSandboxFarm, {
          sandboxes, onEvent, activeFile, vaultEvent, invoke, suggest, suggestApply, preview, grants,
          modalQuery, modalPick, modalDismiss, textModalDismiss,
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
          dismissTextModal,
        }
      : undefined,
  };
}
