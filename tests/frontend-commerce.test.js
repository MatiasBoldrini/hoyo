import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("el inventario comercial usa IDs curados y estables", async () => {
  const { items } = JSON.parse(await readFile(new URL("src/market-catalog.json", root), "utf8"));
  assert.equal(items.length, 83);
  assert.equal(new Set(items.map(([id]) => id)).size, items.length);
  for (const [id] of items) {
    assert.match(
      id,
      /^(building-(?:shop|building|tower)|place-(?:kiosk|fountain))-[mp]\d+-[mp]\d+$/,
    );
  }
});

test("commerce permanece detrás de sesión y APIs seguras", async () => {
  const [store, explore] = await Promise.all([
    readFile(new URL("src/sponsor-store.js", root), "utf8"),
    readFile(new URL("src/city-explore.js", root), "utf8"),
  ]);
  assert.match(store, /user\.is_anonymous/);
  assert.match(store, /SPONSOR_CONTRACT\.functions\.checkout/);
  assert.match(store, /SPONSOR_CONTRACT\.rpc\.updateBranding/);
  assert.match(store, /createSignedUrls/);
  assert.match(store, /design: record\.design/);
  assert.doesNotMatch(store, /\.from\("sponsorships"\)\s*\.(?:insert|upsert|update|delete)/s);
  assert.match(explore, /sendMagicLink/);
  assert.match(explore, /No se puede publicar sin conexión al servidor/);
});
