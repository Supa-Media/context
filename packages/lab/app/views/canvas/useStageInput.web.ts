/**
 * Everything the canvas does with a pointer, a wheel and the keyboard, ported from the artifact's stage listeners
 * (its lines 702-738): a double tap focuses a step; a drag on empty canvas (or with the hand tool, or space held)
 * pans; a drag from a port, or from a step with the connect tool, draws a wire; a drag on a step moves it, snapped
 * to 10, copying main first; a click selects; the wheel pans and ctrl/⌘-wheel zooms; V, C and H pick the tool,
 * Delete removes the selection, Escape goes up one level of focus or clears it, ctrl/⌘Z undoes. Ctrl/⌘S is the shell's.
 * An open group is a graph like the whole one (move, wire, delete, pick); its ⤢ cards open (`data-gopen`) and its pills
 * go to the thing outside (`data-gport`): a group opens, a step is picked on the whole graph.
 * The test chat's line (`lineDecor.ts`, `data-line`, no `data-id`) is only ever picked: never moved, wired or focused.
 * Several steps can be picked (Dev, 2026-11-27, `engine/picks.ts`): Shift or ⌘/Ctrl click toggles one, a Shift drag on
 * empty canvas draws a box (a plain drag still pans), Esc clears, Delete removes them all, dragging one moves them all,
 * and ⌥⌘K (Ctrl+Alt+K) opens Make component.
 */
import { useEffect, type RefObject } from "react";
import {
  deleteSteps,
  delSel,
  edit,
  emit,
  focusOn,
  forkFromMain,
  G,
  isMain,
  lab,
  markDirty,
  moveNode,
  node,
  pushUndo,
  set,
  toast,
  undo,
  focusUp,
  unfocus,
} from "../../engine/state";
import { mods } from "../../engine/modules";
import { isGroupFocus } from "../../engine/groups";
import { groupsOf } from "../../data/graph";
import { startNodeCase } from "../../engine/caseDraft";
import { H, W, wheelCam, type Cam } from "./render";
import { addPicks, canPickSeveral, clearPicks, inBox, togglePick } from "../../engine/picks";
import { whyNot } from "../../engine/makeComponent";
import { isMakeKey } from "./MultiBar.web";

type Act =
  | { k: "pan"; sx: number; sy: number; cx: number; cy: number; moved: boolean }
  /** A Shift drag on empty canvas: the box from where it started (screen), picking what it touches on release. */
  | { k: "box"; sx: number; sy: number; moved: boolean }
  | { k: "wire"; from: string }
  | {
      k: "move";
      id: string;
      dx: number;
      dy: number;
      moved: boolean;
      before: string;
      /** Down on the step's dashed "+" chip: a click opens its add-case form (Dev2, 2026-11-15). */
      addCase?: boolean;
      /** Shift or ⌘/Ctrl held: a click adds the step to the picks or takes it out. */
      toggle?: boolean;
      /** The other picked steps, moved with it: each one's place from the step dragged. */
      with?: Array<{ id: string; ox: number; oy: number }>;
    }
  | { k: "edge"; i: number }
  | { k: "fblk"; mod?: string; go?: string }
  | { k: "gport"; to: string }
  | { k: "fpick"; id: string }
  | { k: "line"; id: string };

/** The canvas draws another graph than the version open (a real text's, as it ran): nothing on it can be changed. */
let readOnly = false;
export function setCanvasReadOnly(v: boolean) {
  readOnly = v;
}

