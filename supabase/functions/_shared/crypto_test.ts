import {
  hmacSha256Hex,
  signState,
  timingSafeEqual,
  verifyState,
  verifyTimestampedSignature,
} from "./crypto.ts";

Deno.test("timestamped webhook signatures are verified with replay tolerance", async () => {
  const body = '{"id":"evt_1"}';
  const timestamp = 1_700_000_000;
  const signature = await hmacSha256Hex("test-secret", `${timestamp}.${body}`);

  if (
    !await verifyTimestampedSignature({
      header: `t=${timestamp},v1=${signature}`,
      body,
      secret: "test-secret",
      now: timestamp + 299,
    })
  ) throw new Error("valid signature was rejected");

  if (
    await verifyTimestampedSignature({
      header: `t=${timestamp},v1=${signature}`,
      body,
      secret: "test-secret",
      now: timestamp + 301,
    })
  ) throw new Error("expired signature was accepted");
});

Deno.test("constant-time comparison handles unequal values and lengths", () => {
  if (!timingSafeEqual("same", "same")) throw new Error("equal values rejected");
  if (timingSafeEqual("same", "different")) throw new Error("unequal values accepted");
  if (timingSafeEqual("short", "shorter")) throw new Error("unequal lengths accepted");
});

Deno.test("signed return state rejects tampering", async () => {
  const secret = "a-secret-with-more-than-thirty-two-characters";
  const state = await signState({ orderId: "order-1", exp: 123 }, secret);
  const parsed = await verifyState<{ orderId: string }>(state, secret);
  if (parsed?.orderId !== "order-1") throw new Error("valid state rejected");
  if (await verifyState(`${state.slice(0, -1)}0`, secret)) {
    throw new Error("tampered state accepted");
  }
});
