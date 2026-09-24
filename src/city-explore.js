import { sponsorDomain } from "./sponsor-domain.js";

const BRAND_COLORS = ["#2257e6", "#f05a35", "#111827", "#16a06d", "#8b5cf6", "#eab308"];
const PLACE_COLORS = ["#f6efe2", "#e8c39a", "#d06a45", "#8ea4ae", "#6e947c", "#4d6270", "#e2b43a"];
const STORAGE_KEY = "hoyo-market-places-v2";
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"];
const DEFAULT_DESIGN = { x: 0.5, y: 0.5, scale: 0.46, rotation: 0 };
const SYNC_COPY = {
  online: "",
  offline: "Sólo lectura: se necesita conexión segura para publicar.",
  local: "Sin conexión con la ciudad: se guarda solo en este navegador.",
};
const MOVE_KEYS = ["KeyW", "KeyA", "KeyS", "KeyD"];

const dateFormat = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", year: "numeric" });

function safeUrl(value) {
  const raw = value.trim();
  if (!raw) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function displayUrl(url) {
  try {
    const { hostname, pathname } = new URL(url);
    return `${hostname.replace(/^www\./, "")}${pathname === "/" ? "" : pathname}`;
  } catch {
    return url;
  }
}

function formatDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? dateFormat.format(date) : "";
}

function initials(company) {
  return company.trim().slice(0, 2).toUpperCase();
}

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

function normalizeDesign(design) {
  return {
    x: clamp(design?.x, 0.05, 0.95, DEFAULT_DESIGN.x),
    y: clamp(design?.y, 0.05, 0.95, DEFAULT_DESIGN.y),
    scale: clamp(design?.scale, 0.18, 0.82, DEFAULT_DESIGN.scale),
    rotation: clamp(design?.rotation, -45, 45, DEFAULT_DESIGN.rotation),
  };
}

function readSurface(design) {
  const color = String(design?.surface || "").toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : "";
}

function readParts(design) {
  const source = design?.parts;
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const parts = {};
  for (const [key, value] of Object.entries(source)) {
    const id = String(key).replace("#", "").toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(id)) continue;
    const color = readSurface({ surface: value });
    if (color) parts[id] = color;
  }
  return parts;
}

function publishedDesign(design, surface, parts) {
  const next = { ...design };
  delete next.surface;
  delete next.parts;
  if (surface) next.surface = surface;
  const clean = readParts({ parts });
  if (Object.keys(clean).length) next.parts = clean;
  return next;
}

function sameParts(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of keys) if (a?.[key] !== b?.[key]) return false;
  return true;
}

function sameDesign(a, b) {
  return ["x", "y", "scale", "rotation"].every((key) => Math.abs(a[key] - b[key]) < 0.001);
}

function searchKey(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es");
}

function readCache() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeCache(records) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records.map((record) => ({ ...record, logo: "" }))));
  }
}

function canvasToWebp(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob || blob.type !== "image/webp") {
        reject(new Error("No pudimos guardar la imagen como WebP."));
        return;
      }
      resolve(blob);
    }, "image/webp", 0.8);
  });
}

async function compactImage(file) {
  if (!LOGO_TYPES.includes(file.type)) throw new Error("Usá una imagen PNG, JPG o WebP.");
  if (file.size > 8 * 1024 * 1024) throw new Error("La imagen pesa más de 8 MB.");
  const source = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const scale = Math.min(256 / source.width, 256 / source.height, 1);
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close();
  const blob = await canvasToWebp(canvas);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("No pudimos leer la imagen comprimida."));
    reader.readAsDataURL(blob);
  });
}

function paintMark(element, { company, logo, color }) {
  element.style.setProperty("--brand", color);
  element.style.backgroundImage = logo ? `url("${logo}")` : "";
  element.classList.toggle("has-logo", Boolean(logo));
  element.classList.toggle("is-empty", !logo && !company.trim());
}

