import { useEffect, useRef, useState } from "react";
import { chaosScene } from "./chaosDraw";
import type { Ink } from "./chaosIcons";
import { buildStory, FADE } from "./chaosStory";

/**
 * Page a's picture (Dev, 2026-10-11, settled over eighteen rounds of a
 * preview): a cluttered life being sorted by AI helpers into a Personal
 * workspace, a side project growing in it, and the side project moving into
 * its own shared workspace, Hangg, when co-founders join. The story is
 * `chaosStory.ts`; `chaosDraw.ts` draws a frame of it on one canvas.
 *
 * The clock runs only while the graph is on screen and not paused, and loops.
 * With reduced motion it draws the sorted end state once, and Tex is calm.
 * `onChaos` reports how unsettled the picture is, for Tex at the top.
 */

const STORY = buildStory();

export function ChaosGraph({ ink, onChaos }: { ink: Ink; onChaos: (chaos: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [still, setStill] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const report = useRef(onChaos);
  report.current = onChaos;

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const scene = chaosScene(STORY);
    let W = 0;
    let H = 0;
    let dirty = true;
    const size = () => {
      dirty = true;
      const r = el.getBoundingClientRect();
      const d = window.devicePixelRatio || 1;
      W = r.width;
      H = r.height;
      el.width = Math.round(W * d);
      el.height = Math.round(H * d);
      ctx.setTransform(d, 0, 0, d, 0, 0);
    };
    size();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    setStill(reduce);
    if (reduce) {
      const end = STORY.hold - FADE - 1;
      const once = () => {
        size();
        scene.draw(ctx, W, H, end, ink);
      };
      once();
      report.current(0);
      window.addEventListener("resize", once);
      return () => window.removeEventListener("resize", once);
    }
    // The column can change width without the window doing so (a font loading, a scrollbar appearing).
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(size);
    resize?.observe(el);
    window.addEventListener("resize", size);
    let visible = true;
    const watch =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting), { threshold: 0.2 });
    watch?.observe(el);
    let now = 0;
    let last = performance.now();
    let chaos = 100;
    let frame = 0;
    let shown = -1;
    const tick = (ts: number) => {
      const dt = Math.min(100, ts - last);
      last = ts;
      frame = requestAnimationFrame(tick);
      // Paused or off screen, nothing moves, so nothing is drawn until the canvas is resized.
      if (pausedRef.current || !visible) {
        if (!dirty) return;
      } else now = now + dt >= STORY.hold ? 0 : now + dt;
      dirty = false;
      const loose = scene.draw(ctx, W, H, now, ink);
      chaos += (100 * Math.min(1, loose) - chaos) * 0.06;
      // Tex redraws only when it is a whole step different.
      const step = Math.round(chaos);
      if (step !== shown) report.current((shown = step));
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      watch?.disconnect();
      resize?.disconnect();
      window.removeEventListener("resize", size);
    };
  }, [ink]);

  return (
    <figure className="sp-figure">
      <canvas
        ref={canvas}
        className="sp-graph"
        role="img"
        aria-label="About sixty notes start loose and tangled. Two AI helpers sort them into workspaces, each with an Inbox, Projects, Areas, Resources and Archive, while new messages keep landing in the Inbox. A side project grows inside Personal from New app into a friend hangout app; when two co-founders join, it moves into its own shared Hangg workspace and their own assistants start working on the notes they bring."
      />
      {still ? null : (
        <button
          type="button"
          className="sp-tidy"
          aria-label={paused ? "Play the animation" : "Pause the animation"}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? "Play" : "Pause"}
        </button>
      )}
    </figure>
  );
}
