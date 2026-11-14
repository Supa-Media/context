/**
 * How long ago, in the artifact's words: "just now", "4m ago", "2h ago", then days however many
 * ("34d ago", "52d ago"). The artifact never rounds to months, so a secret set 52 days ago reads
 * "52d ago" on Credentials, Flags and Search alike.
 */
export function ago(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
