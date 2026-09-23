// Contrato frontend centralizado. Ver SPONSOR_BACKEND_CONTRACT.md antes de
// adaptar migraciones o Edge Functions.
export const SPONSOR_CONTRACT = Object.freeze({
  table: import.meta.env.VITE_SPONSOR_REALTIME_TABLE || "sponsorship_signals",
  logoBucket: import.meta.env.VITE_SPONSOR_LOGO_BUCKET || "sponsor-logos",
  rpc: Object.freeze({
    list: import.meta.env.VITE_SPONSOR_LIST_RPC || "list_sponsorships",
    updateBranding: import.meta.env.VITE_SPONSOR_UPDATE_RPC || "update_branding",
  }),
  functions: Object.freeze({
    checkout: import.meta.env.VITE_SPONSOR_CHECKOUT_FUNCTION || "create-payment-checkout",
  }),
  checkoutHosts: (
    import.meta.env.VITE_CHECKOUT_HOSTS ||
    "www.paypal.com,www.sandbox.paypal.com,checkout.stripe.com"
  )
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean),
});
