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
grain is fixed to the screen, so the board stays still while the drawing pans
and zooms over it (Dev2, 2026-11-04: "the backgrounds move as i zoom in and
out - it should be static"; this reverses the 2026-10-11 choice). A link's bow
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
fallback, and the bow is stable) and `liveMapLook.test.ts` ("the board under
the map": still while panning, ruled boards).

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

The phone keeps its two rows of tracks (only the word changes). Since
2026-11-04 the replay is in the map's settings (below), so the dock keeps Map
or Columns and − +, and only while a replay plays the replay bar and Back to
live. Reversing
this brings back the overflowing bar; tests: `liveMapRangePicker.test.ts`
("the desktop dock", "the workspace menu") and `liveMapCamera.test.ts` ("the
trail beside the workspace menu").

## The map's settings, kept on the account (Dev2, 2026-11-04)

Dev2 asked for Obsidian's settings button beside the map, then for "the map
replay stuff" to move into it, and set the defaults by hand on the prototype.
A gear in the canvas's top right (on a phone, in the bar) opens **Map
settings**: a panel beside the map on a computer, a sheet on a phone. It holds
Replay (Live, Past 24 hours, Past week, Pick dates…), the board (Follow theme,
paper, graph paper, brown paper, chalkboard, blueprint), the pencil (neat to
messy, line thickness), the dots (size, spread), the names (busiest first, all
that fit, only what's happening; text size) and Restore defaults.

- **One record per person, on the account** (`mapLookPreferences` in Convex,
  `functions/mapLook.ts`), so the map opens the same way on every computer
  and phone; never only in the browser. A slider's drag is one save, written
  700 ms after the last change (`useMapLook`). A demo map keeps its changes
  on the page. The row goes with the account.
- **The look travels in `MapData.look`**, so the canvas inside the phone's web
  view reads it the same way the web does. `lookOf` reads any stored record
  back inside the ranges in `look.ts`, whose `DEFAULT_LOOK` is Dev2's.
- **Spread is applied in the layout**, not in the drawing, so taps and the
  camera agree with what is drawn.
- **No cursor wiggle**: notes never move under the pointer, so they stay easy
  to click (Dev2, 2026-11-04).
- Nothing here changes who can see what.

**What a "simplification" would cost:** keeping the choices in local storage
loses them on the next device; scaling spread at draw time puts taps beside
the dots. **Test:** `liveMapLook.test.ts`, `liveMapRangePicker.test.ts` ("the
map's settings"), and `apps/convex/__tests__/mapLookPreferences.test.ts`.

## Reading is a mark on the note; a clicked note traces its links (Dev2, 2026-11-04)

Dev2 found the dots streaming from a read note into its reader "very annoying
to look at", and liked the prototype's click-to-trace. Both live in
`engine/draw/marks.ts`:

- **Somebody reading a note** gets a mark on the note itself, chosen in the
  map's settings: a loose pencil circle slowly redrawn (the default), a ring
  that pulses out, or a soft halo. Nothing joins the note to the reader.
  With reduced motion the mark stands still.
- **Clicking a note** (which opens its card) draws its links to the notes one
  step away over in pen. Those notes keep their full strength and their names,
  and every other link and dot steps back to a quarter.

**What a "simplification" would cost:** a line to the reader brings back what
Dev2 asked to remove, and tracing more than one step lights half the map in a
linked workspace. **Test:** `liveMapMarks.test.ts`.

## Far out the map is a pencil drawing, and it is drawn in when it opens (Dev2, 2026-11-04)

Round one of the rework drew far-out workspaces as glowing galaxies; Dev2
disliked the "blurry pieces of light" and asked to lean into pencil sketches
and chaos. In `engine/draw/sketch.ts`:

- **Far out, every folder is a pencil scribble**, a seeded random walk inside
  it, and across workspaces every workspace gets a loose pencil loop. Both
  fade in only as notes crowd closer than about 14 pixels, and the links and
  dots under them step back; zooming in, the scribble fades and the notes come
  through. This is the one exception to "nothing is drawn round a workspace
  or folder" (2026-10-10): it is drawn only where the notes themselves are too
  close to read, never round a folder you can see into.
- **The opening**: the first time the map has notes, it is drawn in as the
  settings pick: links sketched outward from each workspace's middle (the
  default), dots blooming out, folder by folder, or zooming in from
  everything. Names wait for their notes. Reduced motion skips it, and it
  plays once per map, not on every change.

**Test:** `liveMapSketch.test.ts`.

## Show, colour and lines in the map's settings (Dev2, 2026-11-04)

The rest of the prototype's settings, with Dev2's choices as everyone's
defaults:

- **Show**: Archive (off: one icon, as before; on: spread out like any
  folder, in the layout), notes with no links (on; off leaves them out of the
  layout), and AIs at work (on; off drops agents' faces, steps and trails).
- **Colour by** (`engine/draw/colour.ts`): workspace (default), folder, topic
  (subfolder), pencil pressure (written in the past week dark, older faint) or
  one colour. Coloured pencils come in a light-board and a dark-board set.
  Resting dots are still one fill per colour, never one per dot.
- **Which lines** (`engine/draw/lines.ts`): all (default), near the cursor,
  or on hover; with no mouse to follow (a phone) every line shows. **One line
  between folders** (on): far out, the links between two folders are one
  pencil stroke, thicker for more.
- **AI pencil trails**: a faint dashed pencil line through an AI's last few
  reads, ending at it; only while it works, and only once it has read two
  notes. This is not the reading stream Dev2 asked to remove: it is one faint
  line per AI, not dots flowing between note and reader.

**Test:** `liveMapShowColourLines.test.ts`.

## The map's own motion: 3D depth, breathing, and Find (Dev2, 2026-11-04)

Dev2 found the 3D view "tuff", asked for only a slight motion that never
keeps a person from clicking a note, and said "wiggle near cursor shouldnt
exist". In `engine/motion.ts` and `engine/draw/depth.ts`:

- **3D depth** (on): each folder sits at its own depth, and the drawing leans
  with the mouse, so near folders move more than far ones (at most
  `DEPTH_PX`). The lean follows the whole window, not the note under the
  pointer, so a note moves a fraction of a pixel as the mouse crosses it. No
  mouse (a phone), no lean; reduced motion lies flat.
- **Breathe** (default) or **Still**: the dots swell and settle very
  slightly, out of step. It asks only for a slow frame (about 15 a second),
  so a map nobody touches stays cheap; reduced motion stops it. Hit areas do
  not breathe.
- **Find** at the top of the settings: notes whose names hold the words,
  names that start with them first; a pick goes to the note and opens its
  card (on a phone the sheet closes to show it).

Tests and fixtures leave the motion off (`ambient` on the engine); the web
canvas and the phone's web view turn it on. **Test:** `liveMapMotion.test.ts`.
