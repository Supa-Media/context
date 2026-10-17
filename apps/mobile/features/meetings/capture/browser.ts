/**
 * Which browser this is, by the name a person would recognise.
 *
 * Only for words on screen: "Arc didn't share call audio", "quit and reopen
 * Arc". Nothing decides what to *do* from this; what a browser can do is
 * probed (`audioWeb/capabilities.ts`), because a name is a guess and a probe
 * is an answer.
 *
 * Arc says nothing in its user agent (it is Chrome's), but paints its theme
 * into CSS variables on every page it opens, so the variable is how it is
 * told apart. Brave likewise hides behind Chrome's agent and exposes
 * `navigator.brave`.
 */
export type BrowserName =
  | "Arc"
  | "Brave"
  | "Edge"
  | "Opera"
  | "Firefox"
  | "Safari"
  | "Chrome"
  | "This browser";

export interface BrowserFacts {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  arcTheme: boolean;
  brave: boolean;
}

function facts(): BrowserFacts | null {
  if (typeof navigator === "undefined") return null;
  let arcTheme = false;
  try {
    if (typeof document !== "undefined" && typeof getComputedStyle === "function") {
      arcTheme =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--arc-palette-background")
          .trim() !== "";
    }
  } catch {
    arcTheme = false;
  }
  return {
    userAgent: navigator.userAgent ?? "",
    platform: (navigator as { platform?: string }).platform ?? "",
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    arcTheme,
    brave: typeof (navigator as { brave?: unknown }).brave === "object",
  };
}

export function browserName(input: BrowserFacts | null = facts()): BrowserName {
  if (input === null) return "This browser";
  const ua = input.userAgent;
  if (input.arcTheme) return "Arc";
  if (input.brave) return "Brave";
  if (/\bEdg\//.test(ua)) return "Edge";
  if (/\bOPR\//.test(ua)) return "Opera";
  if (/\bFirefox\//.test(ua)) return "Firefox";
  if (/\bChrome\//.test(ua) || /\bCriOS\//.test(ua)) return "Chrome";
  if (/\bSafari\//.test(ua)) return "Safari";
  return "This browser";
}

/** A Mac, and not an iPad asking for the desktop site. */
export function onMac(input: BrowserFacts | null = facts()): boolean {
  if (input === null) return false;
  const mac = /Mac/.test(input.platform) || /Macintosh/.test(input.userAgent);
  return mac && input.maxTouchPoints <= 1;
}

/** A phone or tablet, where no browser can hand over a call's sound. */
export function onPhoneOrTablet(input: BrowserFacts | null = facts()): boolean {
  if (input === null) return false;
  if (/Android|iPhone|iPad|iPod|Mobi/.test(input.userAgent)) return true;
  // iPadOS asks for the desktop site and reports itself as a Mac with touch.
  return /Mac/.test(input.platform) && input.maxTouchPoints > 1;
}

/** Where the Mac app is, for "record in the Mac app". Its public releases page. */
export const MAC_APP_URL = "https://github.com/Supa-Media/context/releases/latest";
