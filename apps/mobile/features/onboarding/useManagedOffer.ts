import { useCallback, useEffect, useMemo, useState } from "react";
import { useConvex, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import type { CheckoutOutcome } from "@context/shared";
import { leaveTo } from "../consent/leave";
import {
  formatPrice,
  managedFailureCopy,
  type PremiumEntitlements,
  type PremiumSession,
  type PremiumStatus,
} from "../console/settings/panels/premium";
import type { ManagedConfirmState } from "./steps/ManagedConfirm";

/**
 * The Context-managed answer on the storage step, wired to the control plane.
 *
 * Kept out of `useOnboarding` deliberately. That hook is already the longest
 * file in this folder and its own header says it holds "as little judgement as
 * possible"; this is a self-contained conversation with billing that the first
 * run and Settings both host, and a person who never presses the managed card never
 * subscribes to any of it.
 *
 * ## What it will not do
 *
 * **It does not offer what cannot be delivered.** `available` is
 * `billing.status.managedStorageAvailable` — a price to charge *and* somewhere
 * to put the bucket — and the card is absent rather than disabled when it is
 * false. Taking $20 for storage that cannot be created is the worst failure
 * this flow has, because it happens after the payment.
 *
 * ## Why a checkout is two round trips
 *
 * `startCheckout` returns the id of a `billingSessions` row, not a URL.
 * Minting the URL needs the payment key, only an action may open a credential,
 * and a public function that awaited one would be the violation
 * `apps/convex/__tests__/structure.test.ts` exists to catch. So the mutation
 * schedules the minting action and this subscribes to the row it was handed.
 * When the URL lands, the person presses again and leaves — `usePremium` makes
 * the same trip from settings, for the same reason.
 *
 * ## Coming back
 *
 * Stripe returns to the recorded origin, either welcome or Settings, using a path built by
 * `@context/shared` from the origin recorded on the session row, so first run
 * comes back to first run rather than to a console with no storage in it. The
 * screen then follows three facts the control plane reports: the plan turning
 * active, a storage binding appearing, and whether provisioning gave up. The
 * third is the one that matters — without it a person whose bucket was never
 * going to appear sits in front of a spinner until they give up.
 */

/** How long before "a few seconds" stops being true. */
export const SETTLING_SLOW_MS = 25_000;

export interface ManagedOffer {
  /** Whether this deployment can provide managed storage at all. */
  available: boolean;
  /** `$20 a month`, from the same config the checkout charges. */
  price: string;
  /** The plan as the control plane reports it, or `null` before it answers. */
  status: PremiumStatus | null;
  /** Which of the three screens the storage step is drawing. */
  mode: "choose" | "confirm" | "settling";
  /** Where the attempt to open Stripe has got to. */
  session: ManagedConfirmState;
  /** Our sentence for a failure opening Stripe, never Stripe's own. */
  failure?: string;
  /**
   * Provisioning reported that the bucket will not appear.
   *
   * Separate from `failure` above, which is about opening a payment page —
   * these are different moments with different next steps, and a person who
   * has *paid* and has no storage is owed the second one specifically.
   */
  provisionFailure?: { title: string; body: string; canRetry: boolean };
  /** The plan has turned active. */
  paid: boolean;
  /** The wait has stopped being ordinary. */
  slow: boolean;
  choose: () => void;
  back: () => void;
  toggle: (value: string, next: boolean) => void;
  /** Ask for a URL, then — once there is one — leave for it. */
  proceed: () => void;
  /** Another go at making the bucket. Safe: the run adopts what it made before. */
  retry: () => void;
}

export function useManagedOffer(options: {
  workspaceId: Id<"workspaces"> | null;
  /** What the return from Stripe said, from `/welcome?checkout=…`. */
  returned: CheckoutOutcome | null;
  /** Determines whether Stripe returns to onboarding or Settings. */
  origin?: "onboarding" | "settings";
  /** Test seam, so the slow copy does not need a real half-minute. */
  slowAfter?: number;
}): ManagedOffer {
  const convex = useConvex();
  const { workspaceId, returned, origin = "onboarding", slowAfter = SETTLING_SLOW_MS } = options;
  const [mode, setMode] = useState<"choose" | "confirm" | "settling">(
    // A person who has just come back from Stripe is not choosing anything.
    returned === "done" ? "settling" : "choose",
  );
  const [sessionId, setSessionId] = useState<Id<"billingSessions"> | null>(null);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [opening, setOpening] = useState(false);
  const [slow, setSlow] = useState(false);

  /*
    `api.…` is reached for inside the memo and never in the dependency array:
    it is a proxy that mints a fresh object on every access, and one in a dep
    array re-renders forever. `usePremium` makes the same note.
  */
  const spec = useMemo<RequestForQueries>(() => {
    const requests: RequestForQueries = {};
    if (workspaceId !== null) {
      requests.status = { query: api.functions.billing.status, args: { workspaceId } };
    }
    if (sessionId !== null) {
      requests.session = {
        query: api.functions.billing.billingSession,
        args: { sessionId },
      };
    }
    return requests;
  }, [workspaceId, sessionId]);
  const results = useQueries(spec);

  const raw = results.status;
  const status =
    raw !== undefined && !(raw instanceof Error) && raw !== null ? (raw as PremiumStatus) : null;
  const rawSession = results.session;
  const session =
    rawSession !== undefined && !(rawSession instanceof Error) && rawSession !== null
      ? (rawSession as PremiumSession)
      : null;

  // The settling wait, which stops being ordinary after a while. Only armed
  // where there is something to wait for, and cleared on the way out.
  useEffect(() => {
    if (mode !== "settling") return undefined;
    const handle = setTimeout(() => setSlow(true), slowAfter);
    return () => clearTimeout(handle);
  }, [mode, slowAfter]);

  const choose = useCallback(() => {
    setFailure(undefined);
    setMode("confirm");
    /*
      Pressing the card *is* choosing managed storage, so the selection is
      written on the way in rather than left to a tick box the person has
      already ticked by pressing. Fast search is theirs to add and is not
      assumed: the price is the same either way, and choosing it for them
      would be choosing where a copy of their notes lives.
    */
    if (workspaceId === null) return;
    void convex
      .mutation(api.functions.billing.setEntitlements, {
        workspaceId,
        managedStorage: true,
        fastSearch: false,
      })
      .catch(() => setFailure("That did not go through. Check your connection and try again."));
  }, [convex, workspaceId]);

  const back = useCallback(() => {
    setFailure(undefined);
    setMode("choose");
  }, []);

  const toggle = useCallback(
    (value: string, next: boolean) => {
      if (workspaceId === null || status === null) return;
      const chosen: PremiumEntitlements = { ...status.selected };
      if (value === "managedStorage") chosen.managedStorage = next;
      if (value === "fastSearch") chosen.fastSearch = next;
      void convex
        .mutation(api.functions.billing.setEntitlements, {
          workspaceId,
          managedStorage: chosen.managedStorage,
          fastSearch: chosen.fastSearch,
        })
        .catch(() => setFailure("That did not go through. Check your connection and try again."));
    },
    [convex, status, workspaceId],
  );

  const proceed = useCallback(() => {
    if (workspaceId === null) return;
    // Second press, once there is a page: this is the one that leaves.
    if (session?.status === "ready" && session.url !== undefined) {
      leaveTo(session.url);
      return;
    }
    setOpening(true);
    setFailure(undefined);
    void convex
      .mutation(api.functions.billing.startCheckout, { workspaceId, origin })
      .then((started) => setSessionId(started.sessionId))
      .catch(() =>
        // Our sentence, never the backend's: a Convex error can carry a
        // function path, and somebody about to pay is owed the next step.
        setFailure("That did not go through. Check your connection and try again."),
      )
      .finally(() => setOpening(false));
  }, [convex, origin, session, workspaceId]);

  const retry = useCallback(() => {
    if (workspaceId === null) return;
    void convex
      .mutation(api.functions.managedProvisioning.retryManagedProvisioning, { workspaceId })
      .catch(() => setFailure("That did not go through. Check your connection and try again."));
  }, [convex, workspaceId]);

  const sessionState: ManagedConfirmState =
    session?.status === "failed"
      ? "failed"
      : session?.status === "ready"
        ? "ready"
        : opening || session?.status === "pending"
          ? "opening"
          : "choosing";

  return {
    available: status?.managedStorageAvailable === true,
    price: status === null ? "" : formatPrice(status),
    status,
    mode,
    session: sessionState,
    failure:
      failure ??
      (session?.status === "failed"
        ? "That did not go through. Nothing has been charged — try again."
        : undefined),
    paid: status?.status === "active",
    provisionFailure:
      status?.managedProvisioning === "failed"
        ? managedFailureCopy(status.managedProvisioningError)
        : undefined,
    slow,
    choose,
    back,
    toggle,
    proceed,
    retry,
  };
}
