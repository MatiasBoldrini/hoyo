import test from "node:test";
import assert from "node:assert/strict";
import { sponsorDomain } from "../src/sponsor-domain.js";

test("groups paths and subdomains under one sponsor domain", () => {
  assert.equal(sponsorDomain("https://promo.marca.com/oferta"), "marca.com");
  assert.equal(sponsorDomain("tienda.marca.com"), "marca.com");
  assert.equal(sponsorDomain("https://www.marca.com/otra-cosa"), "marca.com");
});

test("keeps the registrable label for common country suffixes", () => {
  assert.equal(sponsorDomain("https://campana.marca.com.ar"), "marca.com.ar");
  assert.equal(sponsorDomain("https://marca.co.uk"), "marca.co.uk");
});

test("does not merge unrelated domains", () => {
  assert.notEqual(sponsorDomain("marca.com"), sponsorDomain("otra-marca.com"));
});

test("preserves IP hosts and rejects unsupported URLs", () => {
  assert.equal(sponsorDomain("http://127.0.0.1:5173/demo"), "127.0.0.1");
  assert.equal(sponsorDomain("javascript:alert(1)"), "");
  assert.equal(sponsorDomain(""), "");
});
