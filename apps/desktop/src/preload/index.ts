/**
 * The whole surface a window has.
 *
 * Twelve functions and one subscription, frozen. There is no generic `invoke`, no
 * `require`, no filesystem, and — the one that matters — no way to read the
 * gateway credential. A renderer in this app displays state and sends verbs;
 * everything else happens in the main process.
 *
 * `contextIsolation` is on and `nodeIntegration` is off in both windows, so
 * this object is the only thing that crosses. That matters more than usual
 * here because these windows render window titles and calendar summaries,
 * which is text somebody else wrote.
 */

import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, COMMANDS } from "../main/ipc.ts";
import type { UiState } from "../main/ipc.ts";

const api = {
  onState(handler: (state: UiState) => void): void {
    ipcRenderer.on(CHANNELS.state, (_event, state: UiState) => handler(state));
  },
  accept: (episode: string): void => ipcRenderer.send(COMMANDS.accept, episode),
  record: (): void => ipcRenderer.send(COMMANDS.record),
  decline: (episode: string): void => ipcRenderer.send(COMMANDS.decline, episode),
  pause: (): void => ipcRenderer.send(COMMANDS.pause),
  resume: (): void => ipcRenderer.send(COMMANDS.resume),
  end: (): void => ipcRenderer.send(COMMANDS.end),
  notes: (markdown: string): void => ipcRenderer.send(COMMANDS.notes, markdown),
  title: (title: string): void => ipcRenderer.send(COMMANDS.title, title),
  setAskBeforeEveryMeeting: (value: boolean): void =>
    ipcRenderer.send(COMMANDS.setAskBeforeEveryMeeting, value),
  setBlocklist: (list: string[]): void => ipcRenderer.send(COMMANDS.setBlocklist, list),
  /*
    Connecting is a verb a window may send, and the credential is still not a
    thing a window may see: this starts the flow in the main process and the
    token never crosses back. There is no `getToken` here and there must not be.
  */
  connect: (): void => ipcRenderer.send(COMMANDS.connect),
  disconnect: (): void => ipcRenderer.send(COMMANDS.disconnect),
};

export type ContextApi = typeof api;

contextBridge.exposeInMainWorld("context", Object.freeze(api));
