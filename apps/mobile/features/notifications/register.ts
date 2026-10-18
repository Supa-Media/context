export type RegistrationState = "registered" | "denied" | "failed";
type Permission = { allowed: boolean; canAskAgain: boolean };
export interface NotificationRegistration {
  prepare(): Promise<void>;
  permissions(): Promise<Permission>;
  request(): Promise<Permission>;
  register(): Promise<void>;
}

/** Called only from the person's Enable notifications press. */
export async function registerNotifications(api: NotificationRegistration, timeoutMs = 15_000): Promise<RegistrationState> {
  try {
    await api.prepare();
    let permission = await api.permissions();
    if (!permission.allowed && permission.canAskAgain) permission = await api.request();
    if (!permission.allowed) return "denied";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        api.register(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Registration timed out")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return "registered";
  } catch {
    return "failed";
  }
}
