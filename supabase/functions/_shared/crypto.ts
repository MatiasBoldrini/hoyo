const encoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToHex(new Uint8Array(signature));
}

export function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export async function verifyTimestampedSignature(input: {
  header: string | null;
  body: string;
  secret: string;
  now?: number;
  toleranceSeconds?: number;
}): Promise<boolean> {
  if (!input.header) return false;
  const parts = input.header.split(",").map((part) => part.trim());
  const timestampValue = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3));
  const timestamp = Number(timestampValue);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? 300;
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now - timestamp) > tolerance ||
    signatures.length === 0
  ) return false;
  const expected = await hmacSha256Hex(input.secret, `${timestamp}.${input.body}`);
  return signatures.some((signature) => timingSafeEqual(signature, expected));
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export async function signState(
  value: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const payload = base64Url(encoder.encode(JSON.stringify(value)));
  return `${payload}.${await hmacSha256Hex(secret, payload)}`;
}

export async function verifyState<T>(
  state: string,
  secret: string,
): Promise<T | null> {
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra) return null;
  const expected = await hmacSha256Hex(secret, payload);
  if (!timingSafeEqual(signature, expected)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as T;
  } catch {
    return null;
  }
}
