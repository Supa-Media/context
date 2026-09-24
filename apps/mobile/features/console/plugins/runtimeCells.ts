import type { Dispatch, SetStateAction } from "react";
import type { LinkPreview } from "./sandboxTypes";

/*
  The shapes of the state and refs `useRuntime` owns, named so the plain
  functions it hands them to can be typed. Nothing here holds a value.
*/

export type Ref<T> = { current: T };
export type Setter<T> = Dispatch<SetStateAction<T>>;
type Timer = ReturnType<typeof setTimeout>;

/** A completion query waiting on a frame, by sequence number. */
export type SuggestWaiting = Map<number, {
  resolve: (items: { text: string }[]) => void;
  timer: Timer;
}>;
/** A picked completion waiting for the line it produced. */
export type ApplyWaiting = Map<number, {
  resolve: (line: string | null) => void;
  timer: Timer;
}>;
/** A dialog query waiting on the one frame that owns the dialog. */
export type ModalWaiting = Map<number, {
  resolve: (items: { text: string }[]) => void;
  timer: Timer;
  pluginId: string;
  nonce: string;
}>;
/** A link preview waiting on a frame. */
export type PreviewWaiting = Map<number, {
  resolve: (previews: LinkPreview[]) => void;
  timer: Timer;
}>;
/** The frame something belongs to: a plugin, and the load it is running as. */
export type FrameOwner = { pluginId: string; nonce: string } | null;
/** One command timer per plugin. */
export type CommandTimers = Map<string, Timer>;
