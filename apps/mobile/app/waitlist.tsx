import { Screen } from "../features/app/Screen";
import { texLaunchColors } from "../features/design/tokens/landingColors";
import { TexStatus } from "../features/tex/launch/TexStatus";

/**
 * `/waitlist`: where somebody who joined the waitlist stands, read with the
 * receipt their browser was handed at joining. Not under `(app)`: the person
 * has no account yet, and nothing here needs one. See `TexStatus.web.tsx`.
 * On the page's own paper, clear of a phone's notch when saved to a home screen.
 */
export default function WaitlistRoute() {
  return (
    <Screen style={{ backgroundColor: texLaunchColors.page }}>
      <TexStatus />
    </Screen>
  );
}
