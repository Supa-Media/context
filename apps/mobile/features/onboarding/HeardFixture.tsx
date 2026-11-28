import { WelcomeChrome } from "./WelcomeScreen";
import { NameStep } from "./steps/NameStep";
import { HeardChipsView } from "./steps/HeardChips";
import { nameStatus } from "./name";
import type { OnboardingController } from "./useOnboarding";

/**
 * The handle screen with "How did you hear about us?" under Claim, in a real
 * browser, with no server behind it: `/welcome` needs a session and a
 * deployment. `heard=0` draws it as it was before the row (the boards'
 * "Before"). Gated by `EXPO_PUBLIC_E2E_FIXTURE` at the route, like every
 * fixture.
 */
export function HeardFixture({ shown }: { shown: boolean }) {
  const controller = {
    step: "name",
    shape: {},
    name: "maya",
    setName: () => {},
    nameStatus: nameStatus("maya", { available: true, normalized: "maya" }),
    claiming: false,
    claimFailure: null,
    claim: async () => {},
    canClaim: true,
  } as unknown as OnboardingController;
  return (
    <WelcomeChrome step="name" shape={{}}>
      <NameStep controller={controller} heard={shown ? <HeardChipsView answered={null} onAnswer={async () => true} /> : null} />
    </WelcomeChrome>
  );
}
