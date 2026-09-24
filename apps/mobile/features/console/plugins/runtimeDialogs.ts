import {
  SUGGEST_TIMEOUT_MS,
  type ActiveSandbox,
  type OpenModal,
  type OpenSettingsPane,
  type OpenTextModal,
} from "./runtime";
import type { FrameOwner, ModalWaiting, Ref, Setter } from "./runtimeCells";

/*
  The dialogs and the settings pane `useRuntime` puts in front of a reader on
  a plugin's behalf. Each is the body of one of that hook's `useCallback`s,
  moved verbatim with its comment; the hook keeps the callback and its
  dependency list, and hands in what the body reads from the render.
*/

type Addressed = { seq: number; pluginId: string; nonce: string };

/*
  Ask the open dialog what to show. One frame, not a walk: the dialog already
  belongs to whoever opened it, so there is nobody else to ask.
*/
export async function askDialogSuggestions(
  {
    isOwner,
    modal,
    modalSeq,
    lastModalAsked,
    modalWaiting,
    setModalQuery,
  }: {
    isOwner: boolean;
    modal: OpenModal | null;
    modalSeq: Ref<number>;
    lastModalAsked: Ref<number | null>;
    modalWaiting: Ref<ModalWaiting>;
    setModalQuery: Setter<(Addressed & { query: string }) | undefined>;
  },
  query: string,
): Promise<{ text: string }[]> {
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
}

/*
  Same rule as `dismissModal`: the dialog goes now and the guest is told.
  A reader closing a dialog must not be waiting on the plugin that opened it.
*/
export function closeTextDialog({
  textModal,
  modalSeq,
  textModalOwner,
  setTextModalDismiss,
  setTextModal,
}: {
  textModal: OpenTextModal | null;
  modalSeq: Ref<number>;
  textModalOwner: Ref<FrameOwner>;
  setTextModalDismiss: Setter<Addressed | undefined>;
  setTextModal: Setter<OpenTextModal | null>;
}): void {
  if (textModal === null) return;
  modalSeq.current += 1;
  setTextModalDismiss({
    seq: modalSeq.current,
    pluginId: textModal.pluginId,
    nonce: textModal.nonce,
  });
  // Released here as well as in the handler: a reader closing the dialog ends
  // the owner's claim on it, or the next plugin to open one would be refused
  // by a frame that no longer has anything on screen.
  textModalOwner.current = null;
  setTextModal(null);
}

/*
  Ask one plugin to draw its pane.

  Addressed to the frame running that plugin now, and the answer replaces
  whatever pane was open: one pane at a time, like the dialogs, because it is
  one surface in front of the reader. The pane arrives as an event rather than
  a return value — `display()` may fetch, and it may redraw itself afterwards.
*/
export function requestSettingsPane(
  {
    sandboxes,
    modalSeq,
    settingsOwner,
    setSettingsPane,
    setSettingsRequest,
  }: {
    sandboxes: ActiveSandbox[];
    modalSeq: Ref<number>;
    settingsOwner: Ref<FrameOwner>;
    setSettingsPane: Setter<OpenSettingsPane | null>;
    setSettingsRequest: Setter<(Addressed & { open: boolean }) | undefined>;
  },
  pluginId: string,
): void {
  const frame = sandboxes.find((one) => one.bundle.pluginId === pluginId);
  if (frame === undefined) return;
  modalSeq.current += 1;
  setSettingsPane(null);
  // Recorded before the request goes out: the answer can arrive in the same
  // tick the frame is told, and a claim written after it would be a window
  // in which the pane Context asked for is dropped as unasked-for.
  settingsOwner.current = { pluginId, nonce: frame.nonce };
  setSettingsRequest({
    seq: modalSeq.current,
    pluginId,
    nonce: frame.nonce,
    open: true,
  });
}

/*
  Closed here first and told to the guest after, the rule both dialogs keep:
  a reader leaving a pane must not be waiting on the plugin that drew it.
*/
export function closeOpenSettingsPane({
  settingsPane,
  modalSeq,
  settingsOwner,
  setSettingsPane,
  setSettingsRequest,
}: {
  settingsPane: OpenSettingsPane | null;
  modalSeq: Ref<number>;
  settingsOwner: Ref<FrameOwner>;
  setSettingsPane: Setter<OpenSettingsPane | null>;
  setSettingsRequest: Setter<(Addressed & { open: boolean }) | undefined>;
}): void {
  if (settingsPane === null) return;
  modalSeq.current += 1;
  setSettingsRequest({
    seq: modalSeq.current,
    pluginId: settingsPane.pluginId,
    nonce: settingsPane.nonce,
    open: false,
  });
  /*
    The claim is released here as well as the pane. The guest's own observer
    fires as its pane comes down, so a console that still held the claim
    would take that redraw for a pane to put back in front of somebody who
    has just dismissed it.
  */
  settingsOwner.current = null;
  setSettingsPane(null);
}
