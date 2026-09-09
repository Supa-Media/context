import { getRandomBytes } from "expo-crypto";

/** Native implementation backed by the operating system CSPRNG. */
export function newActivityControlToken(): string {
  return Array.from(getRandomBytes(32), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
