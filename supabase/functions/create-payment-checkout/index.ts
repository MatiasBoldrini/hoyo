import { checkoutTtlSeconds, corsOrigin, validateRedirectUrl } from "../_shared/config.ts";
import { authenticate, preparePayment, recordCheckout } from "../_shared/database.ts";
import { HttpError } from "../_shared/errors.ts";
import { errorResponse, json, preflight, readJson, requirePost } from "../_shared/http.ts";
import { paymentProvider } from "../_shared/providers/index.ts";

Deno.serve(async (request) => {
  let origin: string | null = null;
  try {
    const options = preflight(request);
    if (options) return options;
    origin = corsOrigin(request);
    requirePost(request);

    const authorization = request.headers.get("authorization");
    await authenticate(authorization);
    const body = await readJson(request);
    const allowedKeys = new Set([
      "asset_id",
      "company",
      "target_url",
      "logo_path",
      "color",
      "animation",
      "design",
      "idempotency_key",
      "expected_asset_version",
      "success_url",
      "cancel_url",
    ]);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
      throw new HttpError(400, "invalid_request", "Unexpected request field.");
    }
    if (
      typeof body.asset_id !== "string" ||
      body.asset_id.length < 1 ||
      body.asset_id.length > 200
    ) {
      throw new HttpError(400, "invalid_request", "Invalid asset_id.");
    }
    if (
      typeof body.company !== "string" ||
      body.company.length < 1 ||
      body.company.length > 24 ||
      (body.target_url != null &&
        (typeof body.target_url !== "string" || body.target_url.length > 2048)) ||
      (body.logo_path != null &&
        (typeof body.logo_path !== "string" || body.logo_path.length > 550)) ||
      typeof body.color !== "string" ||
      typeof body.animation !== "string" ||
      (body.design != null && (typeof body.design !== "object" || Array.isArray(body.design))) ||
      typeof body.idempotency_key !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(body.idempotency_key) ||
      !Number.isSafeInteger(body.expected_asset_version) ||
      Number(body.expected_asset_version) < 1
    ) {
      throw new HttpError(400, "invalid_request", "Invalid checkout data.");
    }
    // The user-scoped RPC is the authority for ownership, state, amount and currency.
    const payment = await preparePayment({
      assetId: body.asset_id,
      company: body.company,
      targetUrl: (body.target_url as string | null | undefined) ?? null,
      logoPath: (body.logo_path as string | null | undefined) ?? null,
      color: body.color,
      animation: body.animation,
      design: (body.design as Record<string, unknown> | null | undefined) ?? null,
      idempotencyKey: body.idempotency_key,
      expectedAssetVersion: Number(body.expected_asset_version),
      ttlSeconds: checkoutTtlSeconds(),
    }, authorization!);

    if (payment.amountMinor === 0) {
      if (payment.status !== "completed") {
        throw new Error("Free order was not completed by reserve_checkout");
      }
      return json(
        {
          orderId: payment.orderId,
          kind: payment.kind,
          status: payment.status,
        },
        201,
        origin,
      );
    }

    const provider = paymentProvider();
    const redirects = {
      successUrl: validateRedirectUrl(body.success_url),
      cancelUrl: validateRedirectUrl(body.cancel_url),
    };
    let checkout = await provider.createCheckout(payment, redirects);
    const expectedAttachedVersion = payment.version + 1;
    checkout = await provider.setCheckoutOrderVersion(
      checkout,
      payment.orderId,
      expectedAttachedVersion,
    );
    const attachedVersion = await recordCheckout(
      payment.orderId,
      payment.version,
      provider.name,
      checkout.id,
    );
    if (attachedVersion !== expectedAttachedVersion) {
      throw new Error("attach_provider_checkout returned an unexpected order version");
    }

    return json(
      {
        checkoutId: checkout.id,
        checkoutUrl: checkout.url,
        orderId: payment.orderId,
        orderVersion: attachedVersion,
        status: payment.status,
        provider: provider.name,
      },
      201,
      origin,
    );
  } catch (error) {
    if (!(error instanceof HttpError)) {
      console.error("Create checkout failed", {
        name: error instanceof Error ? error.name : "unknown",
      });
    }
    return errorResponse(error, origin);
  }
});
