import { useEffect, useRef, useState } from "react";
import { STUDIO_FLAG, asStageEvent, studioCommand } from "../home/cast/studioLink";
import { editorSceneSrc } from "./editorScene";

/**
 * The window the shell lays out in, scaled to whatever width the page gives
 * it. A phone gets a taller one, still wide enough for the shell to keep its
 * file tree beside the note (narrower, and it switches to its phone layout).
 */
const WIDE = { width: 1200, height: 760 };
const NARROW = { width: 1000, height: 1250 };
const frameFor = (width: number) => (width < 700 ? NARROW : WIDE);
/** A pause on the finished page before the scene starts again. */
const REPLAY_AFTER_MS = 5000;

/**
 * The console's editor, playing `editorScene.ts`, in a window under page a's
 * headline.
 *
 * The stage is the homepage itself in an iframe, the way the cast studio
 * draws it (`StudioStage.web.tsx`): this page marks itself as a studio, so
 * the stage leaves out the "unpublished draft" line and waits to be told to
 * start. Only a same-origin parent can do that (`isStudioStage`). The iframe
 * loads when the window nears the screen, cannot be clicked (a click would
 * be a visitor's edit, which stops the show), and starts over when it ends.
 */
export function LandingEditor() {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(0);
  const [near, setNear] = useState(false);
  // Bumped to load the stage afresh: a played scene is a page that has been written on.
  const [take, setTake] = useState(0);
  const [src] = useState(editorSceneSrc);

  useEffect(() => {
    const flags = window as unknown as Record<string, unknown>;
    flags[STUDIO_FLAG] = true;
    return () => {
      delete flags[STUDIO_FLAG];
    };
  }, []);

  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const size = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    size.observe(element);
    const seen = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setNear(true);
    }, { rootMargin: "400px" });
    seen.observe(element);
    return () => {
      size.disconnect();
      seen.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!near) return;
    let replay: ReturnType<typeof setTimeout> | undefined;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      const said = asStageEvent(event.data);
      if (said?.kind === "ready") frame.current?.contentWindow?.postMessage(studioCommand({ kind: "start", from: 0 }), window.location.origin);
      else if (said?.kind === "ended") replay = setTimeout(() => setTake((n) => n + 1), REPLAY_AFTER_MS);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(replay);
    };
  }, [near, take]);

  const frameSize = frameFor(width);
  const scale = width / frameSize.width;
  return (
    <div className="lp-window lp-editor" aria-hidden>
      <div className="lp-bar">
        <i />
        <i />
        <i />
        <span>Demo workspace</span>
      </div>
      <div ref={box} className="lp-editor-stage" style={{ height: frameSize.height * scale }}>
        {near && scale > 0 ? (
          <iframe
            key={take}
            ref={frame}
            src={src}
            title="Context editor demo"
            sandbox="allow-scripts allow-same-origin"
            tabIndex={-1}
            style={{
              border: "none",
              display: "block",
              width: frameSize.width,
              height: frameSize.height,
              transform: `scale(${scale})`,
              transformOrigin: "0 0",
              pointerEvents: "none",
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
