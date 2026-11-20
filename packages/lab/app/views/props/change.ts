/**
 * The artifact wired its inputs with `onchange`, which fires when a value is
 * committed (blur, Enter, a spinner click, a select pick), not on every key as
 * React's `onChange` does. `onCommit(fn)` is a ref callback that listens to the
 * DOM's own `change` event, so an edit lands (and draws again, and adds one undo
 * step) exactly when it did in the artifact. Pair it with `defaultValue` and a
 * `key` of the current value, so an undo or another edit redraws the field.
 */
export function onCommit<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(fn: (value: string, el: T) => void) {
  return (el: T | null) => {
    if (!el) return;
    const h = () => fn(el.value, el);
    el.addEventListener("change", h);
    return () => el.removeEventListener("change", h);
  };
}
