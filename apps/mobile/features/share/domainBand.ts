import { createContext, useContext } from "react";
import type { SharedNote } from "./share";

/**
 * The shared link's band when the note's workspace is open to an email domain
 * (Dev, 2026-10-20; artboards in shared-link-domain-artboards).
 *
 * Signed out, the band invites signing in with that domain's email, and
 * carries the button, so the phone's top-left Sign in pill stands down.
 * Signed in at another address, it says which address and offers to add one
 * at the domain. A reader who holds one never sees the band: the page sends
 * them into the workspace (`joinSlug`), where the app joins them.
 *
 * The domain is the server's answer (`domainAccess`), and the workspace is
 * never named here: to this reader it is still "Shared with you".
 */

export type DomainAccess = NonNullable<SharedNote["domainAccess"]>;

export interface BandAction {
  label: string;
  onPress: () => void;
  /** A quiet link beside the button rather than a second button. */
  quiet?: boolean;
  testID: string;
}

export interface BandOffer {
  actions: BandAction[];
  /** The band carries the sign-in, so the top-left pill stands down. */
  signInInBand: boolean;
}

export const BandOfferContext = createContext<BandOffer | null>(null);

/** The band's buttons, where a shared link has some; `null` everywhere else. */
export function useBandOffer(): BandOffer | null {
  return useContext(BandOfferContext);
}

export type DomainBandKind = "signInToEdit" | "signInToJoin" | "addEmail" | null;

export function domainBandKind(access: DomainAccess | null, signedIn: boolean): DomainBandKind {
  if (access === null || access.joinSlug !== null) return null;
  if (signedIn) return "addEmail";
  return access.canEdit ? "signInToEdit" : "signInToJoin";
}

export function domainBandText(access: DomainAccess, signedIn: boolean, email: string | null): string {
  const at = `@${access.domain}`;
  if (!signedIn) {
    return access.canEdit
      ? `You can read this. Sign in with your ${at} email to edit it.`
      : `You can read this. Sign in with your ${at} email to join this workspace.`;
  }
  const who = email === null ? "You're signed in" : `You're signed in as ${email}`;
  return access.canEdit
    ? `${who}. To edit, add your ${at} email to your account.`
    : `${who}. To join this workspace, add your ${at} email to your account.`;
}

/** The band's sentence for a shared link, with or without a domain. */
export function readOnlyReasonFor(note: SharedNote, signedIn = false, email: string | null = null): string {
  if (note.domainAccess !== null && domainBandKind(note.domainAccess, signedIn) !== null) {
    return domainBandText(note.domainAccess, signedIn, email);
  }
  return note.openToAnyone
    ? "You're reading a shared link. Only people in this workspace can change it."
    : "This was shared with you to read.";
}

export function domainBandOffer(
  kind: DomainBandKind,
  handlers: { signIn: () => void; addEmail: () => void; switchAccount: () => void },
): BandOffer | null {
  if (kind === "signInToEdit" || kind === "signInToJoin") {
    return {
      signInInBand: true,
      actions: [
        {
          label: kind === "signInToEdit" ? "Sign in to edit" : "Sign in to join",
          onPress: handlers.signIn,
          testID: "share-domain-sign-in",
        },
      ],
    };
  }
  if (kind === "addEmail") {
    return {
      signInInBand: false,
      actions: [
        { label: "Add email", onPress: handlers.addEmail, testID: "share-domain-add-email" },
        { label: "Use another account", onPress: handlers.switchAccount, quiet: true, testID: "share-domain-switch" },
      ],
    };
  }
  return null;
}
