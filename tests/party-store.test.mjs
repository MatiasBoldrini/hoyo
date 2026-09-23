import test from "node:test";
import assert from "node:assert/strict";

import {
  hasPendingAuthCallback,
  normalizePartyCode,
  partyRoomFromRow,
  partyStoreEnabled,
} from "../src/party-store.js";

test("Party store stays disabled without browser Vite credentials", () => {
  assert.equal(partyStoreEnabled, false);
});

test("party codes are normalized without accepting ambiguous characters", () => {
  assert.equal(normalizePartyCode("  abcd2345 "), "ABCD2345");
  assert.equal(normalizePartyCode(null), "");
});

test("Magic Link callbacks are detected in PKCE and implicit flows", () => {
  assert.equal(hasPendingAuthCallback({ search: "?code=pkce-code", hash: "" }), true);
  assert.equal(
    hasPendingAuthCallback({ search: "", hash: "#access_token=jwt&refresh_token=refresh" }),
    true,
  );
  assert.equal(hasPendingAuthCallback({ search: "?party=ABCD2345", hash: "" }), false);
});

test("database rows retain the public Party room shape", () => {
  assert.deepEqual(
    partyRoomFromRow({
      id: "room",
      code: "ABCD2345",
      host_id: "host",
      duration_seconds: 120,
      bot_count: 3,
      object_refill: 2,
      status: "playing",
      started_at: "2026-09-23T13:30:00.000Z",
      expires_at: "2026-09-23T14:30:00.000Z",
    }),
    {
      id: "room",
      code: "ABCD2345",
      hostId: "host",
      duration: 120,
      botCount: 3,
      objectRefill: 2,
      status: "playing",
      startedAt: Date.parse("2026-09-23T13:30:00.000Z"),
      expiresAt: Date.parse("2026-09-23T14:30:00.000Z"),
    },
  );
});
