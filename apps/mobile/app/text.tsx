import { Screen } from "../features/app/Screen";
import { texLaunchColors } from "../features/design/tokens/landingColors";
import { TexText } from "../features/tex/launch/TexText";

/**
 * `/text`: tex.lc's page for somebody signed in, "Text Tex." with the number
 * and the console under it. Not under `(app)`: it is Tex's page, not the
 * console's, and it sends a signed-out visitor to sign in itself. See
 * `TexText.web.tsx`.
 */
export default function TextRoute() {
  return (
    <Screen style={{ backgroundColor: texLaunchColors.page }}>
      <TexText />
    </Screen>
  );
}
