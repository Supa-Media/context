import { browseHref } from "../console/nav";

/**
 * Whether the URL has What changed open: `?changes=1`, beside `?note=` the way
 * `?settings=` is, so Browse and the tree stay mounted under it. Anything but
 * `1` is closed.
 */
export function changesFromQuery(value: string | string[] | undefined): boolean {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "1";
}

export function changesHref(slug: string): string {
  return `${browseHref(slug)}?changes=1`;
}
