import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Page a's picture of the feeling (Dev, 2026-10-11: "show don't tell"). The
 * pieces of one person's context lie on the page in a heap, and a moment
 * after the heap scrolls into view they put themselves away into a tidy grid,
 * each relabelled with the folder it went to. The visitor can make the mess
 * again and tidy it themselves.
 */

type Scrap = {
  kind: string;
  title: string;
  folder: string;
  /** Where it ends up in the tidy grid, read left to right. */
  slot: number;
  /** Where it lies in the heap: left in percent, top in px, turn in degrees. */
  heap: readonly [number, number, number];
};

const SCRAPS: readonly Scrap[] = [
  { kind: "Meeting", title: "Tuesday standup", folder: "Work", slot: 0, heap: [4, 18, -7] },
  { kind: "Sermon", title: "Romans 8, last Sunday", folder: "Church", slot: 8, heap: [50, 6, 5] },
  { kind: "Book", title: "Atomic Habits, chapter 3", folder: "Reading", slot: 6, heap: [22, 92, 11] },
  { kind: "Side hustle", title: "Candle shop orders", folder: "Candle shop", slot: 4, heap: [54, 132, -6] },
  { kind: "Chat", title: "Launch plan in ChatGPT", folder: "Work", slot: 2, heap: [2, 196, 4] },
  { kind: "Blog", title: "A post on pricing", folder: "Reading", slot: 7, heap: [38, 170, -3] },
  { kind: "App", title: "The app you built with Claude", folder: "Work", slot: 3, heap: [50, 236, 6] },
  { kind: "Handbook", title: "Staff handbook, version 2", folder: "Work", slot: 1, heap: [12, 282, -12] },
  { kind: "Idea", title: "Album cover sketch", folder: "Ideas", slot: 9, heap: [26, 40, 14] },
  { kind: "Side hustle", title: "Wedding photo invoices", folder: "Photography", slot: 5, heap: [44, 292, -5] },
];

/** How long the heap stays a heap once it is on screen. */
const TIDY_AFTER_MS = 2200;

export function MessyDesk() {
  const [tidy, setTidy] = useState(false);
  const [touched, setTouched] = useState(false);
  const desk = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = desk.current;
    if (!el || touched || typeof IntersectionObserver === "undefined") return;
    // Asked for less motion: the heap waits for the visitor's own "Tidy up".
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const seen = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        seen.disconnect();
        timer = setTimeout(() => setTidy(true), TIDY_AFTER_MS);
      },
      { threshold: 0.9 },
    );
    seen.observe(el);
    return () => {
      seen.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [touched]);
  return (
    <figure className="sp-figure">
      <ul ref={desk} className="sp-desk" data-tidy={tidy ? "" : undefined} aria-label="Things one person keeps track of">
        {SCRAPS.map((scrap) => {
          const place = {
            "--hx": `${scrap.heap[0]}%`,
            "--hy": `${scrap.heap[1]}px`,
            "--hr": `${scrap.heap[2]}deg`,
            "--col": scrap.slot % 2,
            "--row": Math.floor(scrap.slot / 2),
          } as CSSProperties;
          return (
            <li key={scrap.title} className="sp-scrap" style={place}>
              <span className="sp-kind">
                <span className="sp-kind-heap" aria-hidden={tidy}>
                  {scrap.kind}
                </span>
                <span className="sp-kind-tidy" aria-hidden={!tidy}>
                  {scrap.folder}
                </span>
              </span>
              <span className="sp-title">{scrap.title}</span>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="sp-tidy"
        onClick={() => {
          setTouched(true);
          setTidy((was) => !was);
        }}
      >
        {tidy ? "Make a mess again" : "Tidy up"}
      </button>
    </figure>
  );
}
