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
    area.setAttribute("aria-hidden", "true");
    /*
      **No `readonly`, and an explicit range.**

      The obvious version — `readonly` plus `select()` — is the one every
      snippet shows and the one iOS Safari ignores: it refuses to select a
      read-only field, so `execCommand` copies whatever was selected before,
      which is usually nothing. `setSelectionRange` over a writable field is
      what actually takes there, and `contentEditable` is what stops the
      keyboard appearing for the two frames it exists.
    */
    area.contentEditable = "true";
    area.style.position = "fixed";
    area.style.top = "-9999px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    try {
      area.focus();
      area.setSelectionRange(0, text.length);
      return document.execCommand("copy");
    } finally {
      // `finally`, because the throw is the likely path: `execCommand` is
      // deprecated and absent in some hosts. A textarea left in the body is a
      // focus trap on the next tab press, and it is invisible, so nobody would
      // connect the two.
      area.remove();
    }
  } catch {
    return false;
  }
}

/**
 * Copy something this press has not fetched yet.
 *
 * **The gesture is the whole problem.** Safari grants clipboard access only to
 * a call made inside the user activation that a press starts, and an `await` of
 * a network round trip spends it — so "mint a share, then copy its URL" fails
 * on iOS with no error a caller can see: the promise resolves, the write is
 * rejected, and the button silently stays "Copy link". That is exactly what the
 * team link did.
 *
 * The way through is documented and narrow: `ClipboardItem` accepts a
 * **Promise** for its data, so the write can be *started* inside the gesture and
 * settle whenever the round trip does. Safari implements it; browsers that do
 * not throw synchronously here, and those fall back to awaiting and writing the
 * ordinary way — which is fine, because they are the ones that do not enforce
 * the activation window in the first place.
 *
 * Returns the text as well as the outcome, because a caller that could not copy
 * still has something worth showing: the URL itself.
 */
export async function copyDeferred(
  produce: () => Promise<string | null>,
): Promise<{ ok: boolean; text: string | null }> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  const ItemCtor = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;

  if (clipboard?.write !== undefined && ItemCtor !== undefined) {
    /*
      One call to `produce`, whichever path runs. It mints a share row on the
      server, so calling it twice would be a second round trip and a second
      audit entry for one press.
    */
    let settled: Promise<string | null> | null = null;
    const text = () => (settled ??= produce());
    try {
      const item = new ItemCtor({
        "text/plain": text().then(
          (value) => new Blob([value ?? ""], { type: "text/plain" }),
        ),
      });
      await clipboard.write([item]);
      const value = await text();
      // An empty write is not a copy. `produce` answering `null` means the
      // thing being copied could not be made, and the caller says so.
      return { ok: value !== null, text: value };
    } catch {
      // Either the Promise form is unsupported (it throws on construction) or
      // the write was refused. Both fall through to the plain path, and the
      // round trip is not repeated.
      const value = await text();
      if (value === null) return { ok: false, text: null };
      return { ok: await writeClipboard(value), text: value };
    }
  }

  const value = await produce();
  if (value === null) return { ok: false, text: null };
  return { ok: await writeClipboard(value), text: value };
}
