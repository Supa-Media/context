import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Where a kept Turn off lives on a phone. Unlike the offline store's `get`,
 * a failed read is thrown rather than answered as "nothing here": a Turn off
 * that cannot be read must hold the device off, not let it send
 * (`transcriptionWithdrawal.ts`).
 */
export interface StrictKeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export function deviceWithdrawalStore(): StrictKeyValue {
  return {
    get: (key) => AsyncStorage.getItem(key),
    set: (key, value) => AsyncStorage.setItem(key, value),
    remove: (key) => AsyncStorage.removeItem(key),
  };
}
