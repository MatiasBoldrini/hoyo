import { devProviderConfig, paymentProviderName, paypalConfig, stripeConfig } from "../config.ts";
import { DevProvider } from "./dev.ts";
import { PayPalProvider } from "./paypal.ts";
import type { PaymentProvider } from "./provider.ts";
import { StripeProvider } from "./stripe.ts";

export function paymentProvider(): PaymentProvider {
  const name = paymentProviderName();
  // Validate provider secrets before reserving an order in the database.
  if (name === "paypal") {
    paypalConfig();
    return new PayPalProvider();
  }
  if (name === "stripe") {
    stripeConfig();
    return new StripeProvider();
  }
  devProviderConfig();
  return new DevProvider();
}
