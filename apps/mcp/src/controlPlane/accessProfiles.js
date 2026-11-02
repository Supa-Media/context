/**
 * Display profiles (name, email, handle) for people a workspace object already
 * admitted (`POST /gateway/access/profiles`; `apps/convex/functions/accessProfiles.ts`).
 * Accounts stay in the control plane; who belongs where lives in the objects,
 * so only a workspace object asks, for its own member list, after checking the
 * reader is a member. Ids out, names back; no token crosses.
 */

const PROFILES_TIMEOUT_MS = 3_000;
const MAX_PROFILES = 200;

export function createAccessProfileMethods({ post }) {
  return {
    /**
     * `people`: `[{userId, personalWorkspaceId?}]` → a Map from userId to
     * `{name?, email?, handle?}`. A person the control plane does not know is
     * absent; a failed call throws, and the caller decides what to show.
     */
    async profilesFor(people) {
      const asked = (Array.isArray(people) ? people : []).slice(0, MAX_PROFILES);
      const found = new Map();
      if (asked.length === 0) return found;
      const parsed = await post("/gateway/access/profiles", { people: asked }, { timeoutMs: PROFILES_TIMEOUT_MS });
      for (const profile of Array.isArray(parsed?.profiles) ? parsed.profiles : []) {
        if (typeof profile?.userId !== "string") continue;
        found.set(profile.userId, {
          ...(typeof profile.name === "string" ? { name: profile.name } : {}),
          ...(typeof profile.email === "string" ? { email: profile.email } : {}),
          ...(typeof profile.handle === "string" ? { handle: profile.handle } : {}),
        });
      }
      return found;
    },
  };
}
