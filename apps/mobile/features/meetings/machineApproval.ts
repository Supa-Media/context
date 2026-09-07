/**
 * Whether this page should mint the machine's grant, as a pure function.
 *
 * The owner's reaction to the first end-to-end desktop capture, 2026-09-07:
 * *"I don't love this setup; when installing Granola I didn't have to 'connect'
 * a machine, things just worked."* He was signed in **in this window** and the
 * app still put an approve screen in front of him.
 *
 * So the shell hands this page the parked authorization request it just made,
 * over the bridge, and this decides whether to answer it with the session the
 * page already holds. `apps/desktop/src/core/shell/autoGrant.ts` is the other
 * half and `docs/decisions/desktop.md` is the argument.
 *
 * ## Why this is a function and not three `if`s in a component
 *
 * `features/console/capabilities.ts` records the rule in one line: *every guard
 * expressed inside a component in this app was held by nothing.* This one
 * decides whether a page mints a credential, so it is decided where a test can
 * reach it — and `ThisMachineCard` renders what it returns.
 *
 * ## This page reversing a sentence in `docs/decisions/desktop.md`
 *
 * That file's #312 section says, of the approval moving into the shell's
 * window: *"Nothing in `apps/mobile` learned that it is inside the shell."*
 * This file is that sentence being reversed on purpose, and the reversal is
 * bounded to what a screen cannot do without knowing: the consent screen is
 * **unchanged**, has no shell branch, and is still what every other client and
 * every refusal here goes through. What learned about the shell is this card,
 * which only exists inside the shell in the first place.
 */

import type { ConnectionView, PendingMachineApproval } from "@context/desktop-bridge";

/** What the page knows when it decides. */
export interface MachineApprovalInputs {
  /** The parked request the shell handed over, or `null` for none in flight. */
  pending: PendingMachineApproval | null;
  /** The shell's own view of its grant. */
  connection: ConnectionView | null;
  /** `useConvexAuth`, as it reports itself. */
  auth: { isLoading: boolean; isAuthenticated: boolean };
  /** True while a mint this page started has not answered yet. */
  minting: boolean;
  /** A request this page already answered, so it answers each one once. */
  answered: string | null;
}

export type MachineApprovalAction =
  /** Nothing to do. */
  | { kind: "idle" }
  /** Call `approveOwnMachineGrant` with this request id. */
  | { kind: "mint"; requestId: string }
  /**
   * Tell the shell this page cannot: it is signed out.
   *
   * Not a failure and not an error on the glass — the shell answers it by
   * showing #312's approve screen, which begins with the console's own sign-in
   * when there is no session. A person who is signed out is exactly the person
   * that screen was written for.
   */
  | { kind: "declineSignedOut"; requestId: string };

/**
 * What this page should do about the approval the shell is holding.
 *
 * Every condition is a *refusal to act*, never a refusal of the person:
 *
 *  - **no pending request** — the ordinary state of this app;
 *  - **auth still resolving** — deciding now would answer "signed out" for
 *    somebody who is signed in, and that costs them a screen they did not need;
 *  - **already answered, or already minting** — a request is answered once. A
 *    card that re-mints on every re-render would mint a machine grant per
 *    render, which is what the control plane's rate limit would then be
 *    protecting the person from rather than an attacker;
 *  - **already connected** — the shell has a grant; there is nothing to mint,
 *    and a stale pending push is not a reason to make a second one.
 */
export function decideMachineApproval(inputs: MachineApprovalInputs): MachineApprovalAction {
  const pending = inputs.pending;
  if (pending === null) return { kind: "idle" };
  if (inputs.minting) return { kind: "idle" };
  if (inputs.answered === pending.requestId) return { kind: "idle" };
  if (inputs.auth.isLoading) return { kind: "idle" };
  if (inputs.connection !== null && inputs.connection.state === "connected") {
    return { kind: "idle" };
  }
  if (!inputs.auth.isAuthenticated) {
    return { kind: "declineSignedOut", requestId: pending.requestId };
  }
  return { kind: "mint", requestId: pending.requestId };
}

/**
 * The line the card shows while this page is minting, and after it did.
 *
 * `null` when there is nothing of this page's own to say, which is every
 * ordinary moment — `describeMachine` owns the card's sentence and this is one
 * line under it, about a thing that is happening right now.
 *
 * The failure line deliberately does not name what the control plane refused.
 * Every refusal ends the same way for the person — the approve screen opens in
 * this window a moment later — so a sentence explaining which condition failed
 * would be a sentence about machinery, in front of somebody who is about to be
 * asked a question instead.
 */
export function machineApprovalLine(
  state: "minting" | "granted" | "refused",
  contextName: string | null,
): string | null {
  switch (state) {
    case "minting":
      return "Connecting this machine to your context…";
    case "granted":
      return contextName === null
        ? "This machine can write to your context."
        : `This machine can write to @${contextName}.`;
    case "refused":
      return "Asking you to approve this machine instead…";
  }
}
