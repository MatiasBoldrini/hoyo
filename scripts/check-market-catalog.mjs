import { readFile } from "node:fs/promises";

const catalogPath = new URL("../src/market-catalog.json", import.meta.url);
const migrationPath = new URL(
  "../supabase/migrations/20260923131000_market_catalog.sql",
  import.meta.url,
);
const idPattern = /^[a-z0-9][a-z0-9_-]{0,127}$/;

const [{ items }, migration] = await Promise.all([
  readFile(catalogPath, "utf8").then(JSON.parse),
  readFile(migrationPath, "utf8"),
]);

const failures = [];
const seen = new Set();
for (const [index, item] of items.entries()) {
  const [id, name] = item;
  if (!idPattern.test(id)) failures.push(`ID inválido en ${index}: ${id}`);
  if (seen.has(id)) failures.push(`ID duplicado: ${id}`);
  if (typeof name !== "string" || name.length === 0 || name.length > 100) {
    failures.push(`Nombre inválido para ${id}`);
  }
  seen.add(id);
}

const objectArray = migration.match(
  /from unnest\(array\[\s*([\s\S]*?)\s*\]::text\[\]\) with ordinality/,
);
if (!objectArray) {
  failures.push("No se encontró el catálogo de objetos en la migración");
}
const sqlObjects = objectArray
  ? [...objectArray[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  : [];
const expectedObjects = items
  .filter(([id]) => !id.startsWith("parcel-"))
  .map(([id]) => id);
if (JSON.stringify(sqlObjects) !== JSON.stringify(expectedObjects)) {
  failures.push("Los objetos de la migración no coinciden con market-catalog.json");
}
const labels = Object.fromEntries(
  [...migration.matchAll(/when '([^']+)' then '([^']+)'/g)].map(
    ([, kind, label]) => [kind, label],
  ),
);
const categoryOrdinals = {};
const sqlObjectNames = sqlObjects.map((id) => {
  const [category, kind] = id.split("-");
  categoryOrdinals[category] = (categoryOrdinals[category] ?? 0) + 1;
  return `${labels[kind] ?? "Activo"} ${String(categoryOrdinals[category]).padStart(2, "0")}`;
});
const expectedObjectNames = items
  .filter(([id]) => !id.startsWith("parcel-"))
  .map(([, name]) => name);
if (JSON.stringify(sqlObjectNames) !== JSON.stringify(expectedObjectNames)) {
  failures.push("Los nombres de objetos de la migración no coinciden con el juego");
}

const parcelInsert = migration.match(
  /insert into public\.market_assets \(id, category, name, metadata, is_enabled\)\s*values\s*([\s\S]*?)\s*on conflict \(id\) do update/,
);
const sqlParcels = parcelInsert
  ? [...parcelInsert[1].matchAll(/\('([^']+)', '([^']+)'\)/g)].map(
      ([, id, name]) => [id, name],
    )
  : [];
const expectedParcels = items.filter(([id]) => id.startsWith("parcel-"));
if (JSON.stringify(sqlParcels) !== JSON.stringify(expectedParcels)) {
  failures.push("Las parcelas de la migración no coinciden con market-catalog.json");
}

const categories = Object.fromEntries(
  ["parcel", "building", "vehicle", "place"].map((category) => [
    category,
    items.filter(([id]) => id.startsWith(`${category}-`)).length,
  ]),
);
if (items.length !== 1373) {
  failures.push(`Se esperaban 1373 assets y hay ${items.length}`);
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Catálogo válido: ${items.length} assets`);
  console.log(
    Object.entries(categories)
      .map(([category, count]) => `${category}: ${count}`)
      .join(", "),
  );
}
