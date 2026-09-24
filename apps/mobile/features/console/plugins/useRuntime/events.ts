import type { ReactAction, ReactMutation } from "convex/react";
import type { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { newSandboxNonce } from "../sandboxNonce";
import type { SandboxEvent, StatusItem, VaultEventMessage } from "../sandboxTypes";
import {
  appliedPluginNoteWrite,
  freshPreviews,
  freshSuggestions,
  vaultEventForOperation,
  type ActiveSandbox,
  type AppliedPluginNoteWrite,
  type CommandOutcome,
  type OpenModal,
  type OpenSettingsPane,
  type OpenTextModal,
  type PendingCommand,
  type PluginRegistration,
  type PluginWorkReason,
} from "../runtime";
import type {
  ApplyWaiting,
  CommandTimers,
  FrameOwner,
  ModalWaiting,
  PreviewWaiting,
  Ref,
  Setter,
  SuggestWaiting,
} from "./cells";

/** Everything `useRuntime`'s `onEvent` reads, from the render that built it. */
export interface SandboxEventContext {
  workspaceId: Id<"workspaces"> | null;
  executeRequest: ReactAction<typeof api.functions.obsidianPlugins.executePluginRequest>;
  loadBundle: ReactAction<typeof api.functions.obsidianPlugins.loadPluginBundle>;
  onNoteWrite: ((write: AppliedPluginNoteWrite) => void) | undefined;
  publish: (event: Omit<VaultEventMessage, "seq">) => void;
  reportCrash: (
    pluginId: string,
    bundleFingerprint: string,
    attempts: number,
    error: unknown,
  ) => Promise<void>;
  reportStatus: ReactMutation<typeof api.functions.obsidianPlugins.reportRuntimeStatus>;
  setRegistrations: Setter<Record<string, PluginRegistration[]>>;
  setStatusItems: Setter<Record<string, StatusItem[]>>;
  setModal: Setter<OpenModal | null>;
  setPickFailure: Setter<{ pluginId: string; reason: PluginWorkReason } | null>;
  setSettingsTabs: Setter<string[]>;
  setSettingsPane: Setter<OpenSettingsPane | null>;
  setTextModal: Setter<OpenTextModal | null>;
  setPending: Setter<Record<string, PendingCommand>>;
  setOutcomes: Setter<Record<string, CommandOutcome>>;
  setSandboxes: Setter<ActiveSandbox[]>;
  waiting: Ref<SuggestWaiting>;
  applying: Ref<ApplyWaiting>;
  previewing: Ref<PreviewWaiting>;
  modalWaiting: Ref<ModalWaiting>;
  lastAsked: Ref<number | null>;
  lastModalAsked: Ref<number | null>;
  lastPreviewAsked: Ref<number | null>;
  offeredBy: Ref<FrameOwner>;
  settingsOwner: Ref<FrameOwner>;
  textModalOwner: Ref<FrameOwner>;
  commandTimers: Ref<CommandTimers>;
}

/**
 * One message from one sandbox frame: the body of `useRuntime`'s `onEvent`,
 * moved verbatim. The hook keeps the `useCallback` and its dependency list;
 * the refs are read when a message arrives, as they always were — see
 * `settingsOwner` there for why that matters.
 */
export function handleSandboxEvent(
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
  }: SandboxEventContext,
  sandbox: ActiveSandbox,
  event: SandboxEvent,
): void {
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
    // A new dialog answers the old complaint: whatever did not land last
    // time, the reader has moved on and is being asked something else.
    if (event.open) setPickFailure(null);
    return;
  }
  if (event.type === "settings-tab") {
    setSettingsTabs((current) =>
      current.includes(pluginId) ? current : [...current, pluginId].sort(),
    );
    return;
  }
  if (event.type === "settings-pane") {
    /*
      Only from the frame this pane was asked of. Every other running plugin
      can post the same message, and a pane carries its plugin's name over
      somebody else's controls — the forgery #573 fixed for the suggestion
      dialog, which this would have reintroduced in a worse place: these rows
      are settings a reader is about to change.

      Read off the ref, never off state: see `settingsOwner` for the render
      that captured `settingsRequest` as `undefined` and dropped every pane
      the console ever asked for.
    */
    const owner = settingsOwner.current;
    if (owner === null) return;
    if (owner.pluginId !== pluginId || owner.nonce !== sandbox.nonce) return;
    if (!event.open) settingsOwner.current = null;
    setSettingsPane(
      event.open
        ? { pluginId, nonce: sandbox.nonce, rows: event.rows, error: event.error }
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

      WHICH IS WHY A DIALOG ALREADY OPEN ONLY TAKES MESSAGES FROM ITS OWNER.
      Every running frame can send this unprompted, so without the check below
      a second plugin could close somebody else's dialog — the reader's panel
      vanishing while the plugin that opened it is never told, since
      `dismissTextModal` addresses whoever owns the dialog *now* — or replace
      what a reader is part-way through reading, and take their Close with it.
      Neither is impersonation: `pluginId` comes from the sending frame, so
      the panel always names whose words are in it. It is the surface that was
      unowned. Same rule as `suggest-modal-results` below and the settings
      pane above; this handler was the one that stated it and did not check
      it.

      Nothing is open ⇒ anyone may open one, which is the documented edge: a
      plugin's own dialog is its to raise, and the panel says whose it is.
    */
    const owner = textModalOwner.current;
    if (owner !== null && (owner.pluginId !== pluginId || owner.nonce !== sandbox.nonce)) return;
    textModalOwner.current = event.open ? { pluginId, nonce: sandbox.nonce } : null;
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
    /*
      AND WHAT THE READER GETS INSTEAD OF SILENCE.

      A pick that could not be applied is the report this whole path was
      repaired for: the row was pressed, the dialog closed, the note did not
      change, and nothing anywhere said why. The guest names which of three
      cases it was and the console says it — see `pluginWorkNote`.
    */
    if (event.reason !== null) setPickFailure({ pluginId, reason: event.reason });
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
      [pluginId]: { id: event.id, ok: event.ok, error: event.error, reason: event.reason },
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
}
