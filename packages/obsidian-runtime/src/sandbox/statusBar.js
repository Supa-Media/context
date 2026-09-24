// @ts-check
import { STATUS_BAR_MAX } from "./message.js";

/**
 * The status bar bridge: text crosses, the element never does.
 *
 * Moved verbatim out of `pluginSandboxDocument()` in ../sandbox.js; this is
 * source text for the sandboxed document, not code that runs in this realm.
 */
export const STATUS_BAR_JS = `  /*
    THE STATUS BAR: THE TEXT CROSSES, THE ELEMENT DOES NOT.

    A plugin gets a real element and writes into it however it likes. What
    reaches the console is the text that ended up in it, and the console draws
    that with its own components in its own theme — so a plugin cannot style,
    position or script anything on the trusted side, and the sandbox stays the
    only place its DOM exists.

    Reported as a whole list on every change rather than an add and a remove.
    A guest that is torn down or throws mid-render never owes the host a removal
    message it might not send, so the console's copy cannot drift from this one.
    The host's parser carries the same reasoning from its side.

    The cap is interpolated from the host's own constant rather than written
    twice. Two numbers meant to agree, in one file, with nothing linking them is
    how the supported-members list drifted by twenty names.

    Kept out of the layout with display:none: nothing here is meant to be seen
    in the frame, which is 1x1 and invisible anyway, and a later change that
    makes a frame visible must not start drawing this by accident.
  */
  const statusRoot = document.createElement('div');
  statusRoot.style.display = 'none';
  const statusIds = new WeakMap();
  let statusCount = 0;
  let statusWatch = null;
  let statusSent = null;
  function reportStatusBar() {
    const items = [];
    for (const el of Array.from(statusRoot.children)) {
      const id = statusIds.get(el);
      if (typeof id !== 'string') continue;
      // Collapsed and bounded here as well as on the host: a status bar item
      // is a line in a card, and a plugin that puts a paragraph in one should
      // not be able to decide how tall somebody's console is.
      const text = String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      if (text === '') continue;
      items.push({ id, text });
      if (items.length >= ${STATUS_BAR_MAX}) break;
    }
    // The observer fires on any mutation, and plenty of them leave the text
    // exactly as it was: a plugin that empties an item and rebuilds it with the
    // same words has changed its DOM twice and said nothing. Sending only what
    // is new keeps a plugin re-rendering on a timer from re-rendering the
    // console with it.
    const encoded = JSON.stringify(items);
    if (encoded === statusSent) return;
    statusSent = encoded;
    send('status-bar', { items });
  }

`;
