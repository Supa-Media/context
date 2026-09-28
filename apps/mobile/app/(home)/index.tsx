/**
 * `/` — drawn by `(home)/_layout`, which outlives this screen.
 *
 * Empty on purpose. Every homepage link is a push of `/?page=…`, and a push
 * mounts a fresh copy of the route's screen: when the homepage was this
 * screen, each link threw away `‹`, Recent, open tabs and whatever the visitor
 * had typed (Dev2, 2026-09-28). The layout stays mounted across those pushes,
 * so the homepage lives there and this is only the entry in the history.
 */
export default function HomeEntry() {
  return null;
}
