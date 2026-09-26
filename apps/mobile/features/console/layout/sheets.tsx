import type { Dispatch, SetStateAction } from "react";
import { checkoutOutcomeFrom } from "@context/shared";
import { inviteHref } from "../../auth/redirect";
import { Confirm } from "../files/Dialogs";
import { recentPaths, type HistoryState } from "../files/history";
import { NO_PENDING } from "../files/pendingMarks";
import { RecentSheet } from "../files/RecentSheet";
import { saveChip } from "../files/status";
import { SyncSheet } from "../files/SyncSheet";
import type { useTabs } from "../files/useTabs";
import { noteHref, settingsHref, type settingsFromQuery } from "../nav";
import { AgentSetupOverlay } from "../../agentSetup/AgentSetupOverlay";
import type { SetupAgent } from "../../agentSetup/guides";

import { SettingsOverlay } from "../settings/SettingsOverlay";
import { selectedContext, type ConsoleData } from "../types";
import type { ConsoleRouter } from "./types";

/*
  The sheets and dialogs the console layout mounts over the frame: Recent,
  sync, settings and the close-tab confirm. Each is a function returning the
  element (or `null`) rather than a component, so the children `AppFrame`
  receives are exactly the ones it received when these were inline.
*/

export function consoleRecentSheet({
  recentOpen,
  phone,
  somewhereToGo,
  history,
  data,
  setRecentOpen,
}: {
  recentOpen: boolean;
  phone: boolean;
  somewhereToGo: boolean;
  history: HistoryState;
  data: ConsoleData;
  setRecentOpen: Dispatch<SetStateAction<boolean>>;
}) {
  /*
    The Recent sheet, mounted only where there is a control that opens it.
    It closes itself when the list empties (see its effect), and the guard
    on `somewhereToGo` is what stops it re-opening onto a single row
    pointing at the note already on screen — a context switch clears the
    history from under it, and this component sits above the route that
    does that.

    `select` rather than `router`: the note is a selection this browser
    holds, the URL follows it through `useNoteAddress`, and asking the
    router to navigate instead remounts the route under the press. See
    `docs/decisions/app-and-console.md` on the breadcrumb root, which is
    the same press taking the same shortcut for the same reason.
  */
  return (
    recentOpen && phone && somewhereToGo ? (
      <RecentSheet
        paths={recentPaths(history)}
        currentPath={data.files.selectedPath}
        pendingStateFor={data.files.pending?.stateFor}
        onOpen={(path) => {
          data.files.select(path);
          setRecentOpen(false);
        }}
        onDismiss={() => setRecentOpen(false)}
      />
    ) : null
  );
}

export function consoleSyncSheet({
  syncOpen,
  browsing,
  data,
  setSyncOpen,
  closeSync,
}: {
  syncOpen: boolean;
  browsing: boolean;
  data: ConsoleData;
  setSyncOpen: Dispatch<SetStateAction<boolean>>;
  closeSync: () => void;
}) {
  /*
    The phone's sync sheet. `select` for the reason the Recent sheet
    above uses it — and opening a note is the whole answer the sheet
    offers: a waiting write is checked by looking at it, and a parked one
    is restored as a conflict the moment its note opens (`open` in
    `useFileBrowser`), which is where its three answers are.
  */
  /*
    Every layout, not only the phone's: on a pointer layout the strip's
    sync segments open it (`Status`), because a parked rename or delete
    is answered on this sheet's rows and nowhere else — marked and
    counted but unanswerable is a change stranded with no way to act on
    it.
  */
  return (
    syncOpen && browsing ? (
      <SyncSheet
        sync={data.files.sync}
        save={saveChip({ editor: data.files.editor, now: Date.now() })}
        pending={data.files.pending ?? NO_PENDING}
        onOpen={(path) => {
          data.files.select(path);
          setSyncOpen(false);
        }}
        onAnswer={data.files.answerOp}
        onDismiss={closeSync}
      />
    ) : null
  );
}

