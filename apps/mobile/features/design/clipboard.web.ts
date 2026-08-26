/**
 * Clipboard — web.
 *
 * The async Clipboard API is the happy path, but it is unavailable on insecure
 * origins and in some embedded webviews. The `execCommand("copy")` fallback is
 * deprecated but still the only thing that works there, and the endpoint URL is
 * the single most important thing on the Connections pane to be able to copy.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through — permissions can reject even where the API exists.
    }
  }

  if (typeof document === "undefined") return false;

  try {
    const area = document.createElement("textarea");
    area.value = text;
    // Keep it out of the layout and out of the accessibility tree.
    area.setAttribute("readonly", "");
    area.setAttribute("aria-hidden", "true");
    area.style.position = "fixed";
    area.style.top = "-9999px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
