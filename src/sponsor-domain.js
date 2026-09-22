const COMMON_SECOND_LEVEL_LABELS = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "gob",
  "gov",
  "mil",
  "net",
  "nom",
  "org",
  "tur",
]);

function withProtocol(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
}

export function sponsorDomain(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(withProtocol(raw));
    if (!["http:", "https:"].includes(url.protocol)) return "";
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    if (!hostname || hostname === "localhost" || hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(hostname)) {
      return hostname;
    }

    const labels = hostname.split(".").filter(Boolean);
    if (labels.length < 2) return hostname;
    const tld = labels.at(-1);
    const secondLevel = labels.at(-2);
    const compoundCountrySuffix =
      labels.length >= 3 && tld.length === 2 && COMMON_SECOND_LEVEL_LABELS.has(secondLevel);
    return (compoundCountrySuffix ? labels.slice(-3) : labels.slice(-2)).join(".");
  } catch {
    return "";
  }
}
