// What every preview's emulators start with: one Google account per preview
// persona (the same `<persona>@supa.media` emails the preview seed signs in as),
// each with a primary calendar and a welcome email. All values are fake.
//
// Tests and agents add what they need through the real APIs afterwards
// (Calendar events.insert with attendees' responseStatus, Gmail messages.import),
// so a check reads exactly what a real account would hand it.

export const PERSONAS = ["alpha", "beta", "gamma", "delta", "epsilon"];

export const personaEmail = (persona) => `${persona}@supa.media`;

export function defaultSeed() {
  const users = PERSONAS.map((p) => ({
    email: personaEmail(p),
    name: p[0].toUpperCase() + p.slice(1),
    given_name: p[0].toUpperCase() + p.slice(1),
    family_name: "Persona",
  }));
  return {
    google: {
      users,
      calendars: users.map((u) => ({ id: "primary", user_email: u.email, summary: u.email, primary: true, selected: true, time_zone: "America/New_York" })),
      messages: users.map((u, i) => ({
        id: `msg_welcome_${PERSONAS[i]}`,
        user_email: u.email,
        from: "welcome@emulators.invalid",
        to: u.email,
        subject: "Welcome to your emulated inbox",
        body_text: "This mailbox is an emulator for a Context preview. Nothing here is real.",
        label_ids: ["INBOX", "UNREAD"],
      })),
    },
    resend: {},
  };
}
