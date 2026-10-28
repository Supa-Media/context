import type { StrictKeyValue } from "./transcriptionWithdrawalStore";

export type { StrictKeyValue } from "./transcriptionWithdrawalStore";

/**
 * Where a kept Turn off lives in a browser: `localStorage`, read strictly. A
 * browser that blocks site data throws here, and the caller holds the device
 * off rather than reading the throw as "nothing kept".
 */
export function deviceWithdrawalStore(): StrictKeyValue {
  const local = () => {
    const store = (globalThis as { localStorage?: Storage }).localStorage;
    if (store === undefined) throw new Error("no localStorage");
    return store;
  };
  return {
    get: async (key) => local().getItem(key),
    set: async (key, value) => local().setItem(key, value),
    remove: async (key) => local().removeItem(key),
  };
}
