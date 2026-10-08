import { useState } from "react";

/**
 * A value a parent may own. Given `value` and `onChange` the parent decides
 * (the route, from the address); without them the component keeps its own,
 * which is how the render tests mount a section or the whole console with no
 * router behind it.
 */
export function useOwnedOr<T>(
  value: T | undefined,
  onChange: ((next: T) => void) | undefined,
  initial: T,
): [T, (next: T) => void] {
  const [own, setOwn] = useState<T>(initial);
  if (onChange !== undefined && value !== undefined) return [value, onChange];
  return [own, setOwn];
}
