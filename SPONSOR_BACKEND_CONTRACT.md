# Contrato frontend de sponsors

El frontend no escribe tablas directamente. Todos los nombres se centralizan en
`src/sponsor-contract.js` y pueden configurarse con variables `VITE_*`.

## RPC asumidas

- `list_sponsorships()` devuelve filas públicas.
- `reserve_checkout(...)` reclama gratis un asset libre o reserva de forma
  atómica la orden para un takeover pago.
- `update_branding(...)` actualiza solamente si `auth.uid()` es el dueño.

`reserve_checkout` recibe `p_asset_id`, `p_company`, `p_target_url`,
`p_logo_path`, `p_color`, `p_animation`, `p_idempotency_key` (mínimo 8),
`p_expected_asset_version` (nullable) y `p_ttl_seconds` (se envía 900). Devuelve
una orden: el claim gratuito tiene `amount_cents = 0` y `status = completed`;
purchase/takeover queda reservado con `amount_cents > 0` y `asset_version`.

`update_branding` se invoca con `p_asset_id`, `p_company`, `p_target_url`,
`p_logo_path`, `p_color` y `p_animation`.

Campos de salida usados: `id`, `asset_id`, `company`, `target_url`, `logo_path`,
`color`, `animation`, `owner_id`, `created_at`, `next_price_usd`,
`protected_until`, `can_takeover` y `asset_version`. Precio y protección controlan la UX del
takeover; `can_takeover` ausente se interpreta como `true`.

## Storage y checkout

El bucket configurable `sponsor-logos` debe aceptar uploads autenticados sólo
bajo `${auth.uid()}/...`. En RPC/Edge se envía exclusivamente `logo_path`; no se
aceptan URLs arbitrarias ni `logo_url`.

Para un takeover, `reserve_checkout` debe devolver `order_id` (también se tolera
`orderId`). La Edge Function configurable `create-checkout` recibe `orderId`,
`successUrl` y `cancelUrl`; la marca ya quedó asociada a la orden reservada.

Devuelve `checkoutUrl`, `checkoutId`, `orderId` y `provider`. Hosts adicionales se
configuran con `VITE_CHECKOUT_HOSTS` (lista separada por comas). La URL de
retorno sólo informa que el usuario volvió; el frontend nunca la interpreta
como confirmación. La confirmación debe llegar por webhook y reflejarse en
`list_sponsorships`.
