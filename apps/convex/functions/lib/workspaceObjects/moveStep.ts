/**
 * The one next step that moves a workspace onto its workspace object, from what its record says (decided by the
 * owner, 2026-11-20: "move everything to a durable object, unless they are bringing their own storage";
 * `docs/decisions/storage-and-credentials/workspace-objects.md`, "Every workspace is moved on its own").
 *
 * Each switch goes the way the hand-run workflows took the first workspaces: armed (`dual`, every save mirrored),
 * copied whole, compared, and only a clean comparison flips it. Nothing here forces a switch, so a step that cannot
 * prove the copy leaves the workspace where it was, still read from the control plane and bucket.
 *
 * Order: notes first (the object then holds the rows and texts), then access (members and invites, and a personal
 * workspace's person), then a personal workspace's texting, which the person object opens only once its access is
 * there (`textingObjects.markPushed`).
 */

export type Storage = "none" | "own" | "managed";
export type NotesHome = "bucket" | "dual" | "object";
export type AccessHome = "convex" | "dual" | "object";

export interface MoveFacts {
  /** Gone workspaces are not moved. */
  exists: boolean;
  storage: Storage;
  personal: boolean;
  /** Whether a personal workspace has its one owner, whose person scope its object holds. */
  hasPerson: boolean;
  notes: NotesHome;
  access: AccessHome;
  personAccess: AccessHome;
  texting: "convex" | "object";
}

export type MoveStep =
  | { step: "skip"; why: "gone" | "no_storage" | "own_storage" }
  | { step: "notes_arm" }
  | { step: "notes_copy_check" }
  | { step: "access_arm" }
  | { step: "access_copy_check" }
  | { step: "texting_push" }
  | { step: "done" };

/** The scopes an access step covers: a workspace's members, and a personal workspace's person. */
export function accessHomes(facts: MoveFacts): AccessHome[] {
  return facts.personal && facts.hasPerson ? [facts.access, facts.personAccess] : [facts.access];
}

export function nextMoveStep(facts: MoveFacts): MoveStep {
  if (!facts.exists) return { step: "skip", why: "gone" };
  // A workspace on a bucket of its own stays there (owner, 2026-11-20). One with no storage has nothing to move yet:
  // it is moved once its bucket is made (`managedProvisioningFns/complete.ts`).
  if (facts.storage === "none") return { step: "skip", why: "no_storage" };
  if (facts.storage === "own") return { step: "skip", why: "own_storage" };
  if (facts.notes === "bucket") return { step: "notes_arm" };
  if (facts.notes === "dual") return { step: "notes_copy_check" };
  const access = accessHomes(facts);
  if (access.includes("convex")) return { step: "access_arm" };
  if (access.includes("dual")) return { step: "access_copy_check" };
  if (facts.personal && facts.hasPerson && facts.texting !== "object") return { step: "texting_push" };
  return { step: "done" };
}

/** Whether a workspace is wholly on its object: what the census counts as moved. */
export function isMoved(facts: MoveFacts): boolean {
  return nextMoveStep(facts).step === "done";
}
