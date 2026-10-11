import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * Page a's picture of the feeling (Dev, 2026-10-11: "show don't tell"). The
 * pieces of one person's life lie on the page as the things they really are:
 * a calendar invite, a chat, a terminal, a sticky note, an invoice, a sketch,
 * a page of sermon notes. A moment after the heap is fully on screen they put
 * themselves away, each becoming one plain line under a folder, the way a room
 * looks once it is clean. The visitor can make the mess again.
 */

type Scrap = {
  look: string;
  /** What it is once put away. */
  title: string;
  /** Tidy place: column (0 or 1) and line. */
  col: 0 | 1;
  row: number;
  /** Heap place: share of the free width, top and size in em, turn in degrees. */
  hx: number;
  top: number;
  w: number;
  h: number;
  turn: number;
  body: ReactNode;
};

const SCRAPS: readonly Scrap[] = [
  {
    look: "cal",
    title: "Tuesday standup",
    col: 0,
    row: 1,
    hx: 0.02,
    top: 0.6,
    w: 13,
    h: 4.6,
    turn: -6,
    body: (
      <>
        <b className="sp-cal-when">Tue 9:30</b>
        <span>Weekly standup</span>
        <small>Video call, 6 people</small>
      </>
    ),
  },
  {
    look: "doc",
    title: "Staff handbook",
    col: 0,
    row: 2,
    hx: 0.8,
    top: 0,
    w: 11,
    h: 8,
    turn: 4,
    body: (
      <>
        <b>Staff handbook</b>
        <small>Version 2, draft</small>
        <i />
        <i />
        <i />
        <i />
      </>
    ),
  },
  {
    look: "chat",
    title: "Launch plan",
    col: 0,
    row: 3,
    hx: 0.36,
    top: 5.4,
    w: 14,
    h: 3.8,
    turn: -2,
    body: (
      <>
        <small>ChatGPT</small>
        <span>Help me plan the launch for next month</span>
      </>
    ),
  },
  {
    look: "term",
    title: "Budget app built with Claude",
    col: 0,
    row: 4,
    hx: 0.96,
    top: 9,
    w: 13,
    h: 5.4,
    turn: 7,
    body: (
      <>
        <span>~/budget-app</span>
        <span>$ claude</span>
        <span>&gt; add a savings goal</span>
      </>
    ),
  },
  {
    look: "ruled",
    title: "Romans 8, Sunday's sermon",
    col: 0,
    row: 7,
    hx: 0.04,
    top: 6.2,
    w: 12,
    h: 6.4,
    turn: 9,
    body: (
      <>
        <b>Romans 8:28</b>
        <span>all things work together for good</span>
      </>
    ),
  },
  {
    look: "sticky",
    title: "Candle shop orders",
    col: 1,
    row: 1,
    hx: 0.56,
    top: 11,
    w: 8.5,
    h: 8,
    turn: -10,
    body: <span>12 candles for Ada by Friday!</span>,
  },
  {
    look: "receipt",
    title: "Wedding photo invoices",
    col: 1,
    row: 2,
    hx: 0.26,
    top: 13.4,
    w: 10,
    h: 7.6,
    turn: 5,
    body: (
      <>
        <small>Invoice 014</small>
        <span>Okafor wedding</span>
        <b>$1,200</b>
      </>
    ),
  },
  {
    look: "sketch",
    title: "Album cover ideas",
    col: 1,
    row: 3,
    hx: 0.02,
    top: 15.6,
    w: 9,
    h: 7,
    turn: -8,
    body: (
      <>
        <svg viewBox="0 0 60 36" aria-hidden>
          <circle cx="18" cy="18" r="13" />
          <circle cx="18" cy="18" r="3" />
          <path d="M36 8q8 4 20 0M36 18q9 5 18 0M36 28q6 3 14 0" />
        </svg>
        <span>album cover?</span>
      </>
    ),
  },
  {
    look: "quote",
    title: "Atomic Habits highlights",
    col: 1,
    row: 6,
    hx: 0.64,
    top: 17.6,
    w: 14,
    h: 4.4,
    turn: -3,
    body: (
      <>
        <span>Make the good habit obvious.</span>
        <small>Atomic Habits, highlight</small>
      </>
    ),
  },
  {
    look: "tab",
    title: "How to price your work",
    col: 1,
    row: 7,
    hx: 0.42,
    top: 20,
    w: 14,
    h: 3.6,
    turn: 3,
    body: (
      <>
        <small>
          <i />
          <i />
          <i />
          pricing-your-side-project
        </small>
        <span>Read later</span>
      </>
    ),
  },
];

/** The folders the heap is put away into, each heading the lines under it. */
const FOLDERS: readonly { name: string; col: 0 | 1; row: number }[] = [
  { name: "Work", col: 0, row: 0 },
  { name: "Church", col: 0, row: 6 },
  { name: "Side projects", col: 1, row: 0 },
  { name: "Reading", col: 1, row: 5 },
];

/** How long the heap stays a heap once it is all on screen. */
const TIDY_AFTER_MS = 2200;

export function MessyDesk() {
  const [tidy, setTidy] = useState(false);
  const [touched, setTouched] = useState(false);
  const desk = useRef<HTMLDivElement>(null);
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
      <div ref={desk} className="sp-desk" data-tidy={tidy ? "" : undefined}>
        <div className="sp-folders" aria-hidden>
          {FOLDERS.map((f) => (
            <span key={f.name} className="sp-folder" style={{ "--col": f.col, "--row": f.row } as CSSProperties}>
              {f.name}
            </span>
          ))}
        </div>
        <ul className="sp-heap" aria-label="Things one person keeps track of">
          {SCRAPS.map((s, i) => {
            const place = {
              "--hx": s.hx,
              "--top": `${s.top}em`,
              "--w": `${s.w}em`,
              "--h": `${s.h}em`,
              "--turn": `${s.turn}deg`,
              "--col": s.col,
              "--row": s.row,
              "--i": i,
            } as CSSProperties;
            return (
              <li key={s.title} className={`sp-scrap sp-${s.look}`} style={place}>
                <span className="sp-look" aria-hidden>
                  {s.body}
                </span>
                <span className="sp-line">{s.title}</span>
              </li>
            );
          })}
        </ul>
      </div>
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
