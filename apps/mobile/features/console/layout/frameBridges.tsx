import { useCallback, useEffect, type ReactNode } from "react";
import { useFrame } from "../../app/AppFrame";
import { asideToggleFor } from "../../app/frame";

/**
 * Open the right panel when somebody above the frame asks.
 *
 * A component with no output, for `PaletteWithAsk`'s reason: `useFrame` only
 * answers inside `AppFrame`, and the console layout is above it. The counter
 * is the event — see where it is held — and `toggleAside` is a no-op at a
 * density with no panel, so a phone's menu row being absent and this doing
 * nothing are the same guard read from two sides.
 */
export function OpenAsideOn({ at }: { at: number | null }) {
  const frame = useFrame();
  const open = frame.state.asideOpen;
  const toggle = frame.toggleAside;
  useEffect(() => {
    if (at === null || open) return;
    toggle();
    // `open` is deliberately absent: it changes as a *result* of this, and
    // listing it would make the effect re-run on its own outcome.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, toggle]);
  return null;
}

/**
 * The palette, with a way to reach the right panel.
 *
 * A component and not three lines in the layout, because opening the panel is
 * the frame's command and `useFrame` only answers *inside* `AppFrame` — and
 * the layout is above it. `Shortcuts` below exists for the same reason.
 *
 * `render` takes what the palette needs rather than this rendering it, so the
 * palette's own long prop list stays where a reader of the layout can see it.
 * `askable` is false where there is no panel for an answer to land in, and the
 * row is then absent rather than inert: `onAsk` being undefined is what
 * `askItem` reads.
 */
export function PaletteWithAsk({
  onAsked,
  render,
}: {
  onAsked: (query: string) => void;
  render: (onAskAgent: (query: string) => void, askable: boolean) => ReactNode;
}) {
  const frame = useFrame();
  /*
    Whether there is a panel to answer in. `Regions.aside` is `hidden` at every
    compact state, and `asideToggleFor` is what decides that — asked here
    rather than re-derived from a width, for the reason that function exists.
  */
  const askable = asideToggleFor(frame.density) !== null;

  const onAskAgent = useCallback(
    (query: string) => {
      // Opened before the question is handed over, so the panel is mounted to
      // receive it. A no-op where `askable` is false, which is the same guard
      // from the other side.
      if (!frame.state.asideOpen) frame.toggleAside();
      onAsked(query);
    },
    [frame, onAsked],
  );

  return <>{render(onAskAgent, askable)}</>;
}
