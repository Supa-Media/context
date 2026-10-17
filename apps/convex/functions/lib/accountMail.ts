/**
 * Mail about the account itself: codes, sign-in alerts, recovery notices.
 * Plain text through Resend, from the auth sender. With no Resend key (tests,
 * a self-host without mail) it sends nothing and logs that, never the address
 * or the body. Logs carry the event name and status only: Resend's error body
 * quotes the address.
 */
export async function sendAccountMail(
  event: string,
  mail: { to: string; subject: string; text: string; from?: string },
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    console.log(JSON.stringify({ event, ok: false, reason: "resend_unconfigured" }));
    return;
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: mail.from ?? process.env.AUTH_EMAIL_FROM ?? "auth@context.lc",
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
      }),
    });
    console.log(JSON.stringify({ event, ok: response.ok, status: response.status }));
  } catch {
    console.log(JSON.stringify({ event, ok: false, reason: "transport_error" }));
  }
}

/** The app's address, for links in account mail (`APP_ORIGIN`, as billing reads it). */
export function appOrigin(): string {
  const origin = process.env.APP_ORIGIN ?? "https://context.lc";
  return origin.replace(/\/+$/, "");
}
