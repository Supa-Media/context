import type { SetupAgent } from "../../../agentSetup/guides";
import type { Presence } from "../../presence/usePresence";
import type { DrawingCollaboration } from "../../files/drawingCollaboration";
import type { ConsoleData } from "../../types";
import type { SettingsSectionKey } from "../../settings/sections";

/** What `BrowsePane` is handed. See the component for how each is used. */
export type BrowsePaneProps = {
  /**
   * Who else has this note open, when the surface has anybody to ask.
   *
   * Absent on the landing page's demo console, which has no account behind it —
   * and the chip and the carets are then not drawn rather than drawn empty.
   */
  presence?: Presence;
  /** The live room behind an open canvas, when there is one. */
  drawingCollaboration?: DrawingCollaboration;
  data: ConsoleData;
  /**
   * Optionally at a named section — which is what lets a control deep-link to
   * the place its own answer lives: the share dialog's group row sends you to
   * `groups`, because who is in a group is decided there and nowhere else.
   * Called with nothing, it opens where the gear always did.
   */
  onOpenSettings?: (section?: SettingsSectionKey) => void;
  /**
   * The note this URL names, if it names one.
   *
   * The first of the two gaps between landing on `/console/@slug?note=…` and
   * seeing that note: the URL has been read and the browser has not acted on
   * it yet. The second gap — the browser reading the note's body — is
   * `files.opening`, and both are answered in the same place. See the comment
   * on `openDocument`.
   */
  pendingNote?: string | null;
  /**
   * `?anchor=`, read once at the route — see `nav.ts`'s `noteHref` and
   * `anchorFromQuery`. Meaningful only to a channel-day view; every other
   * branch below ignores it, the same way an ordinary note ignores `?note=`
   * naming a folder.
   */
  anchor?: string | null;
  /**
   * Open a communications path from inside a comms view — a contact's
   * activity link, today. **Not `files.select`**: an activity link names an
   * anchor as well as a path, and `select` has no way to carry one. The
   * caller does a real navigation (`router.push(noteHref(slug, path,
   * anchor))`), which is the same URL a pasted link or a search result would
   * use — so this view never invents a second way to reach "note plus
   * anchor". Absent on a console with no router behind it (the landing
   * page's demo, `e2e-fixture`'s own wiring), in which case activity links
   * still open the day — `files.select`, anchor dropped — rather than doing
   * nothing.
   */
  onOpenComms?: (path: string, anchor?: string) => void;
  /**
   * Go to a console-wide route — the welcome card's Connections and
   * `/welcome` rows. A prop rather than `useRouter` in the band, for
   * `onOpenComms`' reason: the demo console and the fixtures have no router,
   * and without one those rows are drawn as text rather than as dead links.
   */
  onNavigate?: (href: string) => void;
  /**
   * Opens the guided Claude/ChatGPT setup over this context (`?connect=`).
   * Absent in the demo and the fixtures, where the welcome card then offers
   * Connections instead.
   */
  onConnectAgent?: (agent: SetupAgent) => void;
};
