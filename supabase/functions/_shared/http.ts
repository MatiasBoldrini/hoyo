import { corsOrigin } from "./config.ts";
import { HttpError, safeError } from "./errors.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function corsHeaders(origin: string | null): HeadersInit {
  return origin
    ? {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, x-client-info, apikey, content-type, x-retry-count",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-max-age": "600",
      "vary": "Origin",
    }
    : {};
}

export function json(
  body: unknown,
  status = 200,
  origin: string | null = null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(origin) },
  });
}

export function errorResponse(error: unknown, origin: string | null): Response {
  const safe = safeError(error);
  return json({ error: { code: safe.code, message: safe.message } }, safe.status, origin);
}

export function preflight(request: Request): Response | null {
  if (request.method !== "OPTIONS") return null;
  const origin = corsOrigin(request);
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export function requirePost(request: Request): void {
  if (request.method !== "POST") {
    throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  }
}

export async function readJson(
  request: Request,
  maxBytes = 16_384,
): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Request payload is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Request payload is too large.");
  }
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object.");
  }
}