export function consoleSettings({
  openSettingsSection,
  data,
  checkoutReturn,
  router,
  requestSignOut,
}: {
  openSettingsSection: ReturnType<typeof settingsFromQuery>;
  data: ConsoleData;
  checkoutReturn: ReturnType<typeof checkoutOutcomeFrom>;
  router: ConsoleRouter;
  requestSignOut: () => void;
}) {
  /*
    Settings, over whatever is behind it rather than instead of it.
    Closing drops one query parameter, which is why there is no
    reconstruction of where somebody came from here: the note they had
    open is still in the URL and still on screen.
  */
  /*
    Drawn on every console route, not only a context's. The account
    sections are about the person and reachable from anywhere, and the
    list itself now switches contexts — so gating this on `route.kind`
    left `?settings=apps` on `/console/map` as a URL that changed nothing
    and drew nothing, and left the gear absent on exactly the routes with
    no other way in.
  */
  return (
    openSettingsSection === null ? null : (
      <SettingsOverlay
        data={data}
        section={openSettingsSection}
        /*
          What Stripe's return URL said, read here because this is where
          every other query parameter this console acts on is read. It is a
          different fact from "the plan is active" — the webhook that
          decides that may not have landed yet — and Premium is the only
          panel that has anything to say about the gap.
        */
        returned={checkoutReturn}
        onSelect={(next) => router.setParams({ settings: next })}
        /*
          A context switch inside settings is a navigation, because the
          context a console is showing is a route rather than component
          state — the same `settingsHref` the storage chip pushes, carrying
          the open section so switching does not also change the subject.
        */
        onSwitchContext={(slug) => router.push(settingsHref(slug, openSettingsSection))}
        onSignOut={requestSignOut}
        onOpenInvitation={(token) => router.push(inviteHref(token))}
        /*
          Claude and ChatGPT open the full screen guide rather than their row's
          panel. Settings stays underneath, so closing the guide lands back
          on the page the button was on.
        */
        onConnectAgent={
          agentSetupAvailable(data) ? (agent) => router.setParams({ connect: agent }) : undefined
        }
        onDismiss={() => router.setParams({ settings: undefined })}
      />
    )
  );
}

export function consoleCloseTabConfirm({
  closingTab,
  tabs,
  setClosingTab,
}: {
  closingTab: string | null;
  tabs: ReturnType<typeof useTabs>;
  setClosingTab: Dispatch<SetStateAction<string | null>>;
}) {
  return (
    closingTab === null ? null : (
      <Confirm
        title="Close without settling this?"
        body={`${closingTab} has changes your bucket has not accepted — somebody else wrote it while you had it open, or the save failed. Autosave will not decide that for you, and closing this tab leaves it undecided. What you typed is not in your bucket.`}
        confirmLabel="Close anyway"
        onCancel={() => setClosingTab(null)}
        onConfirm={() => {
          tabs.close(closingTab);
          setClosingTab(null);
        }}
      />
    )
  );
}

/**
 * `?connect=claude|chatgpt` — the guided setup, over the workspace it connects.
 *
 * A parameter beside `?note=` for settings' reason: the note stays open under
 * it, and closing drops one parameter. Only inside a context and never in the
 * demo, which has no control plane to hold a grant; anywhere else the
 * parameter draws nothing, as an unknown `?settings=` does.
 *
 * Not for the owner of a shared workspace: `listGrants` shows an owner every
 * member's grants, so a teammate's Claude would read as this person signing
 * in. Everywhere the guide is offered — a personal workspace's owner, a
 * member of somebody else's — the grants listed are the viewer's own.
 */
/** Whether `consoleAgentSetup` would draw anything for this console. */
export function agentSetupAvailable(data: ConsoleData): boolean {
  const current = selectedContext(data);
  if (current === null || data.demo === true) return false;
  return current.kind === "personal" || current.role !== "owner";
}

export function consoleAgentSetup({
  connectAgent,
  data,
  router,
}: {
  connectAgent: SetupAgent | null;
  data: ConsoleData;
  router: ConsoleRouter;
}) {
  const current = selectedContext(data);
  if (connectAgent === null || current === null || !agentSetupAvailable(data)) return null;
  const slug = current.slug;
  return (
    <AgentSetupOverlay
      key={`${current.id}:${connectAgent}`}
      workspaceId={current.id}
      slug={slug}
      agent={connectAgent}
      onClose={() => router.setParams({ connect: undefined })}
      onSwitchAgent={(agent) => router.setParams({ connect: agent })}
      onOpenNote={(path) => router.push(noteHref(slug, path))}
    />
  );
}
