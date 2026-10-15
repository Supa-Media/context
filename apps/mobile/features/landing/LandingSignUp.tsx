import { useRef, useState } from "react";
import { useRouter } from "expo-router";
import { ThemeProvider } from "../design/theme";
import { JoinCard, useHomeJoin } from "../auth/JoinCard";
import { landAfterSignIn } from "../auth/landing";
import { PhoneSignInForm } from "../auth/PhoneSignInForm";
import { CONSOLE_ROUTE } from "../auth/redirect";
import { usePhoneSignIn } from "../auth/usePhoneSignIn";

/**
 * The landing pages' sign-up: the sign-in page's own, phone first (Dev2,
 * 2026-10-09: "waitlist etc will have to change to phone number"). A number
 * an account holds signs in with a texted code, any other joins the waitlist
 * in place, and "Use email instead" swaps in the homepage's email card. No
 * copy of its own: whatever those two say, this says. Its heading is a level
 * below the page's one sentence.
 *
 * Pinned to the light palette: the landing pages are light only, and a reader
 * whose app is dark otherwise got a black field, a pale teal button and a
 * heading drawn in near-white on paper (Dev2, 2026-10-12: "looks awful").
 */
export function LandingSignUp() {
  const router = useRouter();
  const replace = (href: string) => router.replace(href as never);
  const [mode, setMode] = useState<"phone" | "email">("phone");
  const phone = usePhoneSignIn({
    onSignedIn: () => landAfterSignIn(CONSOLE_ROUTE, replace),
    onUnavailable: () => setMode("email"),
  });
  const email = useHomeJoin({ replace });
  const answered = useRef(0);
  return (
    <ThemeProvider scheme="light">
      {mode === "phone" ? (
        <PhoneSignInForm flow={phone} onUseEmail={() => setMode("email")} headingLevel={2} />
      ) : (
        <JoinCard flow={email} ask={0} answered={answered} />
      )}
    </ThemeProvider>
  );
}
