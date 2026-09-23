import { validateRedirectUrl } from "./config.ts";
import { HttpError } from "./errors.ts";

Deno.test("redirects require an exact allowlisted origin", () => {
  Deno.env.set("PAYMENT_REDIRECT_ORIGINS", "https://app.example.com,http://localhost:5173");
  try {
    const accepted = validateRedirectUrl("https://app.example.com/payment/success?order=1");
    if (accepted !== "https://app.example.com/payment/success?order=1") {
      throw new Error("allowed redirect changed unexpectedly");
    }
    for (
      const rejected of [
        "https://evil.example/payment/success",
        "https://app.example.com.evil.example/payment/success",
        "http://app.example.com/payment/success",
        "https://app.example.com/payment/success#token",
      ]
    ) {
      try {
        validateRedirectUrl(rejected);
        throw new Error(`accepted ${rejected}`);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
      }
    }
  } finally {
    Deno.env.delete("PAYMENT_REDIRECT_ORIGINS");
  }
});
