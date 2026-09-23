import { paypalConfig } from "../config.ts";
import { signState } from "../crypto.ts";
import type { PreparedPayment } from "../database.ts";
import { HttpError } from "../errors.ts";
import type { Checkout, CompletedPayment, PaymentProvider, WebhookResult } from "./provider.ts";

interface PayPalOrder {
  id?: string;
  status?: string;
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    invoice_id?: string;
    amount?: { currency_code?: string; value?: string };
    payments?: {
      captures?: Array<{
        id?: string;
        status?: string;
        amount?: { currency_code?: string; value?: string };
      }>;
    };
  }>;
  links?: Array<{ rel?: string; href?: string }>;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const config = paypalConfig();
  const credentials = btoa(`${config.clientId}:${config.clientSecret}`);
  const response = await fetch(`${config.apiBase}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${credentials}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || typeof result?.access_token !== "string") {
    console.error("PayPal authentication failed", {
      status: response.status,
      requestId: response.headers.get("paypal-debug-id"),
    });
    throw new HttpError(502, "provider_error", "The payment provider is unavailable.");
  }
  tokenCache = {
    token: result.access_token,
    expiresAt: Date.now() + Math.max(0, Number(result.expires_in) || 0) * 1000,
  };
  return tokenCache.token;
}

async function paypalFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const config = paypalConfig();
  return await fetch(`${config.apiBase}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await accessToken()}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function usdValue(amountMinor: number): string {
  return `${Math.floor(amountMinor / 100)}.${String(amountMinor % 100).padStart(2, "0")}`;
}

function parseUsdMinor(value: unknown): number | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.\d{2}$/.test(value)) return null;
  const [units, cents] = value.split(".");
  const amount = Number(units) * 100 + Number(cents);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function completedFromOrder(
  order: PayPalOrder,
  eventId: string,
): CompletedPayment {
  const unit = order.purchase_units?.[0];
  const captures = unit?.payments?.captures ?? [];
  const capture = captures.find((candidate) => candidate.status === "COMPLETED");
  const orderId = unit?.custom_id;
  const versionMatch = unit?.invoice_id?.match(
    new RegExp(`^${orderId?.replaceAll("-", "\\-")}:v(\\d+)$`),
  );
  const orderVersion = Number(versionMatch?.[1]);
  const amountMinor = parseUsdMinor(capture?.amount?.value);
  if (
    order.status !== "COMPLETED" ||
    typeof order.id !== "string" ||
    typeof orderId !== "string" ||
    !Number.isSafeInteger(orderVersion) ||
    typeof capture?.id !== "string" ||
    capture.amount?.currency_code !== "USD" ||
    unit?.amount?.currency_code !== "USD" ||
    unit.amount.value !== capture.amount.value ||
    amountMinor === null
  ) {
    throw new HttpError(400, "invalid_payment", "PayPal payment is not complete.");
  }
  return {
    eventId,
    orderId,
    orderVersion,
    checkoutId: order.id,
    amountMinor,
    currency: "usd",
  };
}

async function readProviderResponse(
  response: Response,
  operation: string,
): Promise<any> {
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(`PayPal ${operation} failed`, {
      status: response.status,
      requestId: response.headers.get("paypal-debug-id"),
      name: result?.name,
    });
    throw new HttpError(502, "provider_error", "The payment provider is unavailable.");
  }
  return result;
}

export class PayPalProvider implements PaymentProvider {
  readonly name = "paypal" as const;

