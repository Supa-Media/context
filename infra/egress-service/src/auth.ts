async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function timingSafeEqual(leftValue: string, rightValue: string): Promise<boolean> {
  if (!leftValue || !rightValue) return false;
  const [left, right] = await Promise.all([digest(leftValue), digest(rightValue)]);
  let difference = left.length ^ right.length;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export async function isAuthorized(header: string | null, secret: string | undefined): Promise<boolean> {
  const expected = typeof secret === "string" ? secret.trim() : "";
  const match = /^Bearer[ ]+([^ ]+)$/i.exec(header?.trim() ?? "");
  return expected !== "" && match !== null && await timingSafeEqual(match[1]!, expected);
}
