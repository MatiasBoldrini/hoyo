import { paypalConfig } from "../_shared/config.ts";
import { verifyState } from "../_shared/crypto.ts";
import { completePayment } from "../_shared/database.ts";
import { HttpError } from "../_shared/errors.ts";
import { errorResponse, requirePost } from "../_shared/http.ts";
import { PayPalProvider } from "../_shared/providers/paypal.ts";

interface ReturnState {
  orderId: string;
  successUrl: string;
  exp: number;
}

Deno.serve(async (request) => {
  try {
    // PayPal returns the buyer with GET. POST is also accepted for test clients,
    // but no request body or caller-supplied payment facts are consumed.
    if (request.method !== "GET" && request.method !== "POST") requirePost(request);
    const url = new URL(request.url);
    const providerOrderId = url.searchParams.get("token");
    const state = url.searchParams.get("state");
    if (!providerOrderId || !state) {
      throw new HttpError(400, "invalid_request", "Missing PayPal return data.");
    }
    const config = paypalConfig();
    const returnState = await verifyState<ReturnState>(state, config.returnSecret);
    if (
      !returnState ||
      typeof returnState.orderId !== "string" ||
      typeof returnState.successUrl !== "string" ||
      !Number.isSafeInteger(returnState.exp) ||
      returnState.exp < Math.floor(Date.now() / 1000)
    ) {
      throw new HttpError(400, "invalid_state", "Invalid or expired payment return.");
    }

    const provider = new PayPalProvider();
    const payment = await provider.captureOrder(providerOrderId, returnState.orderId);
    await completePayment({
      eventId: payment.eventId,
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      orderId: payment.orderId,
      expectedOrderVersion: payment.orderVersion,
      provider: provider.name,
      providerCheckoutId: payment.checkoutId,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
    });
    return Response.redirect(returnState.successUrl, 303);
  } catch (error) {
    if (!(error instanceof HttpError)) {
      console.error("PayPal capture return failed", {
        name: error instanceof Error ? error.name : "unknown",
      });
    }
    return errorResponse(error, null);
  }
});
