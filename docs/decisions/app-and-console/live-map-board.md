# App and console — what the live map is drawn on

### The map is drawn on paper and a blackboard; its words are not (2026-10-11)

Dev2 asked for the map to show "the natural chaos of notes" as a drawing: cream
paper with a faint grain in light mode, a blackboard with white chalk in dark
mode. Three rounds of reference boards settled what that means. A fully drawn
version, with handwritten labels, scribbled notes and sketched buttons, read as
a cartoon and lost what the graph says about a workspace, so it was kept back
as a possible theme people could switch on later. What shipped is the second
round with drawn dots:

- **Drawn:** the board itself (`board: "paper" | "chalk"` and `ground` in
  `lightMapColors` / `darkMapColors`), links as grainy pencil or chalk strokes
  with a slight bow, a soft halo on chalk, and resting notes as grainy dots
  with a loose rim once they are big enough to show one.
- **Not drawn:** note and folder names, faces, robots, cards, buttons and the
  replay bar. They stay in the app's type and shapes, because the map has to
  stay easy to read.

All of it lives in `engine/draw/board.ts`: textures made once and painted as
canvas patterns, so a frame paints no more times than a flat map did. The
grain is fixed to the camera, so the board moves with the drawing. A link's bow
comes from where its ends are in the world, so it does not wobble as the map
pans. Where patterns or a canvas are not available, the map falls back to the
flat colours and nothing else changes. Far out, where thousands of links
overlap, `boardHaze` holds the darker pencil and brighter chalk back, so the
haze does not become a blot.

**What a "simplification" would cost:** drawing words or controls by hand makes
the map harder to read, which is the reason round one was set aside. Painting
the texture per mark instead of as a pattern multiplies the cost of a frame by
the number of notes. Hashing the bow from screen positions makes every link
shimmer while panning.

**Test:** `apps/mobile/__tests__/liveMapBoard.test.ts` (the board is textured,
links and dots carry grain, chalk has a halo and pencil does not, the flat
fallback, and the bow is stable).
