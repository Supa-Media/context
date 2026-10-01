import { useEffect, useRef, useState } from "react";
import type { ViewStyle } from "react-native";
import type { CastShown } from "@context/shared";

/*
  A scene's two apps on a phone (Dev2, 2026-09-30): both at once, Context
  above the chat, or one at a time, switching the way an iPhone does: the app
  shrinks into a card, the next card slides across, and it grows to fill.

  When the page is the cast studio's stage it is being recorded for Reels, so
  everything that matters sits inside Instagram's safe zone ("you have to redo
  the design to make sure the main content shows up in the safe zone"):
  nothing under the top bar, the caption, or the like and share buttons down
  the right edge. Everything outside it is plain desk.
*/

/** Instagram's Reels safe zone on a 1080×1920 frame, with a little room inside it. */
const REELS = { top: 250, bottom: 420, left: 70, right: 55, buttons: 193, width: 1080, height: 1920 } as const;
const ROOM = 22;
const pctX = (px: number): Pct => `${((px + ROOM) / REELS.width) * 100}%`;
const pctY = (px: number): Pct => `${((px + ROOM) / REELS.height) * 100}%`;

export type PhonePane = "context" | "chat";
export type PhoneView = "both" | PhonePane;

type Pct = `${number}%`;
export interface PaneBox {
  top: Pct;
  bottom: Pct;
  left: Pct;
  right: Pct;
}

/** What a phone shows, as panes: an assistant's name is its chat. */
export function phoneView(shows: CastShown | undefined): PhoneView {
  if (shows === undefined || shows === "both") return "both";
  return shows === "context" ? "context" : "chat";
}

/**
 * Where each app sits. In the safe zone, split puts Context in the full-width
 * band above where the buttons start and the chat, narrower, beside them;
 * one app is the narrower box, top to bottom, so no part of it is under a
 * button. Anywhere else the desk only leaves a margin.
 */
export function phoneBoxes(view: PhoneView, safe: boolean): Record<PhonePane, PaneBox> {
  if (!safe) {
    const whole: PaneBox = { top: "2%", bottom: "2%", left: "3%", right: "3%" };
    if (view !== "both") return { context: whole, chat: whole };
    return { context: { ...whole, bottom: "47%" }, chat: { ...whole, top: "54%" } };
  }
  const narrow: PaneBox = { top: pctY(REELS.top), bottom: pctY(REELS.bottom), left: pctX(REELS.left), right: pctX(REELS.buttons) };
  if (view !== "both") return { context: narrow, chat: narrow };
  // Context ends halfway down, above where the buttons start (58%).
  return {
    context: { top: narrow.top, bottom: "50%", left: narrow.left, right: pctX(REELS.right) },
    chat: { ...narrow, top: "51.5%" },
  };
}

/** The switch between two apps, one step at a time. */
export type PhoneSwitch = { phase: "rest" } | { phase: "lift" | "slide" | "land"; from: PhonePane; to: PhonePane };

/** How long each part of a switch takes: shrink, slide across, grow. */
export const SWITCH_MS = { lift: 260, slide: 360, land: 280 } as const;
const CARD = 0.72;
const EASE = "cubic-bezier(0.2, 0, 0, 1)";

/**
 * A pane's transform: at rest the shown app is where its box is and the other
 * waits off the side; during a switch both are cards, a card's width apart.
 */
export function paneMotion(pane: PhonePane, view: PhoneView, move: PhoneSwitch, travel: number): ViewStyle {
  const card = Math.round(travel * CARD * 0.92);
  const away = pane === "context" ? -1 : 1;
  const style = (x: number, scale: number, shown: boolean, ms: number): ViewStyle =>
    ({
      transform: `translateX(${x}px) scale(${scale})`,
      opacity: shown ? 1 : 0,
      zIndex: shown ? 1 : 0,
      transition: `transform ${ms}ms ${EASE}, opacity ${ms}ms ${EASE}, top ${ms}ms ${EASE}, bottom ${ms}ms ${EASE}, left ${ms}ms ${EASE}, right ${ms}ms ${EASE}`,
    }) as unknown as ViewStyle;
  if (move.phase === "rest") {
    const shown = view === "both" || view === pane;
    return style(shown ? 0 : away * travel, 1, shown, SWITCH_MS.land);
  }
  const dir = move.to === "chat" ? 1 : -1;
  const isTo = pane === move.to;
  if (move.phase === "lift") return style(isTo ? dir * card : 0, CARD, true, SWITCH_MS.lift);
  if (move.phase === "slide") return style(isTo ? 0 : -dir * card, CARD, true, SWITCH_MS.slide);
  return isTo ? style(0, 1, true, SWITCH_MS.land) : style(-dir * travel, CARD, false, SWITCH_MS.land);
}

/**
 * The switch that plays when a phone goes from one app to the other, and
 * nothing when it goes to or from both, which only eases the boxes. Reduced
 * motion cuts straight across.
 */
export function usePhoneSwitch(view: PhoneView, reduced: boolean): PhoneSwitch {
  const [move, setMove] = useState<PhoneSwitch>({ phase: "rest" });
  const last = useRef(view);
  useEffect(() => {
    const from = last.current;
    last.current = view;
    if (reduced || from === view || from === "both" || view === "both") return setMove({ phase: "rest" });
    const timers: ReturnType<typeof setTimeout>[] = [];
    setMove({ phase: "lift", from, to: view });
    timers.push(setTimeout(() => setMove({ phase: "slide", from, to: view }), SWITCH_MS.lift));
    timers.push(setTimeout(() => setMove({ phase: "land", from, to: view }), SWITCH_MS.lift + SWITCH_MS.slide));
    timers.push(setTimeout(() => setMove({ phase: "rest" }), SWITCH_MS.lift + SWITCH_MS.slide + SWITCH_MS.land));
    return () => timers.forEach(clearTimeout);
  }, [view, reduced]);
  return move;
}

/**
 * The app drawn smaller inside its window: laid out at `1 / scale` of the
 * window's size and scaled back down, so a phone's page (its title, its
 * folders, its List) fits a window a third of the screen tall, the way the
 * artboards drew it, instead of showing only its first heading.
 */
export function paneZoom(scale: number): ViewStyle {
  if (scale === 1) return { flex: 1, minHeight: 0 };
  return {
    position: "absolute",
    top: 0,
    left: 0,
    width: `${100 / scale}%`,
    height: `${100 / scale}%`,
    transform: `scale(${scale})`,
    transformOrigin: "top left",
  } as unknown as ViewStyle;
}

/** How much smaller each app is drawn on a phone's desk. */
export const PANE_SCALE: Record<PhonePane, number> = { context: 0.7, chat: 0.8 };
