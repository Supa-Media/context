import { useEffect, type RefObject } from "react";
import { Platform, type View } from "react-native";

/**
 * A native tooltip on web: `title` on the element's DOM node. React Native Web
 * does not forward a `title` prop, so it is set on the node itself. Native
 * has no hover; give the same words to the accessible name there.
 */
export function useHoverTitle(ref: RefObject<View | null>, title: string | null): void {
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = ref.current as unknown as HTMLElement | null;
    if (node === null || typeof node.setAttribute !== "function") return;
    if (title === null) node.removeAttribute("title");
    else node.setAttribute("title", title);
  });
}
