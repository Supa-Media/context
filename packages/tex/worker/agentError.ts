/**
 * A throw where nothing above us logs it (a Durable Object alarm stage, a workflow step) is named in the
 * logs before it goes on as before: a fixed site code and the error's class, never its message, which can
 * carry a person's words or numbers (2026-11-01: two exceptions read only as "unknown" on the public log page).
 */
export async function logged<T>(where: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    console.log(JSON.stringify({ event: "agent_error", where, name: errorName(error) }));
    throw error;
  }
}

/** The class only: a name that reads like an identifier, else "Error", or "thrown" for a non-Error value. */
export function errorName(error: unknown): string {
  if (!(error instanceof Error)) return "thrown";
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(error.name) ? error.name : "Error";
}
