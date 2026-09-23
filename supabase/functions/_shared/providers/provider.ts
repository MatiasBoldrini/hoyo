import type { PreparedPayment } from "../database.ts";

export interface Checkout {
  id: string;
  url: string;
}

export interface CompletedPayment {
  eventId: string;
  orderId: string;
  orderVersion: number;
  checkoutId: string;
  amountMinor: number;
  currency: string;
}

export interface WebhookResult {
  completed: CompletedPayment | null;
  eventId: string;
  eventType: string;
}

export interface PaymentProvider {
  readonly name: "paypal" | "stripe" | "dev";
  createCheckout(
    payment: PreparedPayment,
    redirects: { successUrl: string; cancelUrl: string },
  ): Promise<Checkout>;
  setCheckoutOrderVersion(
    checkout: Checkout,
    orderId: string,
    orderVersion: number,
  ): Promise<Checkout>;
  verifyAndParseWebhook(body: string, headers: Headers): Promise<WebhookResult>;
}