  async createCheckout(
    payment: PreparedPayment,
    redirects: { successUrl: string; cancelUrl: string },
  ): Promise<Checkout> {
    if (payment.currency !== "usd") {
      throw new HttpError(
        409,
        "unsupported_currency",
        "The selected provider does not support this order currency.",
      );
    }
    const config = paypalConfig();
    const state = await signState({
      orderId: payment.orderId,
      successUrl: redirects.successUrl,
      exp: Math.floor(Date.now() / 1000) + 3_600,
    }, config.returnSecret);
    const returnUrl = new URL(config.captureUrl);
    returnUrl.searchParams.set("state", state);
    const response = await paypalFetch("/v2/checkout/orders", {
      method: "POST",
      headers: {
        "paypal-request-id": payment.orderId,
        prefer: "return=representation",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: payment.orderId,
          custom_id: payment.orderId,
          description: payment.description,
          amount: { currency_code: "USD", value: usdValue(payment.amountMinor) },
        }],
        application_context: {
          return_url: returnUrl.toString(),
          cancel_url: redirects.cancelUrl,
          user_action: "PAY_NOW",
        },
      }),
    });
    const result: PayPalOrder = await readProviderResponse(response, "order creation");
    const approve = result.links?.find((link) => link.rel === "approve")?.href;
    if (typeof result.id !== "string" || typeof approve !== "string") {
      throw new Error("PayPal returned an invalid order");
    }
    return { id: result.id, url: approve };
  }

  async setCheckoutOrderVersion(
    checkout: Checkout,
    orderId: string,
    orderVersion: number,
  ): Promise<Checkout> {
    const current: PayPalOrder = await readProviderResponse(
      await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(checkout.id)}`),
      "order lookup",
    );
    const unit = current.purchase_units?.[0];
    const desiredInvoice = `${orderId}:v${orderVersion}`;
    if (unit?.custom_id !== orderId || typeof unit.reference_id !== "string") {
      throw new Error("PayPal order reference changed unexpectedly");
    }
    if (unit.invoice_id === desiredInvoice) return checkout;
    const response = await paypalFetch(
      `/v2/checkout/orders/${encodeURIComponent(checkout.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify([{
          op: unit.invoice_id ? "replace" : "add",
          path: `/purchase_units/@reference_id=='${unit.reference_id}'/invoice_id`,
          value: desiredInvoice,
        }]),
      },
    );
    if (!response.ok && response.status !== 204) {
      await readProviderResponse(response, "order metadata update");
    }
    return checkout;
  }

  async captureOrder(providerOrderId: string, expectedOrderId: string): Promise<CompletedPayment> {
    if (!/^[A-Z0-9]+$/i.test(providerOrderId)) {
      throw new HttpError(400, "invalid_request", "Invalid PayPal order.");
    }
    const response = await paypalFetch(
      `/v2/checkout/orders/${encodeURIComponent(providerOrderId)}/capture`,
      {
        method: "POST",
        headers: {
          "paypal-request-id": `capture-${expectedOrderId}`,
          prefer: "return=representation",
        },
        body: "{}",
      },
    );
    // Browser reloads and webhook races are normal. If PayPal reports that the
    // order was already captured, retrieve its canonical state and continue.
    const order: PayPalOrder = response.ok
      ? await readProviderResponse(response, "order capture")
      : response.status === 422
      ? await readProviderResponse(
        await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(providerOrderId)}`),
        "order lookup",
      )
      : await readProviderResponse(response, "order capture");
    const captureId = order.purchase_units?.[0]?.payments?.captures?.find(
      (capture) => capture.status === "COMPLETED",
    )?.id;
    const completed = completedFromOrder(order, `capture:${captureId ?? providerOrderId}`);
    if (completed.orderId !== expectedOrderId) {
      throw new HttpError(400, "invalid_payment", "PayPal order reference does not match.");
    }
    return completed;
  }

  async verifyAndParseWebhook(body: string, headers: Headers): Promise<WebhookResult> {
    let event: any;
    try {
      event = JSON.parse(body);
    } catch {
      throw new HttpError(400, "invalid_webhook", "Invalid webhook payload.");
    }
    if (typeof event?.id !== "string" || typeof event?.event_type !== "string") {
      throw new HttpError(400, "invalid_webhook", "Invalid webhook payload.");
    }
    const requiredHeaders = {
      transmission_id: headers.get("paypal-transmission-id"),
      transmission_time: headers.get("paypal-transmission-time"),
      cert_url: headers.get("paypal-cert-url"),
      auth_algo: headers.get("paypal-auth-algo"),
      transmission_sig: headers.get("paypal-transmission-sig"),
    };
    if (Object.values(requiredHeaders).some((value) => !value)) {
      throw new HttpError(400, "invalid_signature", "Invalid webhook signature.");
    }
    const config = paypalConfig();
    const verification = await paypalFetch("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: JSON.stringify({
        ...requiredHeaders,
        webhook_id: config.webhookId,
        webhook_event: event,
      }),
    });
    const verificationResult = await readProviderResponse(
      verification,
      "webhook verification",
    );
    if (verificationResult?.verification_status !== "SUCCESS") {
      throw new HttpError(400, "invalid_signature", "Invalid webhook signature.");
    }
    if (event.event_type !== "PAYMENT.CAPTURE.COMPLETED") {
      return { completed: null, eventId: event.id, eventType: event.event_type };
    }
    const providerOrderId = event?.resource?.supplementary_data?.related_ids?.order_id;
    if (typeof providerOrderId !== "string") {
      throw new HttpError(400, "invalid_webhook", "Missing PayPal order reference.");
    }
    const response = await paypalFetch(
      `/v2/checkout/orders/${encodeURIComponent(providerOrderId)}`,
    );
    const order: PayPalOrder = await readProviderResponse(response, "order lookup");
    return {
      completed: completedFromOrder(order, event.id),
      eventId: event.id,
      eventType: event.event_type,
    };
  }
}
