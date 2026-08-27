/**
 * Is this an Apple keyboard? — web. See `applePlatform.ts` for why there is
 * exactly one of these.
 *
 * `navigator.platform` is deprecated and still the only thing that works
 * everywhere; `userAgentData` is the modern replacement and does not exist in
 * Safari or Firefox. So: prefer the modern one, fall through to the old one,
 * and guard both — this runs on the first keystroke, and a throw here would
 * take the whole app down before anybody could report why.
 *
 * An empty `userAgentData.platform` falls through rather than being read as
 * "not Apple", which is the case that made an earlier version answer `Ctrl` on
 * a Mac.
 */
const APPLE = new Set(["macos", "macintel", "iphone", "ipad", "ipod", "mac"]);

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;

  try {
    const modern = (
      navigator as unknown as { userAgentData?: { platform?: string } }
    ).userAgentData?.platform;
    if (typeof modern === "string" && modern !== "") {
      return APPLE.has(modern.toLowerCase());
    }
  } catch {
    // Some embedded webviews throw on the getter itself.
  }

  try {
    const legacy = navigator.platform;
    if (typeof legacy === "string" && legacy !== "") return APPLE.has(legacy.toLowerCase());
    // Last resort: iPadOS 13+ reports "MacIntel" but a touch-capable one.
    return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent ?? "");
  } catch {
    return false;
  }
}
