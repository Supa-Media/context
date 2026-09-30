import { useEffect } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import type { WebsiteStateView } from "@context/shared";
import { useWebsite } from "../website/useWebsite";
import { premiumPill, premiumStateOf, type PremiumStatus } from "./panels/premium";
import { usePremium } from "./panels/usePremium";

/**
 * The two row values that live in a subscription rather than on `ConsoleData`:
 * Plan and Website. `previews.ts` leaves both `null` and says why — hoisting
 * them onto every console load to decorate a row — so they are read here, only
 * while the settings list is open, by a component the list mounts where there
 * is a client to subscribe with.
 */
export interface LiveRowValues {
  premium?: string | null;
  website?: string | null;
}

/**
 * The Plan row: the pill the section itself shows. `null` before the status
 * lands and for a status this build does not know — never "Free" out of an
 * absence, for the reason `premiumStateOf` gives.
 */
export function planRowValue(status: PremiumStatus | null): string | null {
  if (status === null) return null;
  return premiumPill(premiumStateOf(status.status), status.canManage)?.label ?? null;
}

/** The Website row: On or Off, and nothing until the server has answered. */
export function websiteRowValue(state: WebsiteStateView | undefined): string | null {
  if (state === undefined) return null;
  return state.state === "enabled" ? "On" : "Off";
}

/** The subscribing half. Renders nothing; reports what it read. */
export function LiveRowValueSource({
  workspaceId,
  onValues,
}: {
  workspaceId: string;
  onValues: (next: LiveRowValues) => void;
}) {
  const premium = usePremium({ workspaceId: workspaceId as Id<"workspaces"> });
  const website = useWebsite(workspaceId);
  const plan = planRowValue(premium.status);
  const site = websiteRowValue(website.state);
  useEffect(() => {
    onValues({ premium: plan, website: site });
  }, [plan, site, onValues]);
  return null;
}
