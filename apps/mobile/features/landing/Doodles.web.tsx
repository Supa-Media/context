import type { ReactNode } from "react";

/**
 * The line under the headline: four things Context does today, each with a
 * small pen doodle (the instinct.com move: a short list, a drawing apiece).
 * The strokes are drawn a touch uneven on purpose, so they read as ink and
 * not as an icon set. Decoration only: the words carry the meaning.
 */
const DOODLES: readonly { key: string; text: string; path: ReactNode }[] = [
  {
    key: "live",
    text: "Write together, live",
    path: (
      <>
        <path d="M5.2 4.4c.2 4.9.1 10 .3 15.2" />
        <path d="M5.4 4.3c2.6-.3 5.1.1 6.9.9-1.8.8-4.3 1.2-6.8 1" />
        <path d="M17.6 9.2c-.1 3.6.1 7.1 0 10.6" />
        <path d="M17.7 9.1c-1.9-.2-3.6.1-5 .8 1.4.7 3.1 1 5 .9" />
      </>
    ),
  },
  {
    key: "text",
    text: "Text it in iMessage",
    path: <path d="M4.3 7.2c.1-1.7 1.2-2.7 3-2.8 3.3-.2 6.6-.2 9.7.1 1.7.1 2.8 1.2 2.8 2.9l-.1 5.5c0 1.7-1.1 2.7-2.8 2.8-2.2.1-4.2.1-6.1 0l-4.2 3.6.6-3.8c-1.9-.3-3-1.1-3-2.9z" />,
  },
  {
    key: "private",
    text: "Private stays private",
    path: (
      <>
        <path d="M5.3 11.2c4.6-.4 9-.3 13.4.1.4 2.6.3 5.6-.2 8.3-4.3.5-8.6.4-12.9 0-.5-2.7-.6-5.6-.3-8.4z" />
        <path d="M8.4 10.9c-.3-3 .9-5.8 3.7-5.9 2.9-.1 4 2.6 3.7 6" />
        <path d="M12 14.6v2" />
      </>
    ),
  },
  {
    key: "download",
    text: "Download everything",
    path: (
      <>
        <path d="M12.1 3.6c-.2 3.9-.1 7.9 0 11.6" />
        <path d="M7.6 11c1.6 1.5 3 3 4.5 4.4 1.5-1.4 2.9-2.9 4.3-4.6" />
        <path d="M4.6 19.8c5 .3 9.9.2 14.8-.2" />
      </>
    ),
  },
];

export function Doodles() {
  return (
    <ul className="lp-dd">
      {DOODLES.map((d) => (
        <li key={d.key}>
          <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
            {d.path}
          </svg>
          {d.text}
        </li>
      ))}
    </ul>
  );
}
