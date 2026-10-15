import { getRandomBytes } from "expo-crypto";

/** Hermes has no browser Web Crypto; use the native CSPRNG for report ids. */
export function newClientReportId(): string {
  return Array.from(getRandomBytes(12), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
