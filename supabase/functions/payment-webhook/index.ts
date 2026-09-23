import { completePayment } from "../_shared/database.ts";
import { HttpError } from "../_shared/errors.ts";
import { errorResponse, json, requirePost } from "../_shared/http.ts";
import { paymentProvider } from "../_shared/providers/index.ts";

Deno.serve(async (request) => {
  try {
    requirePost(request);
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > 262_144) {
      throw new HttpError(413, "payload_too_large", "Request payload is too large.");
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 262_144) {
      throw new HttpError(413, "payload_too_large", "Request payload is too large.");
    }

    const provider = paymentProvider();
    const event = await provider.verifyAndParseWebhook(body, request.headers);
    if (!event.completed) {
      console.info("Payment webhook ignored", {
        provider: provider.name,
        eventId: event.eventId,
        eventType: event.eventType,
      });
      return json({ received: true });
    }

    await completePayment({
      eventId: event.completed.eventId,
      eventType: event.eventType,
      orderId: event.completed.orderId,
      expectedOrderVersion: event.completed.orderVersion,
      provider: provider.name,
      providerCheckoutId: event.completed.checkoutId,
      amountMinor: event.completed.amountMinor,
      currency: event.completed.currency,
    });
    console.info("Payment webhook completed", {
      provider: provider.name,
      eventId: event.eventId,
    });
    return json({ received: true });
  } catch (error) {
    if (!(error instanceof HttpError)) {
      console.error("Payment webhook failed", {
        name: error instanceof Error ? error.name : "unknown",
      });
    }
    return errorResponse(error, null);
  }
});
