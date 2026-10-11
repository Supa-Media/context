import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Page a's picture (Dev, 2026-10-11: "more in a graph format, you see emails
 * coming in, meetings coming in, a new side project developing, ai bots
 * working on cleaning things up"). Things land on the page faster than anyone
 * could file them, two AI helpers go to each one in turn, and each becomes a
 * dot linked into its folder. Halfway through a new folder appears, a side
 * project, and grows. Then the day starts again.
 */

type Folder = { name: string; x: number; y: number; from?: number };
type Item = { kind: string; label: string; folder: number; x: number; y: number };

const FOLDERS: readonly Folder[] = [
  { name: "Work", x: 20, y: 24 },
  { name: "Church", x: 80, y: 20 },
  { name: "Reading", x: 22, y: 80 },
  // The side project: there is no folder for it until its first idea lands.
  { name: "Nonprofit", x: 74, y: 66, from: 5 },
];

/** Each item lands loose at (x, y), in percent of the box, then is filed. */
const ITEMS: readonly Item[] = [
  { kind: "Meeting", label: "Tuesday standup", folder: 0, x: 50, y: 14 },
  { kind: "Email", label: "Re: Q3 budget", folder: 0, x: 34, y: 46 },
  { kind: "Notes", label: "Sermon, Romans 8", folder: 1, x: 64, y: 38 },
  { kind: "Email", label: "Small group Friday", folder: 1, x: 44, y: 62 },
  { kind: "Chat", label: "Launch plan", folder: 0, x: 70, y: 56 },
  { kind: "Idea", label: "Start a nonprofit?", folder: 3, x: 30, y: 30 },
  { kind: "Article", label: "Pricing your work", folder: 2, x: 58, y: 82 },
  { kind: "Email", label: "First board call", folder: 3, x: 52, y: 44 },
  { kind: "Meeting", label: "Call with a lawyer", folder: 3, x: 36, y: 64 },
  { kind: "Book", label: "Atomic Habits", folder: 2, x: 66, y: 26 },
  { kind: "Draft", label: "Blog: why we started", folder: 3, x: 46, y: 28 },
  { kind: "Code", label: "Website, built with Claude", folder: 3, x: 56, y: 60 },
];

const HELPERS = ["Claude", "ChatGPT"] as const;
/** Where the helpers wait when there is nothing to file: the middle, now empty. */
const RESTING = [
  { x: 38, y: 50 },
  { x: 62, y: 50 },
] as const;

/** The day's clock, in ms: when each item lands and when it is filed. */
const ARRIVE_EVERY = 420;
const FILE_START = 3600;
const FILE_EVERY = 520;
const HOLD_UNTIL = 15000;
const TICK = 100;
const arriveAt = (i: number) => 300 + i * ARRIVE_EVERY;
const fileAt = (i: number) => FILE_START + i * FILE_EVERY;
const DONE = fileAt(ITEMS.length - 1) + 600;

/** Where a filed item sits: spread around its folder, one ring per folder. */
function filedSpot(i: number): { x: number; y: number } {
  const item = ITEMS[i]!;
  const folder = FOLDERS[item.folder]!;
  const siblings = ITEMS.flatMap((it, j) => (it.folder === item.folder ? [j] : []));
  const k = siblings.indexOf(i);
  // Fanned out below and to the sides, leaving the space above for the folder's name.
  const angle = ((-15 + ((k + 0.5) / siblings.length) * 210) * Math.PI) / 180;
  // The line straight down reaches further, so its name clears its neighbours'.
  const reach = Math.abs(angle - Math.PI / 2) < Math.PI / 6 ? 1.6 : 1;
  return { x: folder.x + Math.cos(angle) * 11 * reach, y: folder.y + Math.sin(angle) * 12 * reach };
}

export function ChaosGraph() {
  const box = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(0);
  const [still, setStill] = useState(false);
  const [paused, setPaused] = useState(false);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) setStill(true);
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") return setSeen(true);
    const watch = new IntersectionObserver(([entry]) => setSeen(!!entry?.isIntersecting), { threshold: 0.4 });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const running = seen && !still && !paused;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow((t) => (t + TICK >= HOLD_UNTIL ? 0 : t + TICK)), TICK);
    return () => clearInterval(timer);
  }, [running]);
  const t = still ? DONE : now;
  const fading = !still && t > HOLD_UNTIL - 700;
  return (
    <figure className="sp-figure">
      <div
        ref={box}
        className="sp-graph"
        data-fading={fading ? "" : undefined}
        role="img"
        aria-label="Emails, meetings, notes and a new side project land on the page; two AI helpers file each one into its folder."
      >
        <svg className="sp-links" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {ITEMS.map((item, i) => {
            const folder = FOLDERS[item.folder]!;
            const spot = filedSpot(i);
            return (
              <line
                key={item.label}
                x1={folder.x}
                y1={folder.y}
                x2={spot.x}
                y2={spot.y}
                vectorEffect="non-scaling-stroke"
                data-on={t >= fileAt(i) + 300 ? "" : undefined}
              />
            );
          })}
        </svg>
        {FOLDERS.map((folder) => {
          const shown = folder.from === undefined || t >= arriveAt(folder.from);
          return (
            <span
              key={folder.name}
              className="sp-hub"
              data-on={shown ? "" : undefined}
              style={{ left: `${folder.x}%`, top: `${folder.y}%` } as CSSProperties}
              aria-hidden
            >
              <i />
              {folder.name}
            </span>
          );
        })}
        {ITEMS.map((item, i) => {
          const filed = t >= fileAt(i);
          const spot = filed ? filedSpot(i) : item;
          const state = t < arriveAt(i) ? "away" : filed ? "filed" : "loose";
          const style = { left: `${spot.x}%`, top: `${spot.y}%`, "--turn": `${((i * 37) % 13) - 6}deg` } as CSSProperties;
          return (
            <span key={item.label} className="sp-item" data-state={state} style={style} aria-hidden>
              <span className="sp-pill">
                <small>{item.kind}</small>
                {item.label}
              </span>
              <i className="sp-dot" />
              <em className="sp-tag">
                {item.label}
              </em>
            </span>
          );
        })}
        {HELPERS.map((name, b) => {
          // Each helper takes every other item, and heads for it just before it is filed.
          const mine = ITEMS.map((_, i) => i).filter((i) => i % HELPERS.length === b);
          const next = mine.find((i) => fileAt(i) > t);
          // Waiting by its own folder until the next one has landed.
          const busy = next !== undefined && t >= arriveAt(next);
          const target = busy ? ITEMS[next]! : RESTING[b]!;
          const style = { left: `${target.x}%`, top: `${target.y}%` } as CSSProperties;
          return (
            <span key={name} className="sp-helper" style={style} aria-hidden>
              <i />
              {name}
            </span>
          );
        })}
      </div>
      {still ? null : (
        <button type="button" className="sp-tidy" onClick={() => setPaused((p) => !p)}>
          {paused ? "Play" : "Pause"}
        </button>
      )}
    </figure>
  );
}
