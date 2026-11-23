import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { browseHref } from "../nav";
import type { ConsoleRouter } from "../layout/types";

/*
  The vault is its own place, not a page of Settings (Dev, 2026-11-23: "it's
  kind of its own thing"). On a layout with a right panel it is the rail's
  Vault tab; a phone has no panel, so there it is a page in the document slot,
  opened from the account sheet beside Settings, Meetings and Tex.

  Its address is `?vault=1`, beside `?trash=1` and `?meetings=1`. The old
  `?settings=vault` still opens it, because emails already sent carry that
  link (`vaultNotify`), and Settings no longer has a Vault section to show.
*/

/** Whether the address asks for the vault: `?vault=1`, or an old `?settings=vault` link. */
export function vaultFromQuery(
  vault: string | string[] | undefined,
  settings: string | string[] | undefined,
): boolean {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  return first(vault) === "1" || first(settings)?.trim() === "vault";
}

export function vaultHref(slug: string): string {
  return `${browseHref(slug)}?vault=1`;
}

/** The phone's Vault page, as the console's pieces use it (the Trash page's shape). */
export interface VaultRoute {
  open: boolean;
  workspaceId: string;
  openVault(): void;
  closeVault(): void;
}

/** One page in the document slot at a time: opening the vault closes the map, the trash and Settings. */
export function routeVault(router: Pick<ConsoleRouter, "setParams">, open: boolean, workspaceId: string): VaultRoute {
  return {
    open,
    workspaceId,
    openVault: () => router.setParams({ vault: "1", map: undefined, trash: undefined, settings: undefined }),
    closeVault: () => router.setParams({ vault: undefined, settings: undefined }),
  };
}

const VaultRouteContext = createContext<VaultRoute | undefined>(undefined);

export const VaultRouteProvider = VaultRouteContext.Provider;

/** The phone's Vault route; absent on a pointer layout, the demo and a visitor. */
export function useVaultRoute(): VaultRoute | undefined {
  return useContext(VaultRouteContext);
}

/**
 * The vault's route for this console.
 *
 * On a phone it is the page, and choosing a note in the tree leaves it as it
 * leaves the trash. On a layout with a panel the address is an ask: `onPanel`
 * opens the rail's Vault tab once and the parameter comes off, so a reload
 * cannot reopen a panel somebody has since closed.
 */
export function useConsoleVaultRoute(
  router: ConsoleRouter,
  asked: boolean,
  {
    available,
    phone,
    workspaceId,
    selectedPath,
    onPanel,
  }: {
    available: boolean;
    phone: boolean;
    workspaceId: string | null;
    selectedPath: string | null;
    onPanel: () => void;
  },
): VaultRoute | undefined {
  const usable = available && workspaceId !== null;
  const route = useMemo(
    () => (usable && phone ? routeVault(router, asked, workspaceId) : undefined),
    [usable, phone, router, asked, workspaceId],
  );

  const handled = useRef(false);
  useEffect(() => {
    if (!asked) {
      handled.current = false;
      return;
    }
    if (phone || !usable || handled.current) return;
    handled.current = true;
    router.setParams({ vault: undefined, settings: undefined });
    onPanel();
  }, [asked, phone, usable, router, onPanel]);

  const last = useRef(selectedPath);
  const close = route?.closeVault;
  const open = route?.open === true;
  useEffect(() => {
    const changed = last.current !== selectedPath;
    last.current = selectedPath;
    if (changed && open && selectedPath !== null) close?.();
  }, [selectedPath, open, close]);
  return route;
}

/*
  Whether the phone's Vault page has a key (or New key) open. Then the key's
  own back row is the page's only back, as the approved prototype drew it, so
  the top bar's "‹ Notes" and the page's title stand aside. A store rather than
  route state: the top bar and the page are in different slots of the frame.
*/
let vaultDeep = false;
const deepListeners = new Set<() => void>();

export function setVaultDeep(deep: boolean): void {
  if (deep === vaultDeep) return;
  vaultDeep = deep;
  for (const listener of [...deepListeners]) listener();
}

export function useVaultDeep(): boolean {
  return useSyncExternalStore(
    (listener) => {
      deepListeners.add(listener);
      return () => deepListeners.delete(listener);
    },
    () => vaultDeep,
    () => vaultDeep,
  );
}
