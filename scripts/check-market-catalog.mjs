import { readFile } from "node:fs/promises";

const catalogPath = new URL("../src/market-catalog.json", import.meta.url);
const gamePath = new URL("../src/game.js", import.meta.url);
const migrationPath = new URL(
  "../supabase/migrations/20260923131000_market_catalog.sql",
  import.meta.url,
);
const idPattern =
  /^(building-(?:shop|building|tower)|place-(?:kiosk|fountain))-[mp]\d+-[mp]\d+$/;

const [{ items }, game, migration] = await Promise.all([
  readFile(catalogPath, "utf8").then(JSON.parse),
  readFile(gamePath, "utf8"),
  readFile(migrationPath, "utf8"),
]);

const failures = [];
const seen = new Set();
for (const [index, entry] of items.entries()) {
  if (!Array.isArray(entry) || entry.length !== 2) {
    failures.push(`Entrada inválida en ${index}`);
    continue;
  }
  const [id, name] = entry;
  if (!idPattern.test(id)) failures.push(`ID no curado o inestable en ${index}: ${id}`);
  if (seen.has(id)) failures.push(`ID duplicado: ${id}`);
  if (typeof name !== "string" || name.length === 0 || name.length > 100) {
    failures.push(`Nombre inválido para ${id}`);
  }
  if (!migration.includes(`'${id}'`)) {
    failures.push(`El activo curado no existe en el catálogo de backend: ${id}`);
  }
  seen.add(id);
}

for (const expected of [
  'const MARKET_BUILDINGS = new Set(["shop", "building", "tower"])',
  'const MARKET_LANDMARKS = new Set(["kiosk", "fountain"])',
  'import marketCatalog from "./market-catalog.json"',
]) {
  if (!game.includes(expected)) failures.push(`game.js no conserva la regla de catálogo: ${expected}`);
}

if (items.length !== 83) {
  failures.push(`Se esperaban 83 soportes curados y hay ${items.length}`);
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  const categories = Object.fromEntries(
    ["building", "place"].map((category) => [
      category,
      items.filter(([id]) => id.startsWith(`${category}-`)).length,
    ]),
  );
  console.log(`Catálogo curado válido: ${items.length} soportes con IDs estables`);
  console.log(
    Object.entries(categories)
      .map(([category, count]) => `${category}: ${count}`)
      .join(", "),
  );
}
