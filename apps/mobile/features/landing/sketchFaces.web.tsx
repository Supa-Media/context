import { useId } from "react";
import { notesLandingColors as C } from "../design/tokens/landingColors";

/**
 * The example people on the front door, drawn (Dev2, 2026-10-29: "a context
 * stylized supa icon ... faces that look like the supa icon but sketch like").
 * Every head is the Supa "regular guy" mark (`console/faces/faceLogo.ts`) in
 * profile: the same dome, long nose, two eye strokes, stepped ear and stub of
 * a neck, with its own hair on top, some turned the other way. A small
 * displacement filter wobbles every line so it reads as pen on paper.
 *
 * Made-up people only; nobody's real picture is drawn here.
 */

const HEAD = [
  "M35,44 C32,28 40,17 54,17 C68,17 74,27 71,40 L68,43 L72,44 C74,50 73,57 69,60 L67,61 C66,67 61,70 55,70 L51,70",
  "M35,44 L35,47 L28,47.5 C24.5,48.5 24.5,53 28,53 L40,53",
  "M37,53 L37,57 L45,57",
  "M37,57 C37,63 42,68 51,70",
  "M51,70 C49,74 50,79 54,79 C58,79 59,74 57,70",
  "M40,39 L40,44 L44,44",
  "M48,37.5 L48,44",
];

type Hair = { fill?: string; lines?: readonly string[] };

const HAIR = {
  bob: {
    fill: "M34,40 C30,24 44,15 56,16 C70,17 79,28 76,44 C76,54 75,62 72,66 L69,66 C71,58 71,50 70,44 L66,43 C66,34 60,30 52,31 C46,32 42,35 40,38 C38,36 36,37 34,40 Z",
  },
  bun: {
    fill: "M35,36 C36,25 45,19 56,20 C66,21 72,28 71,38 C66,31 58,28 50,29 C43,30 38,33 35,36 Z",
    lines: ["M52,20 C47,18 47,10 54,9.5 C61,9 63,15 58,19"],
  },
  curls: {
    lines: [
      "M34,38 c-3,-4 1,-9 5,-7 c-1,-5 6,-8 9,-4 c1,-5 9,-6 11,-1 c3,-4 10,-1 9,4 c5,0 7,6 3,9 c4,2 3,9 -2,9 c3,4 0,9 -4,8",
    ],
  },
  cap: {
    fill: "M34,37 C34,25 44,18 55,18 C66,18 73,26 72,37 Z",
    lines: ["M36,36 L18,38 C16,38 16,35 19,34 L36,32"],
  },
  short: {
    lines: [
      "M35,34 C40,25 50,21 60,23 C67,25 72,31 71,38",
      "M40,29 l3,-3 M46,25 l3,-3 M53,23 l3,-2 M60,23 l3,-1 M66,27 l3,-1",
    ],
  },
  beard: {
    lines: [
      "M37,57 C39,66 46,70 52,70 C60,70 66,66 67,61",
      "M41,60 l2,3 M45,62 l2,3 M50,63 l2,3 M55,63 l2,3 M60,62 l2,3",
      "M35,34 C40,25 50,21 60,23 C67,25 72,31 71,38",
    ],
  },
  glasses: {
    lines: ["M43,41 a6,5 0 1,0 12,0 a6,5 0 1,0 -12,0", "M55,41 L69,42"],
  },
} satisfies Record<string, Hair>;

export type SketchPerson = {
  name: string;
  hair: readonly (keyof typeof HAIR)[];
  ground: string;
  /** Looks right instead of left. */
  turned?: boolean;
  /** The wobble's noise seed, so two people never shake the same way. */
  seed: number;
};

export const PEOPLE = {
  phoebe: { name: "Phoebe", hair: ["bob"], ground: C.tint, seed: 2 },
  ines: {
    name: "Ines",
    hair: ["curls"],
    ground: C.peach,
    turned: true,
    seed: 5,
  },
  sam: { name: "Sam", hair: ["cap"], ground: C.sage, seed: 7 },
  jo: { name: "Jo", hair: ["beard"], ground: C.butter, turned: true, seed: 9 },
  theo: { name: "Theo", hair: ["short", "glasses"], ground: C.lilac, seed: 11 },
  ada: { name: "Ada", hair: ["bun"], ground: C.sky, turned: true, seed: 13 },
} as const satisfies Record<string, SketchPerson>;

/** One drawn face, filling its box. Decorative: the name beside it says who. */
export function SketchFace({
  person,
  className,
}: {
  person: SketchPerson;
  className?: string;
}) {
  const filter = `sk${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const hair: Hair[] = person.hair.map((key) => HAIR[key]);
  return (
    <svg
      className={className}
      viewBox="0 0 100 100"
      aria-hidden
      focusable="false"
    >
      <defs>
        <filter id={filter}>
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.05"
            numOctaves={2}
            seed={person.seed}
          />
          <feDisplacementMap in="SourceGraphic" scale={2.4} />
        </filter>
      </defs>
      <rect width="100" height="100" fill={person.ground} />
      <g
        filter={`url(#${filter})`}
        fill="none"
        stroke={C.ink}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <g transform="translate(-4,1) scale(1.06)">
          <g
            transform={
              person.turned ? "translate(100,0) scale(-1,1)" : undefined
            }
          >
            <g
              transform="translate(53,44) scale(1.03,1.14) translate(-53,-44)"
              strokeWidth={3.2}
            >
              {hair.map((h, i) =>
                h.fill ? (
                  <path key={`f${i}`} d={h.fill} fill={C.ink} strokeWidth={2} />
                ) : null,
              )}
              {hair.flatMap((h, i) =>
                (h.lines ?? []).map((d, j) => (
                  <path key={`l${i}-${j}`} d={d} />
                )),
              )}
            </g>
            {HEAD.map((d) => (
              <path key={d} d={d} strokeWidth={3.6} />
            ))}
          </g>
        </g>
      </g>
    </svg>
  );
}
