import { devProviderConfig } from "../config.ts";
import { verifyTimestampedSignature } from "../crypto.ts";
import type { PreparedPayment } from "../database.ts";
import { HttpError } from "../errors.ts";
import type { Checkout, PaymentProvider, WebhookResult } from "./provider.ts";

export class DevProvider implements PaymentProvider {
  readonly name = "dev" as const;

  createCheckout(
    payment: PreparedPayment,
    _redirects: { successUrl: string; cancelUrl: string },
  ): Promise<Checkout> {
    const config = devProviderConfig();
    const url = new URL(config.checkoutUrl);
    url.searchParams.set("order_id", payment.orderId);
    return Promise.resolve({ id: `dev_${payment.orderId}`, url: url.toString() });
  }

  setCheckoutOrderVersion(
    checkout: Checkout,
    _orderId: string,
    orderVersion: number,
  ): Promise<Checkout> {
    const url = new URL(checkout.url);
    url.searchParams.set("order_version", String(orderVersion));
    return Promise.resolve({ ...checkout, url: url.toString() });
  }

  async verifyAndParseWebhook(body: string, headers: Headers): Promise<WebhookResult> {
    const config = devProviderConfig();
    const valid = await verifyTimestampedSignature({
      header: headers.get("x-dev-signature"),
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
    if (
      typeof event?.id !== "string" ||
      typeof event?.type !== "string"
    ) {
      throw new HttpError(400, "invalid_webhook", "Invalid webhook payload.");
    }
    if (event.type !== "dev.checkout.completed") {
      return { completed: null, eventId: event.id, eventType: event.type };
    }
    const checkout = event?.data?.object;
    if (
      checkout?.payment_status !== "paid" ||
      typeof checkout?.client_reference_id !== "string" ||
      typeof checkout?.id !== "string" ||
      !Number.isSafeInteger(checkout?.order_version) ||
      !Number.isSafeInteger(checkout?.amount_total) ||
      checkout.amount_total <= 0 ||
      typeof checkout?.currency !== "string"
    ) {
      throw new HttpError(400, "invalid_webhook", "Incomplete payment data.");
    }
    return {
      eventId: event.id,
      eventType: event.type,
      completed: {
        eventId: event.id,
        orderId: checkout.client_reference_id,
        orderVersion: checkout.order_version,
        checkoutId: checkout.id,
        amountMinor: checkout.amount_total,
        currency: checkout.currency.toLowerCase(),
      },
    };
  }
}
