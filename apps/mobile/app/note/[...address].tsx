import { View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { DeadLinkScreen } from "../../features/app/DeadLinkScreen";
import { GuestNoteScreen } from "../../features/guest/GuestNoteScreen";
import { grantHrefOf } from "../../features/console/shared/SharedGrantView";
import { useColors } from "../../features/design/theme";
import {
  canonicalHrefFor,
  noteAddressFromSegments,
  noteLinkPath,
  type NoteAddress,
} from "../../features/console/noteLink";

/**
 * `/note/@slug/<path>` — the link format anything outside the app can produce.
 *
 * This is the route that was missing. `context://note/@supa/1-projects/…/overview.md`
 * — a link ChatGPT generated on 2026-09-03 — opened the app and rendered Expo
 * Router's Unmatched Route screen, because nothing matched `note/…`. The
 * grammar, and why its first segment is a fixed keyword rather than the
 * context's name, is in `features/console/noteLink.ts`.
 *
 * ## It redirects rather than rendering the note
 *
 * `/console/@slug?note=…` stays the canonical address. Two things follow from
 * keeping exactly one of them real:
 *
 *  - Everything the console already does for that URL happens for free —
 *    signing in and coming back (`attemptedHrefFrom` reads it off
 *    `window.location`), a context you are invited to but have not accepted
 *    (`resolveContextRoute` sends you to the invitation), a context that is not
 *    yours (the landing). None of that is re-implemented here, so none of it
 *    can drift.
 *  - The address bar ends up holding the URL a person can copy, bookmark and
 *    reload — which is the whole feature. A `/note/…` URL that stayed in the
 *    bar would be a second address for one note, and only one of the two is
 *    kept in step with what is open.
 *
 * ## It is outside `(app)`, deliberately
 *
 * So a signed-out visitor is redirected to the console URL *first* and is then
 * sent to sign in carrying it, rather than being sent to sign in carrying
 * `/note/…` and bounced through this again afterwards. One hop, one `next`, and
 * the parameter that survives is the canonical one.
 *
 * `Redirect` rather than an effect: it acts during render, so there is no frame
 * in which this route is mounted and painting.
 *
 * ## Except for somebody signed out, who may be a guest
 *
 * Tex sends this same link to a group chat, and a guest in a guest-mode chat
 * has no account to sign in to (the owner, 2026-10-27). So a signed-out
 * visitor gets the guest page instead of the sign-in: their number, a texted
 * code, and the note, read only (`features/guest/GuestNoteScreen.tsx`). It
 * keeps "Have one? Sign in" one tap away, carrying the canonical URL, so a
 * member who is signed out still lands on the note in the console.
 *
 * ## And for somebody signed in who isn't a member
 *
 * The console address opens only a member's notes; anyone else landed on their
 * own home with no word about the note (the owner, 2026-10-27: a chat guest
 * with an account tapped Tex's link and saw his own workspace). So a signed-in
 * caller is asked where the link opens for them (`noteLinks.target`): a member
 * goes to the console as before, someone named on the note or a folder above it
 * reads it in @shared, where every outsider grant opens, someone invited there
 * still goes to the console (which shows the invitation), and anyone else is
 * told the note isn't open to them.
 */
export default function NoteLinkRoute() {
  const params = useLocalSearchParams<{ address?: string | string[] }>();
  const address = noteAddressFromSegments(segmentsOf(params.address));
  const auth = useConvexAuth();

  if (address === null) {
    return (
      <DeadLinkScreen
        title="That note link is not one we can read"
        /*
          The example is built by the grammar rather than spelled out, so the
          shape somebody is shown cannot drift from the one that just rejected
          them.
        */
        detail={`A link to a note looks like ${noteLinkPath("name", "folder/note.md")}. This one is missing the context it belongs to, or names a path we will not open.`}
      />
    );
  }
  if (auth.isLoading) return <Waiting />;
  if (!auth.isAuthenticated) return <GuestNoteScreen address={address} />;
  return <SignedInNoteLink address={address} />;
}

function SignedInNoteLink({ address }: { address: NoteAddress }) {
  const target = useQuery(api.functions.noteLinks.target, { slug: address.slug, path: address.path });
  // An invitation not yet answered: the console address takes them to it, carrying the note.
  const invitations = useQuery(api.functions.invitations.listMyInvitations, {});
  if (target === undefined) return <Waiting />;
  if (target.kind === "granted") {
    return <Redirect href={grantHrefOf({ workspaceId: target.workspaceId, ref: { by: "path", path: target.path }, folder: false })} />;
  }
  if (target.kind === "none" && invitations === undefined) return <Waiting />;
  if (target.kind === "none" && !invitations?.some((invitation) => invitation.slug === address.slug)) {
    return (
      <DeadLinkScreen
        title="This note isn't open to you"
        detail={`Your account can't open this note in @${address.slug}. It may have been moved, or not shared with you. Ask whoever sent it, or Tex in the chat, to share it with you.`}
      />
    );
  }
  return <Redirect href={canonicalHrefFor(address)} />;
}

/** Auth settling: one frame of ground, never a flash of the guest page for somebody signed in. */
function Waiting() {
  const colors = useColors();
  return <View style={{ flex: 1, backgroundColor: colors.ground }} />;
}

/**
 * Expo Router gives a catch-all its segments as an array, and a single-segment
 * match as a bare string. Both shapes are real: `/note/@supa` is the second,
 * and it is a link somebody truncated — `noteAddressFromSegments` refuses it
 * for having no path, which is the whole reason this must not silently drop it.
 */
function segmentsOf(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
