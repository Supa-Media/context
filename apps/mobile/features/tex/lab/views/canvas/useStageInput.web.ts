/**
 * Everything the canvas does with a pointer, a wheel and the keyboard, ported from the artifact's stage listeners
 * (its lines 702-738): a double tap focuses a step; a drag on empty canvas (or with the hand tool, or space held)
 * pans; a drag from a port, or from a step with the connect tool, draws a wire; a drag on a step moves it, snapped
 * to 10, copying main first; a click selects; the wheel pans and ctrl/⌘-wheel zooms; V, C and H pick the tool,
 * Delete removes the selection, Escape leaves focus or clears it, ctrl/⌘Z undoes. Ctrl/⌘S is the shell's.
 */
import { useEffect, type RefObject } from "react";
import {
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
  unfocus,
} from "../../engine/state";
import { mods } from "../../engine/modules";
import { H, W, wheelCam, type Cam } from "./render";

type Act =
  | { k: "pan"; sx: number; sy: number; cx: number; cy: number; moved: boolean }
  | { k: "wire"; from: string }
  | {
      k: "move";
      id: string;
      dx: number;
      dy: number;
      moved: boolean;
      before: string;
    }
  | { k: "edge"; i: number }
  | { k: "fblk"; mod?: string; go?: string }
  | { k: "fpick"; id: string };

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
    const openViewer = (k: string) => {
      if (mods(G())[k]) set({ viewer: { kind: "module", key: k } });
    };

    const tap = (e: PointerEvent) => {
      const t = e.target as Element;
      const g = t.closest?.(".nd") as SVGGElement | null;
      if (!g || t.closest(".port")) {
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
      const nd = t.closest(".nd") as HTMLElement | null;
      const hit = t.closest("[data-edge]") as HTMLElement | null;
      closeAddMenu();
      try {
        st.setPointerCapture(e.pointerId);
      } catch {
        /* a synthetic pointer has no capture */
      }
      if (lab.cfocus) {
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
      // Replay is read only: no wiring, moving or deleting, only picking a step to see what it did.
      if (lab.mode !== "replay" && (port || (lab.tool === "con" && nd))) {
        act = { k: "wire", from: port ? port.dataset.port! : nd!.dataset.id! };
        return;
      }
      if (nd) {
        const n = node(nd.dataset.id!)!;
        act = {
          k: "move",
          id: n.id,
          dx: p.x - n.x,
          dy: p.y - n.y,
          moved: false,
          before: JSON.stringify(G()),
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
      } else if (act.k === "move" && lab.mode !== "replay") {
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
          moveNode(act.id, nx, ny);
        }
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
      if (a.k === "fpick") {
        if (a.id !== lab.cfocus) focusOn(a.id);
        else set({ sel: { t: "node", id: a.id } });
        return;
      }
      if (a.k === "pan") {
        if (!a.moved && lab.sel && !lab.cfocus)
          set({ sel: null, addCtxOpen: false });
        return;
      }
      if (a.k === "move") {
        if (a.moved) {
          pushUndo(a.before);
          markDirty();
        } else set({ sel: { t: "node", id: a.id }, addCtxOpen: false });
        return;
      }
      if (a.k === "edge") {
        set({ sel: { t: "edge", i: a.i } });
        return;
      }
      if (a.k === "wire") {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const to = el?.closest?.(".nd") as HTMLElement | null;
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
      if (
        e.key === "Escape" &&
        lab.cfocus &&
        lab.view === "canvas" &&
        !typing &&
        !lab.viewer
      ) {
        unfocus();
        return;
      }
      if (typing || lab.view !== "canvas" || lab.mode === "replay") return;
      if (e.key === " ") {
        space = true;
        st.classList.add("pan");
        e.preventDefault();
      }
      const k = e.key.toLowerCase();
      if (!e.metaKey && !e.ctrlKey) {
        if (k === "v") set({ tool: "sel" });
        if (k === "c") set({ tool: "con" });
        if (k === "h") set({ tool: "pan" });
      }
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        lab.sel &&
        !lab.cfocus
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
