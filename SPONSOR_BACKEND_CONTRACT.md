# Contrato frontend de sponsors

El frontend no escribe tablas directamente. Todos los nombres se centralizan en
`src/sponsor-contract.js` y pueden configurarse con variables `VITE_*`.

## RPC asumidas

- `list_sponsorships()` devuelve filas públicas.
- `reserve_checkout(...)` reclama gratis un asset libre o reserva de forma
  atómica la orden para un takeover pago.
- `update_branding(...)` actualiza solamente si `auth.uid()` es el dueño.
- `free_claim_available()` devuelve sólo si el usuario autenticado y verificado
  todavía puede usar su único claim gratis.

`reserve_checkout` recibe `p_asset_id`, `p_company`, `p_target_url`,
`p_logo_path`, `p_color`, `p_animation`, `p_design`, `p_idempotency_key` (mínimo
8), `p_expected_asset_version` (nullable) y `p_ttl_seconds` (se envía 900).
Devuelve una orden: el claim gratuito tiene `amount_cents = 0` y
`status = completed`; purchase/takeover queda reservado con `amount_cents > 0` y
`asset_version`.

`update_branding` se invoca con `p_asset_id`, `p_company`, `p_target_url`,
`p_logo_path`, `p_color`, `p_animation` y `p_design`.

`list_sponsorships()` devuelve exactamente `id`, `asset_id`, `company`,
`target_url`, `logo_path`, `color`, `animation`, `design`, `mine`,
`created_at`, `next_price_cents`, `asset_version`, `branding_status` y
`can_takeover`. No devuelve `owner_id` ni otra identidad. Precio y
`can_takeover` controlan la UX del takeover.

`design` es un objeto JSON con claves numéricas exactas `x`, `y`, `scale` y
`rotation`. El backend lo valida, lo congela en la orden y lo devuelve en
`list_sponsorships()`. El dominio registrable de `target_url` también se
normaliza en PostgreSQL: no puede repetirse entre branding activo/pendiente ni
entre órdenes reservadas/pagadas. El cliente no decide esa disponibilidad.

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
