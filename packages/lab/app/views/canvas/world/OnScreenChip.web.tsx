/**
 * The in-app test chat's On screen chip (in-app tests artboard 04): an in-app chat has one person, so the Texting as
 * row holds what the app has open instead. Set, it reads `[▭] On screen: @supa · plans/q3.md +2 tabs ✕` (✕ is Nothing
 * open); empty, it is a dashed `+ Nothing open`. A tap opens the same popover as a Testing row's (`OnScreen.web.tsx`),
 * above the chip. The value stays after a send: sending a text in the app does not close the note.
 */
import { setSandboxScreen, useSandbox } from "../../../engine/sandbox";
import { ChipFace, OnScreenPop, tabsWord, useOnScreenPop } from "../../testing/OnScreen.web";

export function OnScreenChip() {
  const sb = useSandbox();
  const pop = useOnScreenPop();
  const screen = sb.screen;
  return (
    <>
      {screen ? (
        <span className="osc" id="sbOnScreen" role="button" tabIndex={0} title="Tap to change" aria-haspopup="dialog" aria-expanded={!!pop.anchor} onClick={pop.open} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), (e.currentTarget as HTMLElement).click())}>
          <ChipFace screen={screen} caret={false} tabs={tabsWord} />
          <button
            type="button"
            className="rm"
            id="sbOnScreenX"
            aria-label="Nothing open"
            title="Nothing open"
            onClick={(e) => {
              e.stopPropagation();
              pop.close();
              setSandboxScreen(null);
            }}
          >
            ✕
          </button>
        </span>
      ) : (
        <button type="button" className="osc empty" id="sbOnScreen" aria-haspopup="dialog" aria-expanded={!!pop.anchor} onClick={pop.open}>
          + Nothing open
        </button>
      )}
      {pop.anchor ? <OnScreenPop anchor={pop.anchor} up value={screen} sub="with your next text" onClose={pop.close} onChange={setSandboxScreen} /> : null}
    </>
  );
}
