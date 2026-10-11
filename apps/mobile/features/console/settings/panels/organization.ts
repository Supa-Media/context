/**
 * What Settings › Sharing › Your organization says (boards s3/s4). The rules
 * are the server's (`apps/convex/functions/workspaceDomains.ts`); these are
 * only the words, kept here so they can be read and tested without a screen.
 */

export type DomainRole = "member" | "editor";
export type OfferStatus = "ok" | "added" | "personal";

export const ORGANIZATION_INTRO =
  "People with these emails join when they open a link to this workspace. If they stop signing in with that email, they leave.";

export const ROLE_LABELS: Record<DomainRole, string> = { member: "Can read", editor: "Can edit" };

export function domainTitle(domain: string): string {
  return `Anyone with a @${domain} email`;
}

export function joinedLine(joined: number, enabled: boolean): string {
  const count = joined === 0 ? "Nobody has joined this way yet" : joined === 1 ? "1 person joined this way" : `${joined} people joined this way`;
  return enabled ? count : `Off. ${count}.`;
}

export function offerLine(status: OfferStatus, email: string): string {
  switch (status) {
    case "ok":
      return `You sign in with ${email}`;
    case "added":
      return "Already added";
    case "personal":
      return "Personal email services can't be added";
  }
}

export const NO_OFFER =
  "Add a work email in Settings › Account first. You can only open this workspace to a domain you sign in with.";

/** What a joining person is told, once, on the note they opened. */
export function joinedNotice(name: string, domain: string): string {
  return `You joined ${name} because your email ends in ${domain}.`;
}
