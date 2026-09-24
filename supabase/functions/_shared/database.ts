import { paymentItemName, supabaseConfig } from "./config.ts";
import { HttpError } from "./errors.ts";

export interface PreparedPayment {
  orderId: string;
  amountMinor: number;
  currency: string;
  description: string;
  kind: string;
  status: string;
  version: number;
}

async function supabaseFetch(
  path: string,
  key: string,
  authorization: string,
  init: RequestInit,
): Promise<Response> {
  const config = supabaseConfig();
  return await fetch(`${config.url}${path}`, {
    ...init,
    headers: {
      apikey: key,
      authorization,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

export async function authenticate(authorization: string | null): Promise<string> {
  if (!authorization?.match(/^Bearer \S+$/)) {
    throw new HttpError(401, "unauthorized", "Authentication is required.");
  }
  const config = supabaseConfig();
  const response = await supabaseFetch(
    "/auth/v1/user",
    config.anonKey,
    authorization,
    { method: "GET" },
  );
  if (!response.ok) {
    throw new HttpError(401, "unauthorized", "Authentication is required.");
  }
  const user = await response.json();
  if (typeof user?.id !== "string") {
    throw new HttpError(401, "unauthorized", "Authentication is required.");
  }
  return user.id;
}

async function rpc(
  name: string,
  body: Record<string, unknown>,
  authorization: string,
  key: string,
): Promise<unknown> {
  const response = await supabaseFetch(
    `/rest/v1/rpc/${name}`,
    key,
    authorization,
    { method: "POST", body: JSON.stringify(body) },
  );
  if (!response.ok) {
    let message = "Payment is not available.";
    try {
      const body = await response.json();
      if (typeof body?.message === "string" && /already claimed/i.test(body.message)) {
        message = "asset is already claimed";
      }
    } catch {
      message = "Payment is not available.";
    }
    console.error("Payment RPC failed", {
      rpc: name,
      status: response.status,
      requestId: response.headers.get("x-request-id"),
    });
    throw new HttpError(409, "payment_not_available", message);
  }
  if (response.status === 204) return null;
  return await response.json();
}

function single(value: unknown): Record<string, unknown> {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") throw new Error("RPC returned no row");
  return row as Record<string, unknown>;
}

function asSafeInteger(value: unknown): number | null {
  if (typeof value === "string" && /^-?\d+$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export async function preparePayment(
  input: {
    assetId: string;
    company: string;
    targetUrl: string | null;
    logoPath: string | null;
    color: string;
    animation: string;
    design: Record<string, unknown> | null;
    idempotencyKey: string;
    expectedAssetVersion: number;
    ttlSeconds: number;
  },
  authorization: string,
): Promise<PreparedPayment> {
  const config = supabaseConfig();
  const row = single(
    await rpc(
      "reserve_checkout",
      {
        p_asset_id: input.assetId,
        p_company: input.company,
        p_target_url: input.targetUrl,
        p_logo_path: input.logoPath,
        p_color: input.color,
        p_animation: input.animation,
        p_design: input.design,
        p_idempotency_key: input.idempotencyKey,
        p_expected_asset_version: input.expectedAssetVersion,
        p_ttl_seconds: input.ttlSeconds,
      },
      authorization,
      config.anonKey,
    ),
  );
  const amountMinor = asSafeInteger(row.amount_cents);
  const version = asSafeInteger(row.version);
  if (
    typeof row.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(row.id) ||
    amountMinor === null ||
    amountMinor < 0 ||
    typeof row.currency !== "string" ||
    !/^[a-zA-Z]{3}$/.test(row.currency) ||
    typeof row.kind !== "string" ||
    typeof row.status !== "string" ||
    version === null
  ) {
    throw new Error("reserve_checkout returned an invalid contract");
  }
  return {
    orderId: row.id,
    amountMinor,
    currency: row.currency.toLowerCase(),
    description: amountMinor > 0 ? paymentItemName() : "Lugar",
    kind: row.kind,
    status: row.status,
    version,
  };
}

export async function recordCheckout(
  orderId: string,
  expectedOrderVersion: number,
  provider: string,
  providerCheckoutId: string,
): Promise<number> {
  const config = supabaseConfig();
  const row = single(
    await rpc(
      "attach_provider_checkout",
      {
        p_order_id: orderId,
        p_expected_order_version: expectedOrderVersion,
        p_provider: provider,
        p_provider_checkout_id: providerCheckoutId,
      },
      `Bearer ${config.serviceRoleKey}`,
      config.serviceRoleKey,
    ),
  );
  const version = asSafeInteger(row.version);
  if (version === null) {
    throw new Error("attach_provider_checkout returned an invalid contract");
  }
  return version;
}

export async function completePayment(input: {
  eventId: string;
  eventType: string;
  orderId: string;
  expectedOrderVersion: number;
  provider: string;
  providerCheckoutId: string;
  amountMinor: number;
  currency: string;
}): Promise<unknown> {
  const config = supabaseConfig();
  return await rpc(
    "finalize_payment",
    {
      p_provider: input.provider,
      p_provider_event_id: input.eventId,
      p_provider_checkout_id: input.providerCheckoutId,
      p_order_id: input.orderId,
      p_expected_order_version: input.expectedOrderVersion,
      p_amount_cents: input.amountMinor,
      p_currency: input.currency,
      p_event_type: input.eventType,
      p_payload: {
        order_id: input.orderId,
        provider_checkout_id: input.providerCheckoutId,
        amount_cents: input.amountMinor,
        currency: input.currency,
      },
    },
    `Bearer ${config.serviceRoleKey}`,
    config.serviceRoleKey,
  );
}
