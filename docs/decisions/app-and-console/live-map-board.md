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

### Agents in the middle only while they work; Archive is one icon (2026-10-12)

Dev2 found the all-workspaces middle cluttered by every AI tool ever connected,
and Archive, usually the biggest folder, crowding each workspace. Both are now
drawn by what is happening, not by what exists:

- **An agent stands in the middle only while it is at work** (`agentsAtWork`
  in `mapHub.ts`): one of your own agents with a read or write in the last
  five minutes, the gateway's own live window (`AGENT_ACTIVITY_WINDOW_MS`), and
  its dotted lines go only to the workspaces it is working in. In a replay,
  the agents at the playhead. A connected tool sitting idle is not drawn at all.
- **Archive is a box icon with its name** (`collapsesToIcon` in
  `engine/layout.ts`): its notes draw no dots and no links, and all sit on the
  icon so a note moved into Archive still lands somewhere. Its folder page still
  lists every note.

- **No "You" in the middle, and no roads** (Dev2, 2026-10-12: "whats the You
  icon needed for though?"). Every workspace in the ring is already one you
  are in, so the face and its roads out said nothing; the middle stays empty
  until an agent works.

Reversing any of these brings back the clutter Dev2 asked to remove; tests:
`liveMapHub.test.ts` ("an idle tool is not drawn", "no You or roads") and `liveMapArchive.test.ts`.

## The controls around the map (Dev2, 2026-10-14)

Dev2 called the old chrome confusing and not compact: nine pills in a bar that
ran off the right edge, a breadcrumb whose "All workspaces" repeated two of
those pills, a slider wider than a third of the canvas for what scrolling
already does, and "Folders" meaning a layout in one place and a zoom level in
another. From four boards Dev2 picked the bottom dock (C):

- **Top left is one workspace menu** (`WorkspaceMenu` in `ui/MapDock.tsx`):
  every workspace, then "All my workspaces". It stands for the breadcrumb and
  the scope pills; the camera's trail follows it ("seyi ▾ › Areas").
- **Everything else is one dock at the bottom**, as a video player keeps its
  controls: Live, Replay (Past 24 hours, Past week, Pick dates… in a menu),
  Map or Columns, and − +. While a replay plays, the replay bar opens inside
  the dock. No top bar and no footer line, so the map gets the full height.
- **The Folders layout is called Columns**, so "Folders" is never two things.

The phone keeps its two rows of tracks (only the word changes). Reversing
this brings back the overflowing bar; tests: `liveMapRangePicker.test.ts`
("the desktop dock", "the workspace menu") and `liveMapCamera.test.ts` ("the
trail beside the workspace menu").
