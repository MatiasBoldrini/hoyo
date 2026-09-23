import { stripeConfig } from "../config.ts";
import { verifyTimestampedSignature } from "../crypto.ts";
import { HttpError } from "../errors.ts";
import type { Checkout, PaymentProvider, WebhookResult } from "./provider.ts";
import type { PreparedPayment } from "../database.ts";

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class StripeProvider implements PaymentProvider {
  readonly name = "stripe" as const;

  async createCheckout(
    payment: PreparedPayment,
    redirects: { successUrl: string; cancelUrl: string },
  ): Promise<Checkout> {
    const config = stripeConfig();
    const form = new URLSearchParams({
      mode: "payment",
      success_url: redirects.successUrl,
      cancel_url: redirects.cancelUrl,
      client_reference_id: payment.orderId,
      "metadata[order_id]": payment.orderId,
      "payment_intent_data[metadata][order_id]": payment.orderId,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": payment.currency,
      "line_items[0][price_data][unit_amount]": String(payment.amountMinor),
      "line_items[0][price_data][product_data][name]": payment.description,
    });
    const response = await fetch(`${config.apiBase}/checkout/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": payment.orderId,
      },
      body: form,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      console.error("Stripe checkout creation failed", {
        status: response.status,
        requestId: response.headers.get("request-id"),
        type: result?.error?.type,
      });
      throw new HttpError(502, "provider_error", "The payment provider is unavailable.");
    }
    if (!string(result?.id) || !string(result?.url)) {
      throw new Error("Stripe returned an invalid Checkout Session");
    }
    return { id: result.id, url: result.url };
  }

  async setCheckoutOrderVersion(
    checkout: Checkout,
    _orderId: string,
    orderVersion: number,
  ): Promise<Checkout> {
    const config = stripeConfig();
    const response = await fetch(`${config.apiBase}/checkout/sessions/${checkout.id}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.secretKey}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ "metadata[order_version]": String(orderVersion) }),
    });
    if (!response.ok) {
      console.error("Stripe checkout metadata update failed", {
        status: response.status,
        requestId: response.headers.get("request-id"),
      });
      throw new HttpError(502, "provider_error", "The payment provider is unavailable.");
    }
    return checkout;
  }

  async verifyAndParseWebhook(body: string, headers: Headers): Promise<WebhookResult> {
    const config = stripeConfig();
    const valid = await verifyTimestampedSignature({
      header: headers.get("stripe-signature"),
      body,
      secret: config.webhookSecret,
    });
    if (!valid) {
      throw new HttpError(400, "invalid_signature", "Invalid webhook signature.");
    }

    let event: any;
    try {
      event = JSON.parse(body);
    } catch {
      throw new HttpError(400, "invalid_webhook", "Invalid webhook payload.");
    }
    const eventId = string(event?.id);
    const eventType = string(event?.type);
    if (!eventId || !eventType) {
      throw new HttpError(400, "invalid_webhook", "Invalid webhook payload.");
    }

    const completes = eventType === "checkout.session.completed" ||
      eventType === "checkout.session.async_payment_succeeded";
    if (!completes) return { completed: null, eventId, eventType };

    const session = event?.data?.object;
    // Some delayed payment methods emit `completed` before funds settle. Ack
    // that event and wait for `async_payment_succeeded`; never activate early.
    if (session?.payment_status !== "paid") {
      return { completed: null, eventId, eventType };
    }
    const orderId = string(session?.metadata?.order_id) ??
      string(session?.client_reference_id);
    const orderVersion = Number(session?.metadata?.order_version);
    const checkoutId = string(session?.id);
    const amountMinor = session?.amount_total;
    const currency = string(session?.currency);
    if (
      !orderId ||
      !Number.isSafeInteger(orderVersion) ||
      !checkoutId ||
      !Number.isSafeInteger(amountMinor) ||
      amountMinor <= 0 ||
      !currency
    ) {
      throw new HttpError(400, "invalid_webhook", "Incomplete payment data.");
    }
    return {
      eventId,
      eventType,
      completed: {
        eventId,
        orderId,
        orderVersion,
        checkoutId,
        amountMinor,
        currency: currency.toLowerCase(),
      },
    };
  }
}
