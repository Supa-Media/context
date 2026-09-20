import { Redirect, useLocalSearchParams } from "expo-router";
import { FixtureScreen, type FixtureParams } from "../features/e2e/FixtureScreen";

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
 * anything about the data on it — the fixtures themselves are
 * `useDemoConsoleData` with three capability flags flipped
 * (`e2eFixtureData.ts`) and a first-run step driven by `useState`, both of
 * which are the same literals the landing page already ships to every visitor.
 * Nothing this screen can do reaches a customer's bucket: there is no bucket
 * behind it.
 *
 * Which fixture, and how it is configured, is `FixtureScreen`'s: a route file
 * reads the URL and mounts something, and holds no logic of its own.
 */
export default function E2EFixtureRoute() {
  const params = useLocalSearchParams() as FixtureParams;
  if (process.env.EXPO_PUBLIC_E2E_FIXTURE !== "1") return <Redirect href="/" />;
  return <FixtureScreen params={params} />;
}
