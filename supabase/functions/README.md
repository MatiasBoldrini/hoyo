# Payment Edge Functions

This directory contains two endpoints and a provider-independent payment core:

- `create-payment-checkout`: authenticated checkout creation.
- `payment-webhook`: public provider webhook, authenticated by a cryptographic signature rather than
  a Supabase JWT.

PayPal Orders v2 is the USD-oriented default candidate. Stripe Checkout remains optional and is
implemented without a client-side secret. The `dev` provider exists for local simulators only and
fails closed unless `APP_ENV` is `development` or `test` **and** `SUPABASE_URL` has a loopback
hostname.

Stripe is optional infrastructure, not an assumption that the merchant is eligible in Argentina or
any other country. `PAYMENT_PROVIDER=stripe` must be selected deliberately with credentials for a
real, supported Stripe account. Mercado Pago is not implemented because current takeovers are priced
in USD and no authoritative server-side USD→ARS quote/expiry contract exists; doing that conversion
in the client or Edge Function would make settlement unverifiable.

## Request contract

`POST /functions/v1/create-payment-checkout` requires a bearer token and:

```json
{
  "asset_id": "parcel-123",
  "company": "Example",
  "target_url": "https://example.com",
  "logo_path": "user-id/logo.webp",
  "color": "#112233",
  "animation": "float",
  "idempotency_key": "3f0f9e76-e46a-49a2-8ce8-44ee6377bb97",
  "expected_asset_version": 1,
  "success_url": "https://allowlisted.example/payment/success",
  "cancel_url": "https://allowlisted.example/payment/cancel"
}
```

No price, currency, owner, provider metadata, or status is accepted. Branding is persisted only
through the reserving RPC, which validates its values and ownership rules. Unknown top-level fields
are rejected. The URLs must have an exact origin in `PAYMENT_REDIRECT_ORIGINS`; browser origins must
also be in `CORS_ALLOWED_ORIGINS`. These settings are comma-separated exact origins, not wildcards.

Paid responses contain `checkoutId`, `checkoutUrl`, `orderId`, `orderVersion`, and `provider`. A
checkout response never means that payment completed; only verified provider data may complete it.
Free orders return `orderId`, `kind`, and `status=completed` without creating a provider checkout.

## Required database RPC contract

The SQL migration is intentionally not included. Coordinate the future schema around these RPCs. All
three should use a fixed `search_path`, revoke public execution unless explicitly listed below,
validate input again, and perform their state changes atomically.

### `reserve_checkout(p_asset_id, p_company, p_target_url, p_logo_path, p_color, p_animation, p_idempotency_key, p_expected_asset_version, p_ttl_seconds)`

- Executable by `authenticated`; use `auth.uid()`.
- Validate branding, then fetch the asset/product server-side and validate ownership, availability,
  asset version, payable status, and authoritative price.
- Create or reuse an open payment attempt for that user and sponsorship.
- Return exactly one row:

The returned order must include `id`, `kind`, `status`, `amount_cents`, `currency`, `asset_version`,
and `version`. An amount of zero is valid only for an order atomically returned as `completed`.

The function must not derive any of these values from request JSON.

### `attach_provider_checkout(p_order_id, p_expected_order_version, p_provider, p_provider_checkout_id)`

- Executable only by `service_role`.
- Attach the provider Checkout Session ID to the prepared attempt.
- Be idempotent for the same values and reject attempts already attached to different provider data.
- Add uniqueness on `(provider, provider_checkout_id)`.

### `finalize_payment(p_provider, p_provider_event_id, p_provider_checkout_id, p_order_id, p_expected_order_version, p_amount_cents, p_currency, p_event_type, p_payload)`

- Executable only by `service_role`.
- Lock the payment attempt and compare provider, checkout ID, amount, currency, and expected pending
  state with stored authoritative values.
- Insert the provider event under a unique `(provider, provider_event_id)` key. Repeated delivery of
  that event must return success without applying the transition twice.
- In the same transaction, mark the attempt paid and perform the domain transition (for example,
  activate the sponsorship). Never let event metadata select an arbitrary owner or sponsorship.
- If a second legitimate paid event for the same checkout arrives, return success when every stored
  payment fact matches; do not apply the transition again.
- Reject mismatches without changing domain state. Return value is intentionally ignored by the Edge
  Function.

The Edge Function uses the caller JWT for `reserve_checkout` and the service role only for the two
internal RPCs.

## PayPal setup

Set `PAYMENT_PROVIDER=paypal`, `PAYPAL_ENV=sandbox|live`, `PAYPAL_CLIENT_ID`,
`PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYMENT_RETURN_SECRET` (at least 32 random
characters), and the deployed `PAYPAL_CAPTURE_URL`. Register `/functions/v1/payment-webhook` in
PayPal for `PAYMENT.CAPTURE.COMPLETED`.

The create endpoint sends the authoritative USD amount and local `order_id` as PayPal `custom_id`.
The approval link returns to `payment-paypal-capture`, which validates an expiring HMAC state,
captures server-side, checks PayPal status `COMPLETED`, `custom_id`, exact USD amount, and then
calls the same idempotent completion RPC. A return URL or browser redirect alone never marks an
order paid.

The webhook is independently useful if the buyer does not return: it calls PayPal's official
`verify-webhook-signature` endpoint, retrieves the canonical PayPal order, and applies the same
checks. Configure secrets for one real merchant environment; sandbox credentials never imply live
merchant eligibility.

## Stripe setup

Set `PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET`. Configure Stripe to
send at least:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

to `/functions/v1/payment-webhook`. Metadata contains only the internal `order_id`; amount and
currency from the event are still matched by the completion RPC against database values.

## Local dev provider

Set `APP_ENV=development`, use a loopback `SUPABASE_URL`, set `PAYMENT_PROVIDER=dev`,
`DEV_CHECKOUT_URL`, and a random `DEV_WEBHOOK_SECRET` of at least 32 characters. The checkout URL
receives only a `order_id` query parameter.

A simulator may post this shape:

```json
{
  "id": "evt_unique",
  "type": "dev.checkout.completed",
  "data": {
    "object": {
      "id": "dev_payment-uuid",
      "client_reference_id": "order-uuid",
      "amount_total": 1000,
      "currency": "usd",
      "payment_status": "paid"
    }
  }
}
```

Sign the exact raw body as `hex(HMAC_SHA256(DEV_WEBHOOK_SECRET, timestamp + "." + rawBody))` and
send `X-Dev-Signature: t=<unix-seconds>,v1=<signature>`. Signatures older than five minutes are
rejected. The completion RPC still verifies amount/currency and idempotency, so the simulator cannot
override stored payment facts.

## Checks

From this directory:

```sh
deno task check
deno task test
deno fmt --check
deno lint
```
