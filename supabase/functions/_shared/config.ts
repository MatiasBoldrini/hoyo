import { HttpError } from "./errors.ts";

export type PaymentProviderName = "paypal" | "stripe" | "dev";

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}

function csv(name: string): Set<string> {
  return new Set(
    (Deno.env.get(name) ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function paymentProviderName(): PaymentProviderName {
  const value = required("PAYMENT_PROVIDER").toLowerCase();
  if (value !== "paypal" && value !== "stripe" && value !== "dev") {
    throw new Error("PAYMENT_PROVIDER must be paypal, stripe or dev");
  }
  if (value === "dev") assertDevEnvironment();
  return value;
}

function assertDevEnvironment(): void {
  const appEnv = (Deno.env.get("APP_ENV") ?? "").toLowerCase();
  const supabaseUrl = new URL(required("SUPABASE_URL"));
  const localHost = supabaseUrl.hostname === "localhost" ||
    supabaseUrl.hostname === "127.0.0.1" ||
    supabaseUrl.hostname === "::1";
  if (!["development", "test"].includes(appEnv) || !localHost) {
    throw new Error(
      "The dev payment provider requires APP_ENV=development|test and a local SUPABASE_URL",
    );
  }
}

export function corsOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (!csv("CORS_ALLOWED_ORIGINS").has(origin)) {
    throw new HttpError(403, "origin_not_allowed", "Origin is not allowed.");
  }
  return origin;
}

export function validateRedirectUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048) {
    throw new HttpError(400, "invalid_redirect_url", "Invalid redirect URL.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "invalid_redirect_url", "Invalid redirect URL.");
  }

  const isLocalHttp = url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !isLocalHttp) ||
    url.username ||
    url.password ||
    url.hash ||
    !csv("PAYMENT_REDIRECT_ORIGINS").has(url.origin)
  ) {
    throw new HttpError(400, "redirect_not_allowed", "Redirect URL is not allowed.");
  }
  return url.toString();
}

export function supabaseConfig(): {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
} {
  return {
    url: required("SUPABASE_URL").replace(/\/+$/, ""),
    anonKey: required("SUPABASE_ANON_KEY"),
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

export function stripeConfig(): {
  secretKey: string;
  webhookSecret: string;
  apiBase: string;
} {
  const secretKey = required("STRIPE_SECRET_KEY");
  const webhookSecret = required("STRIPE_WEBHOOK_SECRET");
  if (!secretKey.startsWith("sk_") || secretKey.length < 20) {
    throw new Error("STRIPE_SECRET_KEY has an invalid format");
  }
  if (!webhookSecret.startsWith("whsec_") || webhookSecret.length < 20) {
    throw new Error("STRIPE_WEBHOOK_SECRET has an invalid format");
  }
  return {
    secretKey,
    webhookSecret,
    apiBase: (Deno.env.get("STRIPE_API_BASE") ?? "https://api.stripe.com/v1")
      .replace(/\/+$/, ""),
  };
}

export function paymentItemName(): string {
  const value = required("PAYMENT_ITEM_NAME");
  if (value.length > 120) throw new Error("PAYMENT_ITEM_NAME cannot exceed 120 characters");
  return value;
}

export function checkoutTtlSeconds(): number {
  const raw = Deno.env.get("CHECKOUT_TTL_SECONDS")?.trim();
  if (!raw) return 900;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 300 || value > 1_800) {
    throw new Error("CHECKOUT_TTL_SECONDS must be an integer between 300 and 1800");
  }
  return value;
}

export function paypalConfig(): {
  clientId: string;
  clientSecret: string;
  webhookId: string;
  apiBase: string;
  captureUrl: string;
  returnSecret: string;
} {
  const environment = (Deno.env.get("PAYPAL_ENV") ?? "").toLowerCase();
  if (environment !== "sandbox" && environment !== "live") {
    throw new Error("PAYPAL_ENV must be sandbox or live");
  }
  const captureUrl = new URL(required("PAYPAL_CAPTURE_URL"));
  const localHttp = captureUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(captureUrl.hostname);
  if (captureUrl.protocol !== "https:" && !localHttp) {
    throw new Error("PAYPAL_CAPTURE_URL must use HTTPS (or local HTTP)");
  }
  const returnSecret = required("PAYMENT_RETURN_SECRET");
  if (returnSecret.length < 32) {
    throw new Error("PAYMENT_RETURN_SECRET must contain at least 32 characters");
  }
  return {
    clientId: required("PAYPAL_CLIENT_ID"),
    clientSecret: required("PAYPAL_CLIENT_SECRET"),
    webhookId: required("PAYPAL_WEBHOOK_ID"),
    apiBase: environment === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com",
    captureUrl: captureUrl.toString(),
    returnSecret,
  };
}

export function devProviderConfig(): {
  checkoutUrl: string;
  webhookSecret: string;
} {
  assertDevEnvironment();
  const checkoutUrl = validateRedirectUrl(required("DEV_CHECKOUT_URL"));
  const webhookSecret = required("DEV_WEBHOOK_SECRET");
  if (webhookSecret.length < 32) {
    throw new Error("DEV_WEBHOOK_SECRET must contain at least 32 characters");
  }
  return { checkoutUrl, webhookSecret };
}
