import { useState } from "react";
import { WelcomeChrome } from "./WelcomeScreen";
import { StorageStepBody } from "./steps/StorageStep";
import type { ManagedOffer } from "./useManagedOffer";
import type { PremiumStatus } from "../console/settings/panels/premium";

/**
 * The storage step, in a real browser, with the control plane replaced by
 * three `useState` calls.
 *
 * ## Why this exists rather than a mock of `useOnboarding`
 *
 * The three screens this covers are the ones somebody meets while deciding to
 * pay and just after paying, and every one of them is a *layout* — a card in a
 * row of cards, a toggle group over a price row, a step list under a pill.
 * jsdom lays nothing out, and `docs/decisions/testing.md` puts exactly that
 * class in `e2e/webkit`. But `/welcome` needs a session and a Convex
 * deployment, so the flow is on no browser-reachable screen at all.
 *
 * So the boundary is drawn where the components already have one: they take
 * props. `StorageStepBody` and everything under it are the shipping
 * components, unmodified; what is faked here is the conversation with billing
 * that `useManagedOffer` would be having. Nothing here can reach an account, a
 * bucket or a card — there is no backend behind it.
 *
 * Gated by `EXPO_PUBLIC_E2E_FIXTURE` at the route, exactly as the console
 * fixture is, and never present in a real export.
 */

/** A plan as `billing.status` would answer it for a context about to upgrade. */
const FIXTURE_STATUS: PremiumStatus = {
  status: "none",
  selected: { managedStorage: true, fastSearch: false },
  active: { managedStorage: false, fastSearch: false },
  canManage: true,
  configured: true,
  priceCents: 2000,
  currency: "usd",
  interval: "month",
  ceilingBytes: 50_000_000_000,
  storageIsManaged: false,
  managedStorageAvailable: true,
};

export function FirstRunStorageFixture({
  /** Where the walk starts, so a spec can open one screen directly. */
  start = "choose",
  /** Whether the deployment can offer managed storage at all. */
  available = true,
  /** Drop straight into the settling screen's later wording. */
  slow = false,
}: {
  start?: "choose" | "confirm" | "settling";
  available?: boolean;
  slow?: boolean;
}) {
  const [mode, setMode] = useState<"choose" | "confirm" | "settling">(start);
  const [selected, setSelected] = useState(FIXTURE_STATUS.selected);

  const managed: ManagedOffer = {
    available,
    price: "$20 a month",
    status: { ...FIXTURE_STATUS, selected },
    mode,
    session: "choosing",
    paid: mode === "settling",
    slow,
    choose: () => setMode("confirm"),
    back: () => setMode("choose"),
    toggle: (value, next) =>
      setSelected((current) => ({
        ...current,
        ...(value === "managedStorage" ? { managedStorage: next } : { fastSearch: next }),
      })),
    proceed: () => setMode("settling"),
  };

  return (
    <WelcomeChrome step="storage" shape={{ storage: "connected" }}>
      <StorageStepBody
        connectState={{ kind: "idle" }}
        workspaceId="fixture-workspace"
        contextName="@seyi"
        connect={async () => ({ status: "ok" })}
        managed={managed}
        storageReady={false}
        onSkip={() => {}}
        onContinuePast={() => {}}
      />
    </WelcomeChrome>
  );
}
