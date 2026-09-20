/**
 * Cloudflare Turnstile, on the one page a stranger can write through.
 *
 * ## Why a challenge is here and nowhere else in this app
 *
 * Every other write resolves a session to a person with an account, and the
 * cost of abusing one is an account somebody has to keep. A collect link has
 * neither: it is a URL its owner published so that strangers can answer a
 * form, which is the same shape as a comment box and attracts the same
 * traffic. `apps/convex/functions/lib/turnstile.ts` is the other half and
 * carries the full argument, including why it fails closed.
 *
 * ## Both ends have to be configured, and the page says so before the typing
 *
 * The server refuses every submission when `TURNSTILE_SECRET_KEY` is unset.
 * This end is the same rule at the other end of the same pair: with no
 * `EXPO_PUBLIC_TURNSTILE_SITE_KEY` there is no widget to render, so the form
 * says it is not taking answers **instead of drawing fields** — rather than
 * taking two minutes of somebody's typing and refusing at the end.
 *
 * The site key is public by construction: it is in the markup of every page
 * that runs a widget. It is read from the environment rather than committed
 * only because this repository is public and `CLAUDE.md` keeps account
 * identifiers out of it, exactly as `EXPO_PUBLIC_CONVEX_URL` is.
 *
 * ## The token is single-use
 *
 * Cloudflare spends a token on the first verification. So `resetKey` exists:
 * after a send — successful or not — the form bumps it, this remounts the
 * widget, and the next attempt carries a token that has not been spent. A
 * widget that was not reset would make the second answer through one page
 * fail with a refusal about the check rather than about the answer.
 */

import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../design/components/Text";
import { Notice } from "../design/components/Input";

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SITE_KEY = process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? "";

export const HUMAN_CHECK_AVAILABLE = SITE_KEY !== "";

interface Turnstile {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
      theme?: "auto" | "light" | "dark";
    },
  ) => string;
  remove: (widgetId: string) => void;
}

/**
 * The script tag, added once per document and shared by every widget.
 *
 * A promise rather than a boolean because two forms on one note would
 * otherwise race: the second would see "not loaded yet", append a second
 * script, and Turnstile would be initialised twice.
 */
let loading: Promise<Turnstile | null> | null = null;

function loadTurnstile(): Promise<Turnstile | null> {
  if (loading !== null) return loading;
  loading = new Promise((resolve) => {
    const existing = (window as unknown as { turnstile?: Turnstile }).turnstile;
    if (existing !== undefined) {
      resolve(existing);
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      resolve((window as unknown as { turnstile?: Turnstile }).turnstile ?? null);
    };
    // A blocked or unreachable script resolves `null` rather than hanging. The
    // form then says the check could not run, which is the same thing the
    // server says when it cannot reach Cloudflare — one story, both ends.
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return loading;
}

export function HumanCheck({
  onToken,
  resetKey,
}: {
  onToken: (token: string | null) => void;
  resetKey: number;
}) {
  const styles = StyleSheet.create({ slot: { minHeight: 70, marginTop: 4 } });
  const holder = useRef<View | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!HUMAN_CHECK_AVAILABLE) return;
    const element = holder.current as unknown as HTMLElement | null;
    if (element === null) return;

    let widgetId: string | null = null;
    let cancelled = false;
    setFailed(false);
    onToken(null);

    loadTurnstile().then((turnstile) => {
      if (cancelled) return;
      if (turnstile === null) {
        setFailed(true);
        return;
      }
      widgetId = turnstile.render(element, {
        sitekey: SITE_KEY,
        callback: (token) => onToken(token),
        // A token that timed out is no token. Reported rather than kept, so
        // the Send button goes back to being unavailable instead of sending
        // something Cloudflare will refuse.
        "expired-callback": () => onToken(null),
        "error-callback": () => {
          onToken(null);
          setFailed(true);
        },
        theme: "auto",
      });
    });

    return () => {
      cancelled = true;
      const turnstile = (window as unknown as { turnstile?: Turnstile }).turnstile;
      if (widgetId !== null && turnstile !== undefined) turnstile.remove(widgetId);
    };
    // `onToken` is deliberately not a dependency: the form passes a fresh
    // closure every render, and depending on it would tear the widget down and
    // rebuild it on every keystroke in the fields above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  if (!HUMAN_CHECK_AVAILABLE) {
    return (
      <Notice tone="warn" testID="share-form-no-human-check">
        <Text variant="rowSub">This form is not taking answers right now.</Text>
      </Notice>
    );
  }

  if (failed) {
    return (
      <Notice tone="warn" testID="share-form-check-unavailable">
        <Text variant="rowSub">
          The check in front of this form could not run. Reload the page and try again.
        </Text>
      </Notice>
    );
  }

  return <View ref={holder} style={styles.slot} testID="share-form-human-check" />;
}