export function useStageInput({
  stage,
  cam,
  applyCam,
  closeAddMenu,
}: {
  stage: RefObject<HTMLDivElement | null>;
  cam: RefObject<Cam>;
  applyCam: () => void;
  closeAddMenu: () => void;
}) {
  useEffect(() => {
    const st = stage.current;
    if (!st) return;
    let act: Act | null = null;
    let space = false;
    let lastTap: { id: string | null; at: number } = { id: null, at: 0 };
    const panClass = () => st.classList.toggle("pan", lab.tool === "pan");
    // The Shift-drag box, drawn over the stage while it is dragged.
    const boxEl = document.createElement("div");
    boxEl.className = "mbox";
    boxEl.hidden = true;
    st.appendChild(boxEl);
    const several = () => !readOnly && canPickSeveral();
    const openViewer = (k: string) => {
      if (mods(G())[k]) set({ viewer: { kind: "module", key: k } });
    };

    const tap = (e: PointerEvent) => {
      const t = e.target as Element;
      const g = t.closest?.(".nd[data-id]") as SVGGElement | null;
      // A Shift or ⌘/Ctrl click picks several; two of them quickly never focus a step.
      if (!g || t.closest(".port") || e.shiftKey || e.metaKey || e.ctrlKey) {
        lastTap = { id: null, at: 0 };
        return;
      }
      const now = performance.now();
      const id = g.dataset.id!;
      if (lastTap.id === id && now - lastTap.at < 400) {
        lastTap = { id: null, at: 0 };
        e.stopPropagation();
        e.preventDefault();
        setTimeout(() => focusOn(id), 0);
        return;
      }
      lastTap = { id, at: now };
    };
    const toWorld = (e: PointerEvent) => {
      const r = st.getBoundingClientRect();
      const c = cam.current!;
      return {
        x: (e.clientX - r.left - c.x) / c.k,
        y: (e.clientY - r.top - c.y) / c.k,
      };
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const p = toWorld(e);
      const t = e.target as Element;
      const port = t.closest("[data-port]") as HTMLElement | null;
      const nd = t.closest(".nd[data-id]") as HTMLElement | null;
      const ln = t.closest("[data-line]") as HTMLElement | null;
      const hit = t.closest("[data-edge]") as HTMLElement | null;
      closeAddMenu();
      try {
        st.setPointerCapture(e.pointerId);
      } catch {
        /* a synthetic pointer has no capture */
      }
      const gopen = t.closest("[data-gopen]") as HTMLElement | null;
      if (gopen) {
        act = { k: "fblk", go: gopen.dataset.gopen };
        return;
      }
      const gport = t.closest("[data-gport]") as HTMLElement | null;
      if (gport) {
        act = { k: "gport", to: gport.dataset.gport! };
        return;
      }
      // An open group is drawn and handled as a graph; only a step's own view picks and refocuses on a click.
      if (lab.cfocus && !isGroupFocus(G(), lab.cfocus, groupsOf(G()))) {
        const fm = t.closest("[data-fmod],[data-fgo]") as HTMLElement | null;
        if (fm) {
          act = { k: "fblk", mod: fm.dataset.fmod, go: fm.dataset.fgo };
          return;
        }
        if (nd) {
          act = { k: "fpick", id: nd.dataset.id! };
          return;
        }
      }
      if (ln && lab.tool !== "pan" && !space) {
        act = { k: "line", id: ln.dataset.line! };
        return;
      }
      if (e.shiftKey && lab.tool !== "pan" && !space && !nd && !hit && !port && several()) {
        act = { k: "box", sx: e.clientX, sy: e.clientY, moved: false };
        return;
      }
      if (lab.tool === "pan" || space || (!nd && !hit && !port)) {
        const c = cam.current!;
        act = {
          k: "pan",
          sx: e.clientX,
          sy: e.clientY,
          cx: c.x,
          cy: c.y,
          moved: false,
        };
        st.classList.add("pan");
        return;
      }
      // A real text's run draws the graph Tex had then, read only: no wiring, moving or deleting, only picking a step.
      if (!readOnly && (port || (lab.tool === "con" && nd))) {
        act = { k: "wire", from: port ? port.dataset.port! : nd!.dataset.id! };
        return;
      }
      if (nd) {
        const n = node(nd.dataset.id!)!;
        const toggle = (e.shiftKey || e.metaKey || e.ctrlKey) && several();
        // One of several picked: they all move with it.
        const others = lab.picks.length >= 2 && lab.picks.includes(n.id) && several() ? lab.picks.filter((id) => id !== n.id) : [];
        act = {
          k: "move",
          id: n.id,
          dx: p.x - n.x,
          dy: p.y - n.y,
          moved: false,
          before: JSON.stringify(G()),
          addCase: !!t.closest("[data-addcase]"),
          toggle,
          with: others.flatMap((id) => {
            const o = node(id);
            return o ? [{ id, ox: o.x - n.x, oy: o.y - n.y }] : [];
          }),
        };
        return;
      }
      if (hit) act = { k: "edge", i: +hit.dataset.edge! };
    };
    const move = (e: PointerEvent) => {
      if (!act) return;
      const p = toWorld(e);
      if (act.k === "pan") {
        const c = cam.current!;
        c.x = act.cx + e.clientX - act.sx;
        c.y = act.cy + e.clientY - act.sy;
        if (Math.abs(e.clientX - act.sx) + Math.abs(e.clientY - act.sy) > 3)
          act.moved = true;
        applyCam();
      } else if (act.k === "move" && !readOnly) {
        const n = node(act.id);
        if (!n) return;
        const nx = Math.round((p.x - act.dx) / 10) * 10;
        const ny = Math.round((p.y - act.dy) / 10) * 10;
        if (nx !== n.x || ny !== n.y) {
          if (!act.moved && isMain()) {
            forkFromMain();
            act.before = JSON.stringify(G());
          }
          act.moved = true;
          for (const o of act.with ?? []) {
            const m = node(o.id);
            if (m) {
              m.x = nx + o.ox;
              m.y = ny + o.oy;
            }
          }
          moveNode(act.id, nx, ny);
        }
      } else if (act.k === "box") {
        const r = st.getBoundingClientRect();
        if (Math.abs(e.clientX - act.sx) + Math.abs(e.clientY - act.sy) > 3) act.moved = true;
        boxEl.hidden = !act.moved;
        boxEl.style.left = Math.min(act.sx, e.clientX) - r.left + "px";
        boxEl.style.top = Math.min(act.sy, e.clientY) - r.top + "px";
        boxEl.style.width = Math.abs(e.clientX - act.sx) + "px";
        boxEl.style.height = Math.abs(e.clientY - act.sy) + "px";
      } else if (act.k === "wire") {
        const a = node(act.from);
        if (a)
          st.querySelector("#ghost")?.setAttribute(
            "d",
            `M${a.x + W},${a.y + H / 2} L${p.x},${p.y}`,
          );
      }
    };
    const up = (e: PointerEvent) => {
      if (!act) return;
      const a = act;
      act = null;
      panClass();
      if (a.k === "fblk") {
        if (a.mod) openViewer(a.mod);
        else if (a.go) focusOn(a.go);
        return;
      }
      if (a.k === "gport") {
        // A group opens; a step outside is picked on the whole graph.
        if (G().folded?.[a.to] || groupsOf(G())[a.to]) focusOn(a.to);
        else {
          unfocus();
          set({ sel: { t: "node", id: a.to }, pin: true });
        }
        return;
      }
      if (a.k === "line") {
        set({ sel: { t: "node", id: a.id }, addCtxOpen: false, pin: true });
        return;
      }
      if (a.k === "fpick") {
        if (a.id !== lab.cfocus) focusOn(a.id);
        else set({ sel: { t: "node", id: a.id }, pin: true });
        return;
      }
      if (a.k === "box") {
        boxEl.hidden = true;
        if (!a.moved) return;
        // What the box touches, as drawn: every step and group card on the canvas (the test chat's line has no data-id).
        const rects = [...st.querySelectorAll<SVGGraphicsElement>(".nd[data-id]")].map((el) => {
          const b = el.getBoundingClientRect();
          return { id: el.dataset.id!, x: b.left, y: b.top, w: b.width, h: b.height };
        });
        const ids = inBox(rects, { x0: a.sx, y0: a.sy, x1: e.clientX, y1: e.clientY });
        if (ids.length) addPicks(ids);
        return;
      }
      if (a.k === "pan") {
        if (!a.moved && lab.picks.length) clearPicks();
        else if (!a.moved && lab.sel && !lab.cfocus)
          set({ sel: null, addCtxOpen: false });
        return;
      }
      if (a.k === "move") {
        if (a.moved) {
          pushUndo(a.before);
          markDirty();
        } else if (a.toggle) {
          togglePick(a.id);
        } else {
          set({ sel: { t: "node", id: a.id }, picks: [], makeOpen: false, addCtxOpen: false, pin: true });
          if (a.addCase && !readOnly) startNodeCase(a.id);
        }
        return;
      }
      if (a.k === "edge") {
        set({ sel: { t: "edge", i: a.i } });
        return;
      }
      if (a.k === "wire") {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const to = el?.closest?.(".nd[data-id]") as HTMLElement | null;
        st.querySelector("#ghost")?.setAttribute("d", "");
        if (to && to.dataset.id !== a.from) {
          const tid = to.dataset.id!;
          const fid = a.from;
          edit(() => {
            G().edges.push({ from: fid, to: tid, mode: "wait", when: ["*"] });
            lab.sel = { t: "edge", i: G().edges.length - 1 };
          });
          toast("Wired. Pick its kind on the right.");
        } else if (!to) set({ sel: { t: "node", id: a.from } });
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      cam.current = wheelCam(cam.current!, e, st.getBoundingClientRect());
      applyCam();
    };
    const keydown = (e: KeyboardEvent) => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(
        document.activeElement?.tagName || "",
      );
      // Esc clears several picks first; the next Esc goes up a level as before.
      if (e.key === "Escape" && !typing && lab.view === "canvas" && !lab.viewer && lab.picks.length) {
        clearPicks();
        return;
      }
      if (
        e.key === "Escape" &&
        lab.cfocus &&
        lab.view === "canvas" &&
        !typing &&
        !lab.viewer
      ) {
        focusUp();
        return;
      }
      if (typing || lab.view !== "canvas" || readOnly) return;
      if (e.key === " ") {
        space = true;
        st.classList.add("pan");
        e.preventDefault();
      }
      const k = e.key.toLowerCase();
      if (isMakeKey(e)) {
        e.preventDefault();
        if (lab.picks.length >= 2 && several() && !whyNot(lab.picks)) set({ makeOpen: true });
        return;
      }
      if (!e.metaKey && !e.ctrlKey) {
        if (k === "v") set({ tool: "sel" });
        if (k === "c") set({ tool: "con" });
        if (k === "h") set({ tool: "pan" });
      }
      if ((e.key === "Delete" || e.key === "Backspace") && lab.picks.length >= 2 && several()) {
        e.preventDefault();
        deleteSteps(lab.picks);
        return;
      }
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        lab.sel &&
        (!lab.cfocus || isGroupFocus(G(), lab.cfocus, groupsOf(G())))
      ) {
        e.preventDefault();
        delSel();
      }
      if (e.key === "Escape") {
        lab.sel = null;
        closeAddMenu();
        emit();
      }
      if ((e.metaKey || e.ctrlKey) && k === "z") {
        e.preventDefault();
        undo();
      }
    };
    const keyup = (e: KeyboardEvent) => {
      if (e.key === " ") {
        space = false;
        panClass();
      }
    };
    st.addEventListener("pointerdown", tap, true);
    st.addEventListener("pointerdown", down);
    st.addEventListener("pointermove", move);
    st.addEventListener("pointerup", up);
    st.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    return () => {
      st.removeEventListener("pointerdown", tap, true);
      st.removeEventListener("pointerdown", down);
      st.removeEventListener("pointermove", move);
      st.removeEventListener("pointerup", up);
      st.removeEventListener("wheel", wheel);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      boxEl.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
