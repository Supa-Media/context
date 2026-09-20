import { useCallback, useMemo, useState } from "react";
import { useConvex, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import {
  shouldReadPremium,
  type PremiumEntitlements,
  type PremiumSession,
  type PremiumStatus,
  type PremiumView,
} from "./premium";

/**
 * The Premium section, wired to the control plane.
 *
 * `billing.status` is readable by any member and answers `canManage` itself,
 * so this subscribes for everybody and lets the server decide who is offered a
 * control — the same shape `useFastSearch` has, and deliberately not
 * `useIngestionSettings`'s, whose read is owner-only because an allow-list is
 * an owner's correspondent list.
 *
 * `useQueries` rather than `useQuery`, for the reason `useLiveConsoleData`
 * gives at length: a failed `useQuery` re-throws during render, and a settings
 * panel must not be able to take the console down. A thrown status here is
 * `null` — the section draws its loading line and nothing claims a state.
 *
 * ## Why a checkout is two round trips
 *
 * `startCheckout` returns the id of a `billingSessions` row, not a URL. Minting
 * the URL needs the payment key, only an action may open a credential, and a
 * public function that awaited one would be the violation
 * `apps/convex/__tests__/structure.test.ts` exists to catch — so the mutation
 * schedules the minting action and this subscribes to the row it was handed.
 * When the URL lands, the caller opens it; the payment UI deliberately leaves
 * the app.
 */
export function usePremium(options: {
  workspaceId: Id<"workspaces"> | null;
}): PremiumView {
  const convex = useConvex();
  const { workspaceId } = options;
  const asking = shouldReadPremium({ workspaceId });
  const [sessionId, setSessionId] = useState<Id<"billingSessions"> | null>(
    null,
  );

  // The spec may be empty, which is what lets this subscribe conditionally
  // without a conditional hook. `api.…` is reached for inside the memo and
  // never in the dependency array — it is a proxy that mints a fresh object on
  // every access, and one in a dep array re-renders the console forever.
  const spec = useMemo<RequestForQueries>(() => {
    const requests: RequestForQueries = {};
    if (asking && workspaceId !== null) {
      requests.status = {
        query: api.functions.billing.status,
        args: { workspaceId },
      };
    }
    if (sessionId !== null) {
      requests.session = {
        query: api.functions.billing.billingSession,
        args: { sessionId },
      };
    }
    return requests;
  }, [asking, workspaceId, sessionId]);

  const results = useQueries(spec);
  const raw = results.status;
  const answered = raw !== undefined && !(raw instanceof Error) && raw !== null;
  const status = answered ? (raw as PremiumStatus) : null;
  const canManage = status !== null && status.canManage;

  const choose = useCallback(
    async (next: PremiumEntitlements) => {
      if (workspaceId === null) return;
      await convex.mutation(api.functions.billing.setEntitlements, {
        workspaceId,
        managedStorage: next.managedStorage,
        fastSearch: next.fastSearch,
      });
    },
    [convex, workspaceId],
  );

  const upgrade = useCallback(async () => {
    if (workspaceId === null) return;
    if (status?.isTestAccount === true) {
      await convex.mutation(api.functions.billing.activateTestPremium, {
        workspaceId,
      });
      return;
    }
    const started = await convex.mutation(api.functions.billing.startCheckout, {
      workspaceId,
    });
    setSessionId(started.sessionId);
  }, [convex, status?.isTestAccount, workspaceId]);

  const manageBilling = useCallback(async () => {
    if (workspaceId === null) return;
    const started = await convex.mutation(api.functions.billing.startPortal, {
      workspaceId,
    });
    setSessionId(started.sessionId);
  }, [convex, workspaceId]);

  const retryManagedStorage = useCallback(async () => {
    if (workspaceId === null) return;
    await convex.mutation(
      api.functions.managedProvisioning.retryManagedProvisioning,
      {
        workspaceId,
      },
    );
  }, [convex, workspaceId]);

  const deleteTestWorkspace = useCallback(async () => {
    if (workspaceId === null) return;
    await convex.mutation(api.functions.account.deleteTestWorkspace, {
      workspaceId,
    });
  }, [convex, workspaceId]);

  const rawSession = results.session;
  const session =
    rawSession !== undefined &&
    !(rawSession instanceof Error) &&
    rawSession !== null
      ? (rawSession as PremiumSession)
      : null;

  return {
    status,
    // A query that threw is not "still loading" — the section says so once
    // rather than spinning at somebody forever.
    loading: asking && raw === undefined,
    session,
    // Absent, never disabled: the mutations are owner-only and the server
    // re-checks, so a member is offered nothing rather than a refusal.
    choose: canManage ? choose : undefined,
    upgrade: canManage ? upgrade : undefined,
    manageBilling: canManage ? manageBilling : undefined,
    retryManagedStorage: canManage ? retryManagedStorage : undefined,
    deleteTestWorkspace:
      canManage && status?.isTestAccount === true
        ? deleteTestWorkspace
        : undefined,
  };
}
