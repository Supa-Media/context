import { CHECKOUT_PARAM, checkoutOutcomeFrom } from "@context/shared";
import { AppFrameFixture } from "./AppFrameFixture";
import { AppFrameVisualFixture } from "./AppFrameVisualFixture";
import { E2EFixtureScreen } from "../console/E2EFixtureScreen";
import { FirstRunStorageFixture } from "../onboarding/FirstRunStorageFixture";
import { VaultImportFixture } from "../onboarding/VaultImportFixture";

/**
 * Which fixture `/e2e-fixture` is showing, decided off the query.
 *
 * In `features/` rather than in the route, because the route may not hold
 * logic — `@supa-media/route-file-no-logic`, which counts lines and was right
 * to count these. The route reads the URL and hands the parameters here; this
 * decides what to mount.
 *
 * **One route with a parameter, not two routes.** `app/e2e-fixture.tsx` and an
 * `app/e2e-fixture/` directory would be a routing conflict, and the
 * framework's own guardrails fail the build for it.
 */
export interface FixtureParams {
  checkout?: string | string[];
  screen?: string | string[];
  at?: string | string[];
  slow?: string | string[];
  failed?: string | string[];
  available?: string | string[];
}

/** Expo hands a repeated query parameter back as an array. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function FixtureScreen({ params }: { params: FixtureParams }) {
  if (first(params.screen) === "vault-import") return <VaultImportFixture />;

  /*
    The application frame, which is otherwise on no browser-reachable screen
    either — `E2EFixtureScreen` reproduces the console's panes and says in its
    own header that it does not reproduce `AppFrame`. The folding panels are all
    layout claims, which is the one class jsdom cannot check.
  */
  if (first(params.screen) === "app-frame") return <AppFrameFixture />;
  // The same frame with real contents, for looking at. See its own header for
  // why it is a separate screen rather than a flag on the one above.
  if (first(params.screen) === "app-frame-visual") return <AppFrameVisualFixture />;

  /*
    The storage step, which is otherwise on no browser-reachable screen:
    `/welcome` needs a session and a deployment, and the three screens behind
    that step are all layouts — the one class jsdom cannot check.
  */
  if (first(params.screen) === "first-run-storage") {
    const at = first(params.at);
    return (
      <FirstRunStorageFixture
        start={at === "confirm" || at === "settling" ? at : "choose"}
        available={first(params.available) !== "no"}
        slow={first(params.slow) === "yes"}
        failed={first(params.failed) === "yes"}
      />
    );
  }

  // The console, and whatever a return from Stripe said on the way in.
  return <E2EFixtureScreen returned={checkoutOutcomeFrom(first(params[CHECKOUT_PARAM]))} />;
}
