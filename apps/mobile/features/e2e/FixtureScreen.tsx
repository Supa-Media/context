import { CollaborationFixture } from "./collaboration/Fixture";
import { CHECKOUT_PARAM, checkoutOutcomeFrom } from "@context/shared";
import { AppFrameFixture } from "./AppFrameFixture";
import { DomainFixture } from "./DomainFixture";
import { AppFrameVisualFixture } from "./AppFrameVisualFixture";
import { ResumeFixture, isResumeSurface } from "./ResumeFixture";
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
  /**
   * `screen=collaboration`: which note. `screen=resume&surface=menu`: `0` draws
   * the console with no meeting note open.
   */
  note?: string | string[];
  user?: string | string[];
  checkout?: string | string[];
  screen?: string | string[];
  /**
   * Which of the visual board's optional surfaces to draw.
   *
   * `panel=meetings` opens the console's right panel on Meetings with a
   * recording running, which is the one state of it worth reviewing and the
   * one no board could show while the panel defaulted shut. Off by default
   * because the artboards this fixture is compared against draw the console
   * with the panel closed, and a fixture that changes the resting state is
   * reviewing a screen the design does not have.
   */
  panel?: string | string[];
  at?: string | string[];
  /** `screen=domain`: which website switch state to draw above the domain card. */
  site?: string | string[];
  slow?: string | string[];
  failed?: string | string[];
  available?: string | string[];
  /** `screen=resume`: which Resume surface to draw. See `ResumeFixture`. */
  surface?: string | string[];
}

/** Expo hands a repeated query parameter back as an array. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function FixtureScreen({ params }: { params: FixtureParams }) {
  if (first(params.screen) === "collaboration") return <CollaborationFixture user={first(params.user)} note={first(params.note)} />;
  if (first(params.screen) === "vault-import") return <VaultImportFixture />;
  if (first(params.screen) === "domain") return <DomainFixture at={first(params.at)} site={first(params.site)} />;

  /*
    The application frame, which is otherwise on no browser-reachable screen
    either — `E2EFixtureScreen` reproduces the console's panes and says in its
    own header that it does not reproduce `AppFrame`. The folding panels are all
    layout claims, which is the one class jsdom cannot check.
  */
  if (first(params.screen) === "app-frame") return <AppFrameFixture />;
  // The same frame with real contents, for looking at. See its own header for
  // why it is a separate screen rather than a flag on the one above.
  if (first(params.screen) === "app-frame-visual") {
    return <AppFrameVisualFixture panel={first(params.panel) === "meetings"} />;
  }

  // Every surface that offers a stopped meeting back. See its own header.
  if (first(params.screen) === "resume") {
    const surface = first(params.surface);
    return (
      <ResumeFixture
        surface={isResumeSurface(surface) ? surface : "menu"}
        noteOpen={first(params.note) !== "0"}
      />
    );
  }

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
