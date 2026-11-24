/**
 * The made-up people of the Lab's made-up group chats (`functions/texLabWorld.ts`), made only on a preview: each
 * account's email is at this domain, which no mail reaches (`.invalid`, RFC 2606), so nobody can sign in as one.
 * A preview's persona seed counts them as its own fixtures (`personaSeed.ts`): reseeding a preview a made-up chat
 * used removes them from the seeded workspaces instead of refusing to reset them.
 */
export const LAB_WORLD_EMAIL_DOMAIN = "lab-world.invalid";

export function isLabWorldEmail(email: string | undefined | null): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith(`@${LAB_WORLD_EMAIL_DOMAIN}`);
}
