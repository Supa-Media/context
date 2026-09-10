import { Redirect, useLocalSearchParams } from "expo-router";
import { CHECKOUT_PARAM, checkoutOutcomeFrom } from "@context/shared";
import { E2EFixtureScreen } from "../features/console/E2EFixtureScreen";

/**
 * `/e2e-fixture` — the console on demo data, editable, for `apps/mobile/e2e/webkit` alone.
 *
 * Gated on `EXPO_PUBLIC_E2E_FIXTURE`, an `EXPO_PUBLIC_*` var and therefore
 * inlined at **export** time, not read at request time — so the only way this
 * ever renders anything is a build that deliberately set it. Every real export
 * (`deploy-web.yml`, `deploy-mobile-native.yml`, `deploy-mobile-update.yml`,
 * a laptop's `expo start`) leaves it unset, and this route redirects to `/`
 * exactly as if it did not exist. Only the `Editor in WebKit` CI job
 * (`.github/workflows/ci.yml`) sets it, on its own throwaway export, never
 * shipped anywhere.
 *
 * The flag decides *whether this route can render at all* rather than
 * anything about the data on it — the fixture itself is `useDemoConsoleData`
 * with three capability flags flipped (`e2eFixtureData.ts`), the same
 * literals the landing page already ships to every visitor. Nothing this
 * screen can do reaches a customer's bucket: there is no bucket behind it.
 */
export default function E2EFixtureRoute() {
  /*
    `?checkout=done` — the state somebody is in the instant they come back from
    a payment, which the real console reads off the same parameter in
    `(app)/console/_layout.tsx`. Read here rather than inside the screen for
    the reason the panel gives: the leaf must not need a router.
  */
  const params = useLocalSearchParams<{ checkout?: string | string[] }>();
  const raw = params[CHECKOUT_PARAM];
  const returned = checkoutOutcomeFrom(Array.isArray(raw) ? raw[0] : raw);
  if (process.env.EXPO_PUBLIC_E2E_FIXTURE !== "1") return <Redirect href="/" />;
  return <E2EFixtureScreen returned={returned} />;
}