export async function mountCityExplore(game) {
  const $ = (selector) => document.querySelector(selector);
  const canvas = $("#view");
  const menu = $("#menu");
  const root = $("#city-explore");
  const openButton = $("#open-explore");
  const closeButton = $("#explore-close");
  const help = $("#explore-help");
  const notice = $("#explore-notice");
  const sessionLabel = $("#explore-session");
  const logoutButton = $("#explore-logout");

  const directory = $("#explore-directory");
  const directoryOpen = $("#explore-directory-open");
  const directoryClose = $("#explore-directory-close");
  const directoryCount = $("#explore-directory-count");
  const directorySearch = $("#explore-directory-search");
  const directoryList = $("#explore-directory-list");
  const directoryEmpty = $("#explore-directory-empty");

  const panel = $("#explore-editor");
  const panelClose = $("#explore-editor-close");
  const listingTitle = $("#listing-title");
  const listingStatus = $("#listing-status");
  const listingDescription = $("#listing-description");

  const owner = $("#listing-owner");
  const ownerMark = $("#owner-mark");
  const ownerName = $("#owner-name");
  const ownerSince = $("#owner-since");
  const ownerLink = $("#owner-link");
  const ownerLinkText = $("#owner-link-text");

  const form = $("#explore-form");
  const authForm = $("#explore-auth-form");
  const authEmail = $("#explore-auth-email");
  const authSend = $("#explore-auth-send");
  const authStatus = $("#explore-auth-status");
  const designCanvas = $("#editor-design-canvas");
  const designContext = designCanvas.getContext("2d");
  const designHint = $("#editor-preview-context");
  const designScale = $("#editor-design-scale");
  const designRotation = $("#editor-design-rotation");
  const designReset = $("#editor-design-reset");
  const logoDrop = $("#logo-drop");
  const logoInitials = $("#brand-mark-initials");
  const brandLogo = $("#brand-logo");
  const logoRemove = $("#brand-logo-remove");
  const logoError = $("#brand-logo-error");
  const brandName = $("#brand-name");
  const brandNameCount = $("#brand-name-count");
  const brandUrl = $("#brand-url");
  const colors = $("#brand-colors");
  const colorValue = $("#brand-color-value");
  const placeColors = $("#place-colors");
  const placeParts = $("#place-parts");
  const placeColorValue = $("#place-color-value");
  const releaseButton = $("#listing-release");

  const formError = $("#explore-form-error");
  const checkoutLabel = $("#checkout-label");
  const checkoutPrice = $("#checkout-price");
  const saveButton = $("#explore-save");
  const claimStatus = $("#claim-status");
  const syncLine = $("#listing-sync");

  const inventory = game.getCityItems();
  const inInventory = (record) => inventory.some((item) => item.id === record.itemId);
  let records = readCache()
    .map((record) => {
      const item = inventory.find((candidate) => candidate.id === record.itemId || candidate.legacyId === record.itemId);
      return item ? { ...record, itemId: item.id, animation: "fixed" } : null;
    })
    .filter(Boolean);
  let store = null;
  let currentSession = null;
  let selected = null;
  let draft = null;
  let saving = false;
  let designDragging = false;
  let designerImage = null;
  let designerImageSource = "";
  let pointerDown = false;
  let pointerMoved = false;
  let pointerInside = false;
  let pointerStartedWhileEditing = false;
  let pointerDownX = 0;
  let pointerDownY = 0;
  let pointerX = 0;
  let pointerY = 0;
  let previewTimer = 0;
  let flashTimer = 0;
  let releaseTimer = 0;
  let hoverFrame = 0;
  let placePartId = "";

  game.setBrandings(records);

  const recordFor = (item) => records.find((record) => record.itemId === item?.id);
  const stateFor = (record) => (!record ? "available" : record.mine ? "mine" : "taken");
  const domainConflictFor = (value) => {
    const domain = sponsorDomain(value);
    if (!domain) return null;
    const record = records.find(
      (candidate) => candidate.itemId !== selected?.id && sponsorDomain(candidate.url) === domain,
    );
    return record ? { domain, record } : null;
  };

  function draftFrom(record) {
    return {
      company: record?.company || "",
      url: record?.url || "",
      logo: record?.logo || "",
      logoPath: record?.logoPath || "",
      color: (record?.color || BRAND_COLORS[0]).toLowerCase(),
      surface: readSurface(record?.design),
      parts: readParts(record?.design),
      design: normalizeDesign(record?.design),
    };
  }

  function previewRecord() {
    return {
      itemId: selected.id,
      company: draft.company.trim() || "Tu marca",
      url: safeUrl(draft.url),
      logo: draft.logo,
      logoPath: draft.logoPath,
      color: draft.color,
      animation: "fixed",
      design: publishedDesign(draft.design, draft.surface, draft.parts),
      mine: true,
    };
  }

  function isDirty() {
    const record = recordFor(selected);
    if (!record?.mine) return true;
    const saved = draftFrom(record);
    return (
      draft.company.trim() !== saved.company ||
      safeUrl(draft.url) !== saved.url ||
      draft.logo !== saved.logo ||
      draft.color !== saved.color ||
      draft.surface !== saved.surface ||
      !sameParts(draft.parts, saved.parts) ||
      !sameDesign(draft.design, saved.design)
    );
  }

  function setSyncLine(message, tone) {
    syncLine.textContent = message;
    syncLine.hidden = !message;
    if (tone) syncLine.dataset.tone = tone;
    else delete syncLine.dataset.tone;
  }

  function flash(message, tone = "success") {
    clearTimeout(flashTimer);
    setSyncLine(message, tone);
    flashTimer = window.setTimeout(() => {
      setSyncLine(store ? SYNC_COPY.online : SYNC_COPY.offline);
    }, 2800);
  }

  function showError(message) {
    formError.textContent = message;
    formError.hidden = !message;
  }

  function renderColors() {
    colors.replaceChildren();
    const custom = !BRAND_COLORS.includes(draft.color.toLowerCase());
    for (const color of BRAND_COLORS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "brand-swatch";
      button.style.setProperty("--swatch", color);
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(color === draft.color.toLowerCase()));
      button.setAttribute("aria-label", `Color ${color.toUpperCase()}`);
      button.addEventListener("click", () => setColor(color));
      colors.append(button);
    }
    const picker = document.createElement("label");
    picker.className = `brand-swatch brand-swatch-custom${custom ? " is-set" : ""}`;
    picker.style.setProperty("--swatch", draft.color);
    picker.setAttribute("aria-checked", String(custom));
    picker.title = "Elegir otro color";
    const input = document.createElement("input");
    input.type = "color";
    input.value = draft.color;
    input.setAttribute("aria-label", "Elegir otro color");
    input.addEventListener("input", () => setColor(input.value, { rerender: false }));
    input.addEventListener("change", () => renderColors());
    picker.append(input);
    colors.append(picker);
  }

  function setColor(color, { rerender = true } = {}) {
    draft.color = color.toLowerCase();
    if (rerender) renderColors();
    else {
      const picker = colors.querySelector(".brand-swatch-custom");
      picker.style.setProperty("--swatch", draft.color);
      picker.classList.add("is-set");
      picker.setAttribute("aria-checked", "true");
      for (const button of colors.querySelectorAll("button.brand-swatch")) button.setAttribute("aria-checked", "false");
    }
    renderDraft();
  }

  function placePalette() {
    return selected ? game.placePalette(selected.id) : [];
  }

  function activePlacePart() {
    const palette = placePalette();
    return palette.find((part) => part.id === placePartId) || palette[0] || null;
  }

  function colorOfPart(part) {
    if (!part) return "";
    if (part.primary) return draft.surface;
    return draft.parts[part.id] || "";
  }

  function renderPlaceColors() {
    const palette = placePalette();
    const part = activePlacePart();
    const current = colorOfPart(part);
    placeParts.replaceChildren();
    placeParts.hidden = palette.length < 2;
    for (const entry of palette) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "place-part";
      button.dataset.part = entry.id;
      button.style.setProperty("--swatch", colorOfPart(entry) || entry.original);
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(entry.id === part?.id));
      button.setAttribute("aria-label", entry.label);
      button.textContent = entry.label;
      const chip = document.createElement("i");
      button.prepend(chip);
      button.addEventListener("click", () => {
        placePartId = entry.id;
        renderPlaceColors();
      });
      placeParts.append(button);
    }

    placeColors.replaceChildren();
    const original = document.createElement("button");
    original.type = "button";
    original.className = "brand-swatch brand-swatch-original";
    original.setAttribute("role", "radio");
    original.setAttribute("aria-checked", String(!current));
    original.setAttribute("aria-label", part ? `Color original de ${part.label.toLowerCase()}` : "Color original del lugar");
    original.title = "Color original";
    original.addEventListener("click", () => setPlaceColor(""));
    placeColors.append(original);
    for (const color of PLACE_COLORS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "brand-swatch";
      button.style.setProperty("--swatch", color);
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(color === current));
      button.setAttribute("aria-label", `${part?.label || "Lugar"} ${color.toUpperCase()}`);
      button.addEventListener("click", () => setPlaceColor(color));
      placeColors.append(button);
    }
    const custom = Boolean(current) && !PLACE_COLORS.includes(current);
    const picker = document.createElement("label");
    picker.className = `brand-swatch brand-swatch-custom${custom ? " is-set" : ""}`;
    picker.style.setProperty("--swatch", current || part?.original || PLACE_COLORS[0]);
    picker.setAttribute("aria-checked", String(custom));
    picker.title = "Elegir otro color";
    const input = document.createElement("input");
    input.type = "color";
    input.value = current || part?.original || PLACE_COLORS[0];
    input.setAttribute("aria-label", "Elegir otro color para esta parte");
    input.addEventListener("input", () => setPlaceColor(input.value, { rerender: false }));
    input.addEventListener("change", () => renderPlaceColors());
    picker.append(input);
    placeColors.append(picker);
    placeColorValue.textContent =
      palette.length > 1
        ? `${part?.label || "Pared"} · ${current ? current.toUpperCase() : "Original"}`
        : current
          ? current.toUpperCase()
          : "Original";
  }

  function setPlaceColor(color, { rerender = true } = {}) {
    const part = activePlacePart();
    const next = readSurface({ surface: color });
    if (!part || part.primary) draft.surface = next;
    else if (next) draft.parts = { ...draft.parts, [part.id]: next };
    else {
      const rest = { ...draft.parts };
      delete rest[part.id];
      draft.parts = rest;
    }
    if (rerender) renderPlaceColors();
    else {
      const picker = placeColors.querySelector(".brand-swatch-custom");
      picker.style.setProperty("--swatch", next || part?.original || PLACE_COLORS[0]);
      picker.classList.toggle("is-set", Boolean(next));
      picker.setAttribute("aria-checked", String(Boolean(next) && !PLACE_COLORS.includes(next)));
      for (const button of placeColors.querySelectorAll("button.brand-swatch")) {
        button.setAttribute("aria-checked", "false");
      }
      const chip = placeParts.querySelector(`[data-part="${part?.id}"]`);
      if (chip) chip.style.setProperty("--swatch", next || part.original);
      const several = placePalette().length > 1;
      placeColorValue.textContent = several
        ? `${part?.label || "Pared"} · ${next ? next.toUpperCase() : "Original"}`
        : next
          ? next.toUpperCase()
          : "Original";
    }
    renderDraft();
  }

  function paintDesignerArtwork() {
    const { design } = draft;
    const signWidth = designCanvas.width * design.scale;
    const signHeight = signWidth * 0.5;
    const centerX = signWidth / 2 + design.x * (designCanvas.width - signWidth);
    const centerY = signHeight / 2 + design.y * (designCanvas.height - signHeight);
    designContext.save();
    designContext.translate(centerX, centerY);
    designContext.rotate((design.rotation * Math.PI) / 180);

    const label = draft.company.trim() || "Tu marca";
    const drawLabel = (y, maxWidth, fontSize) => {
      designContext.font = `900 ${fontSize}px "Avenir Next", sans-serif`;
      designContext.textAlign = "center";
      designContext.textBaseline = "middle";
      designContext.lineJoin = "round";
      designContext.lineWidth = Math.max(4, fontSize * 0.14);
      designContext.strokeStyle = "rgba(255,255,255,.92)";
      designContext.strokeText(label, 0, y, maxWidth);
      designContext.fillStyle = draft.color;
      designContext.fillText(label, 0, y, maxWidth);
    };
    if (designerImage) {
      const textBand = signHeight * 0.32;
      const imageBoxHeight = signHeight - textBand;
      const ratio = designerImage.width / designerImage.height;
      let drawWidth = signWidth * 0.92;
      let drawHeight = drawWidth / ratio;
      if (drawHeight > imageBoxHeight * 0.92) {
        drawHeight = imageBoxHeight * 0.92;
        drawWidth = drawHeight * ratio;
      }
      const imageTop = -signHeight / 2 + (imageBoxHeight - drawHeight) / 2;
      designContext.drawImage(designerImage, -drawWidth / 2, imageTop, drawWidth, drawHeight);
      const fontSize = Math.max(14, Math.min(signHeight * 0.22, signWidth / Math.max(6, label.length * 0.62)));
      drawLabel(signHeight / 2 - textBand / 2, signWidth * 0.92, fontSize);
    } else {
      const fontSize = Math.max(18, signWidth / Math.max(5.5, label.length * 0.58));
      drawLabel(0, signWidth * 0.92, fontSize);
    }
    designContext.restore();
  }

  function drawDesigner() {
    if (!draft || !selected) return;
    game.paintFacade(selected.id, designCanvas, { surface: draft.surface || "", parts: draft.parts });
    paintDesignerArtwork();
  }

  function syncDesignerImage() {
    if (designerImageSource === draft.logo) return;
    designerImageSource = draft.logo;
    designerImage = null;
    if (!draft.logo) return;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (designerImageSource !== draft?.logo) return;
      designerImage = image;
      drawDesigner();
    };
    image.src = draft.logo;
  }

  function syncDesignControls() {
    designScale.value = String(Math.round(draft.design.scale * 100));
    designRotation.value = String(Math.round(draft.design.rotation));
  }

  function renderDraft() {
    if (!selected || !draft) return;
    const company = draft.company.trim();
    paintMark(logoDrop, draft);
    logoInitials.textContent = draft.logo ? "" : initials(company);
    logoRemove.hidden = !draft.logo;
    brandNameCount.textContent = `${draft.company.length}/24`;
    colorValue.textContent = draft.color.toUpperCase();
    syncDesignerImage();
    drawDesigner();
    if (!saving) {
      const state = stateFor(recordFor(selected));
      saveButton.disabled = state === "mine" && !isDirty();
    }
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => game.previewBranding(previewRecord()), 70);
  }

  function renderListing() {
    const item = selected;
    const record = recordFor(item);
    const state = stateFor(record);
    panel.dataset.state = state;
    listingTitle.textContent = item.name;
    listingDescription.textContent = item.description || "";
    listingDescription.hidden = !item.description;
    const statusText = state === "mine" ? "Es tuyo" : state === "taken" ? `Reservado por ${record.company}` : "";
    listingStatus.textContent = statusText;
    listingStatus.parentElement.hidden = !statusText;
    panel.style.setProperty("--brand", record?.color || "#2f9e6b");
    designHint.textContent =
      item.placement === "medallion"
        ? "Arrastrá tu marca sobre el frente de la fuente."
        : "Arrastrá tu marca sobre la pared.";

    owner.hidden = state !== "taken";
    form.hidden = state === "taken";
    if (state === "taken") {
      paintMark(ownerMark, record);
      ownerMark.textContent = record.logo ? "" : initials(record.company);
      ownerName.textContent = record.company;
      const since = formatDate(record.createdAt);
      ownerSince.textContent = since ? `Desde el ${since}` : "";
      ownerLink.hidden = !record.url;
      ownerLink.href = record.url || "";
      ownerLinkText.textContent = record.url ? displayUrl(record.url) : "";
    }
    authForm.hidden = Boolean(currentSession?.user && !currentSession.user.is_anonymous);

    releaseButton.hidden = state !== "mine";
    resetRelease();
    if (state === "mine") {
      const since = formatDate(record.createdAt);
      checkoutLabel.textContent = since ? "Reservado desde" : "Tu espacio";
      checkoutPrice.textContent = since || "Gratis";
      saveButton.textContent = "Guardar cambios";
    } else if (state === "taken") {
      checkoutLabel.textContent = "Ocupado";
      checkoutPrice.textContent = "No disponible";
      saveButton.textContent = "Lugar ocupado";
    } else {
      checkoutLabel.textContent = "Precio";
      checkoutPrice.textContent = "Gratis";
      saveButton.textContent = "Crear lugar";
    }
    const claimCopy = state === "available" ? "Este lugar es gratis mientras nadie lo ocupe." : "";
    claimStatus.textContent = claimCopy;
    claimStatus.hidden = !claimCopy;
    saveButton.disabled = false;
  }

  function loadDraft() {
    const record = recordFor(selected);
    draft = draftFrom(record?.mine ? record : null);
    placePartId = "";
    designerImageSource = "";
    designerImage = null;
    brandName.value = draft.company;
    brandUrl.value = draft.url;
    brandLogo.value = "";
    brandName.setCustomValidity("");
    brandUrl.setCustomValidity("");
    logoError.hidden = true;
    showError("");
    syncDesignControls();
    renderColors();
    renderPlaceColors();
    drawDesigner();
  }

  function openEditor(item) {
    document.body.classList.remove("explore-hover");
    selected = item;
    renderListing();
    loadDraft();
    panel.hidden = false;
    panel.querySelector(".listing-scroll").scrollTop = 0;
    notice.classList.add("hidden");
    if (stateFor(recordFor(item)) === "taken") game.setBrandings(records);
    else renderDraft();
  }

  function closeEditor({ restore = true } = {}) {
    clearTimeout(previewTimer);
    panel.hidden = true;
    selected = null;
    draft = null;
    game.clearExploreSelection();
    if (restore) game.setBrandings(records);
    notice.classList.remove("hidden");
  }

  // Realtime updates must not wipe what the buyer is typing; only reset when ownership changed.
  function refreshSelected(previousState) {
    if (!selected) return;
    const record = recordFor(selected);
    const state = stateFor(record);
    if (state !== previousState) {
      openEditor(selected);
      if (state === "taken") flash("Otra marca acaba de reservar este espacio.", "warning");
      return;
    }
    const dirty = state === "mine" && isDirty();
    renderListing();
    if (state === "mine" && !dirty) loadDraft();
    if (state !== "taken") renderDraft();
  }

  function resetRelease() {
    clearTimeout(releaseTimer);
    releaseButton.classList.remove("is-confirming");
    releaseButton.textContent = "Liberar este espacio";
  }

  async function setLogo(file) {
    logoError.hidden = true;
    if (!file) return;
    try {
      draft.logo = await compactImage(file);
      renderDraft();
    } catch (error) {
      logoError.textContent = error.message || "No pudimos leer esa imagen.";
      logoError.hidden = false;
    } finally {
      brandLogo.value = "";
    }
  }

  function renderDirectory() {
    const query = searchKey(directorySearch.value.trim());
    const entries = records
      .map((record) => ({ record, item: inventory.find((item) => item.id === record.itemId) }))
      .filter(({ item }) => item)
      .filter(({ record, item }) => searchKey(`${record.company} ${item.name} ${item.zone}`).includes(query))
      .sort((a, b) => a.record.company.localeCompare(b.record.company, "es"));

    directoryCount.textContent = String(records.length);
    directoryList.replaceChildren();
    for (const { record, item } of entries) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "directory-entry";

      const mark = document.createElement("span");
      mark.className = "brand-mark";
      paintMark(mark, record);
      mark.textContent = record.logo ? "" : initials(record.company);

      const copy = document.createElement("span");
      const company = document.createElement("b");
      company.textContent = record.company;
      const location = document.createElement("small");
      location.textContent = `${item.name} · ${item.zone}`;
      copy.append(company, location);

      const action = document.createElement("em");
      action.textContent = "Visitar";
      button.append(mark, copy, action);
      button.addEventListener("click", () => visitDirectoryRecord(record));
      directoryList.append(button);
    }
    directoryEmpty.hidden = entries.length > 0;
    const [title, detail] = directoryEmpty.children;
    if (!records.length) {
      title.textContent = "Todavía no hay sponsors";
      detail.textContent = "Las marcas guardadas aparecerán acá para poder visitarlas.";
    } else if (!entries.length) {
      title.textContent = "No encontramos resultados";
      detail.textContent = "Probá buscando otra marca, edificio o zona.";
    }
  }

  function visitDirectoryRecord(record) {
    const item = game.selectExploreItem(record.itemId);
    if (!item) return;
    directory.hidden = true;
    directorySearch.blur();
    openEditor(item);
  }

  function openDirectory() {
    if (root.hidden) return;
    if (!panel.hidden) closeEditor();
    directory.hidden = false;
    renderDirectory();
    requestAnimationFrame(() => directorySearch.focus());
  }

  function closeDirectory() {
    directory.hidden = true;
    directorySearch.blur();
  }

  function openExplore() {
    menu.hidden = true;
    root.hidden = false;
    help.hidden = false;
    notice.classList.remove("hidden");
    game.beginExplore();
    document.body.classList.add("is-live");
    canvas.focus();
  }

  function closeExplore() {
    closeDirectory({ resume: false });
    closeEditor();
    document.body.classList.remove("explore-hover");
    game.clearExploreHover();
    root.hidden = true;
    menu.hidden = false;
    document.body.classList.remove("is-live");
    game.endExplore();
  }

  async function syncRecords() {
    if (!store) return;
    const previousState = selected ? stateFor(recordFor(selected)) : null;
    records = (await store.list()).filter(inInventory);
    writeCache(records);
    renderDirectory();
    if (!selected) {
      game.setBrandings(records);
      return;
    }
    const others = records.filter((record) => record.itemId !== selected.id);
    const state = stateFor(recordFor(selected));
    game.setBrandings(state === "taken" ? records : others);
    refreshSelected(previousState);
  }

  function renderSession(nextSession) {
    currentSession = nextSession;
    const email = nextSession?.user && !nextSession.user.is_anonymous ? nextSession.user.email : "";
    sessionLabel.textContent = email || "Sin sesión";
    logoutButton.hidden = !email;
    if (selected) renderListing();
  }

  authSend.addEventListener("click", async () => {
    if (!authEmail.reportValidity()) return;
    if (!store) {
      authStatus.textContent = "La autenticación no está disponible.";
      return;
    }
    authSend.disabled = true;
    authStatus.textContent = "Enviando…";
    try {
      await store.sendMagicLink(authEmail.value);
      authStatus.textContent = "Revisá tu email y abrí el enlace en este dispositivo.";
    } catch (error) {
      authStatus.textContent = error.message || "No pudimos enviar el enlace.";
    } finally {
      authSend.disabled = false;
    }
  });

  logoutButton.addEventListener("click", async () => {
    logoutButton.disabled = true;
    try {
      await store?.logout();
    } catch (error) {
      notice.textContent = error.message || "No pudimos cerrar la sesión.";
      notice.classList.remove("hidden");
    } finally {
      logoutButton.disabled = false;
    }
  });

  openButton.addEventListener("click", openExplore);
  closeButton.addEventListener("click", closeExplore);
  directoryOpen.addEventListener("click", openDirectory);
  directoryClose.addEventListener("click", () => closeDirectory());
  directorySearch.addEventListener("input", renderDirectory);
  panelClose.addEventListener("click", () => {
    closeEditor();
  });
  $("#explore-help-close").addEventListener("click", () => {
    help.hidden = true;
  });

  window.addEventListener("keydown", (event) => {
    if (root.hidden) return;
    const typing = document.activeElement?.matches("input");
    if (event.key === "/" && !typing) {
      event.preventDefault();
      openDirectory();
      return;
    }
    if (event.key === "Escape") {
      if (!directory.hidden) closeDirectory();
      else if (!panel.hidden) closeEditor();
      else closeExplore();
      return;
    }
    if (MOVE_KEYS.includes(event.code)) {
      if (typing || panel.contains(document.activeElement)) return;
      event.preventDefault();
      game.setExploreKey(event.code, true);
    }
  });
  window.addEventListener("keyup", (event) => {
    if (!root.hidden) game.setExploreKey(event.code, false);
  });
  window.addEventListener("blur", () => {
    for (const code of MOVE_KEYS) game.setExploreKey(code, false);
  });

  function refreshExploreHover() {
    hoverFrame = 0;
    if (!pointerInside || root.hidden || !panel.hidden) return;
    const item = game.hoverExploreItem(pointerX, pointerY);
    document.body.classList.toggle("explore-hover", Boolean(item));
    hoverFrame = requestAnimationFrame(refreshExploreHover);
  }

  function stopExplorePointer() {
    pointerInside = false;
    cancelAnimationFrame(hoverFrame);
    hoverFrame = 0;
    document.body.classList.remove("explore-hover");
    game.clearExploreHover();
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (root.hidden || event.button !== 0) return;
    pointerDown = true;
    pointerMoved = false;
    pointerStartedWhileEditing = !panel.hidden;
    pointerDownX = event.clientX;
    pointerDownY = event.clientY;
    pointerX = event.clientX;
    pointerY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (root.hidden) return;
    const previousX = pointerX;
    const previousY = pointerY;
    pointerInside = true;
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (pointerDown && Math.abs(pointerX - pointerDownX) + Math.abs(pointerY - pointerDownY) > 4) {
      pointerMoved = true;
    }
    if (pointerDown && pointerMoved) {
      if (panel.hidden) game.rotateExplore(pointerX - previousX, pointerY - previousY);
      else game.orbitExplore(pointerX - previousX, pointerY - previousY);
      return;
    }
    if (!panel.hidden) return;
    if (!hoverFrame) hoverFrame = requestAnimationFrame(refreshExploreHover);
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!pointerDown || root.hidden) return;
    pointerDown = false;
    const wasEditing = pointerStartedWhileEditing;
    pointerStartedWhileEditing = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (pointerMoved) return;
    if (wasEditing) {
      closeEditor();
      return;
    }
    const item = game.pickExploreItem(pointerX, pointerY);
    if (item) openEditor(item);
    else {
      notice.textContent = "Ese objeto no está disponible para personalizar";
      notice.classList.remove("hidden");
      window.setTimeout(() => {
        notice.textContent = "Elegí una fachada o un espacio destacado";
      }, 1800);
    }
  });
  canvas.addEventListener("pointerleave", () => {
    if (root.hidden || pointerDown) return;
    stopExplorePointer();
  });
  canvas.addEventListener("pointercancel", () => {
    pointerDown = false;
    pointerStartedWhileEditing = false;
    stopExplorePointer();
  });

  function moveDesign(event) {
    const rect = designCanvas.getBoundingClientRect();
    const pointerX = ((event.clientX - rect.left) / rect.width) * designCanvas.width;
    const pointerY = ((event.clientY - rect.top) / rect.height) * designCanvas.height;
    const width = designCanvas.width * draft.design.scale;
    const height = width * 0.5;
    draft.design.x = clamp((pointerX - width / 2) / (designCanvas.width - width), 0.05, 0.95, 0.5);
    draft.design.y = clamp((pointerY - height / 2) / (designCanvas.height - height), 0.05, 0.95, 0.5);
    renderDraft();
  }

  designCanvas.addEventListener("pointerdown", (event) => {
    if (!draft || event.button !== 0) return;
    designDragging = true;
    designCanvas.setPointerCapture(event.pointerId);
    moveDesign(event);
  });
  designCanvas.addEventListener("pointermove", (event) => {
    if (designDragging) moveDesign(event);
  });
  designCanvas.addEventListener("pointerup", (event) => {
    designDragging = false;
    if (designCanvas.hasPointerCapture(event.pointerId)) designCanvas.releasePointerCapture(event.pointerId);
  });
  designCanvas.addEventListener("pointercancel", () => {
    designDragging = false;
  });
  designScale.addEventListener("input", () => {
    draft.design.scale = Number(designScale.value) / 100;
    renderDraft();
  });
  designRotation.addEventListener("input", () => {
    draft.design.rotation = Number(designRotation.value);
    renderDraft();
  });
  designReset.addEventListener("click", () => {
    draft.design = { ...DEFAULT_DESIGN };
    syncDesignControls();
    renderDraft();
  });

  brandName.addEventListener("input", () => {
    draft.company = brandName.value;
    brandName.setCustomValidity("");
    renderDraft();
  });
  brandUrl.addEventListener("input", () => {
    draft.url = brandUrl.value;
    brandUrl.setCustomValidity("");
    renderDraft();
  });

  brandLogo.addEventListener("change", () => setLogo(brandLogo.files[0]));
  logoRemove.addEventListener("click", () => {
    draft.logo = "";
    logoError.hidden = true;
    renderDraft();
  });
  logoDrop.addEventListener("dragover", (event) => {
    event.preventDefault();
    logoDrop.classList.add("is-dragging");
  });
  logoDrop.addEventListener("dragleave", () => logoDrop.classList.remove("is-dragging"));
  logoDrop.addEventListener("drop", (event) => {
    event.preventDefault();
    logoDrop.classList.remove("is-dragging");
    setLogo(event.dataTransfer.files[0]);
  });

  releaseButton.addEventListener("click", async () => {
    const record = recordFor(selected);
    if (!record?.mine) return;
    if (!releaseButton.classList.contains("is-confirming")) {
      releaseButton.classList.add("is-confirming");
      releaseButton.textContent = "Confirmar: quitar mi marca de este espacio";
      releaseTimer = window.setTimeout(resetRelease, 3500);
      return;
    }
    resetRelease();
    releaseButton.disabled = true;
    showError("");
    try {
      if (!store) throw new Error("No se puede liberar sin conexión al servidor.");
      await store.remove(record);
      records = records.filter((candidate) => candidate.itemId !== record.itemId);
      writeCache(records);
      game.setBrandings(records);
      renderDirectory();
      openEditor(selected);
      flash("Liberaste el espacio. Quedó disponible para otras marcas.");
    } catch (error) {
      showError(error.message || "No pudimos liberar el espacio.");
    } finally {
      releaseButton.disabled = false;
    }
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selected || saving) return;
    if (!draft.company.trim()) {
      brandName.setCustomValidity("Escribí el nombre de tu marca.");
      brandName.reportValidity();
      return;
    }
    if (draft.url.trim() && !safeUrl(draft.url)) {
      brandUrl.setCustomValidity("Revisá el link: no parece una dirección válida.");
      brandUrl.reportValidity();
      return;
    }
    const domainConflict = domainConflictFor(draft.url);
    if (domainConflict) {
      brandUrl.setCustomValidity(
        `${domainConflict.domain} ya está asociado a ${domainConflict.record.company}. Cada dominio puede aparecer una sola vez.`,
      );
      brandUrl.reportValidity();
      return;
    }
    const previous = recordFor(selected);
    const wasMine = Boolean(previous?.mine);
    if (previous && !wasMine) {
      showError("Ese lugar ya está ocupado. Elegí uno libre.");
      return;
    }
    if (!store) {
      showError("No se puede publicar sin conexión al servidor.");
      return;
    }
    if (!currentSession?.user || currentSession.user.is_anonymous) {
      authForm.hidden = false;
      authEmail.focus();
      showError("Iniciá sesión con tu email antes de continuar.");
      return;
    }
    saving = true;
    saveButton.disabled = true;
    saveButton.textContent = wasMine ? "Guardando…" : "Creando…";
    showError("");
    try {
      const record = { ...previewRecord(), company: draft.company.trim() };
      if (!wasMine) {
        await store.acquire(record, selected, previous);
        await syncRecords();
        saving = false;
        flash("El espacio es tuyo. La marca quedó pendiente de revisión.");
        return;
      }
      const saved = await store.save(record, selected);
      records = [...records.filter((candidate) => candidate.itemId !== saved.itemId), saved];
      game.setBrandings(records);
      renderDirectory();
      saving = false;
      renderListing();
      loadDraft();
      renderDraft();
      flash("Cambios confirmados por el servidor.");
    } catch (error) {
      saving = false;
      showError(error.message || "No pudimos guardar los cambios.");
      saveButton.disabled = false;
      saveButton.textContent = wasMine ? "Guardar cambios" : "Crear lugar";
    }
  });

  setSyncLine(SYNC_COPY.offline);
  renderDirectory();
  try {
    const { connectSponsorStore, sponsorStoreEnabled } = await import("./sponsor-store.js");
    if (!sponsorStoreEnabled) {
      setSyncLine(SYNC_COPY.local);
      return;
    }
    store = await connectSponsorStore();
    renderSession(await store.getSession());
    await syncRecords();
    setSyncLine(SYNC_COPY.online);
    store.onAuthChange((nextSession) => {
      renderSession(nextSession);
      syncRecords().catch(() => {});
    });
    store.subscribe(() => {
      syncRecords().catch((error) => console.warn("No se pudieron actualizar las marcas", error));
    });
  } catch (error) {
    console.warn("Supabase no disponible; usando modo local", error);
    store = null;
    setSyncLine(SYNC_COPY.local);
  }

  const checkoutReturn = new URLSearchParams(location.search).get("checkout");
  if (checkoutReturn === "returned") {
    notice.textContent = "Volviste del pago. Estamos esperando la confirmación del servidor.";
    notice.classList.remove("hidden");
  } else if (checkoutReturn === "cancelled") {
    notice.textContent = "Pago cancelado. No se hizo ningún cambio.";
    notice.classList.remove("hidden");
  }
}
