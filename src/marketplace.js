const CATEGORY_META = {
  parcel: { label: "Manzanas", icon: "▦", singular: "Manzana" },
  building: { label: "Edificios", icon: "▥", singular: "Edificio" },
  vehicle: { label: "Vehículos", icon: "◆", singular: "Vehículo" },
  place: { label: "Espacios", icon: "●", singular: "Espacio" },
};

const BRAND_COLORS = ["#2257e6", "#f05a35", "#111827", "#16a06d", "#8b5cf6", "#eab308"];
const STORAGE_KEY = "hoyo-market-places-v1";

function money(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function readPlaces() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function cachePlaces(places) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(places));
  } catch {
    const withoutLogos = places.map((place) => ({ ...place, logo: "" }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(withoutLogos));
  }
}

function safeUrl(value) {
  const raw = value.trim();
  if (!raw) return "";
  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withProtocol);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

async function compactImage(file) {
  if (file.size > 1024 * 1024) throw new Error("El archivo supera 1 MB. Elegí una imagen más liviana.");
  const source = await createImageBitmap(file);
  const size = 256;
  const scale = Math.min(size / source.width, size / source.height, 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close();
  return canvas.toDataURL("image/webp", 0.84);
}

export async function mountMarketplace(game) {
  const root = document.querySelector("#marketplace");
  const menu = document.querySelector("#menu");
  const openButton = document.querySelector("#open-market");
  const closeButton = document.querySelector("#market-close");
  const ownedButton = document.querySelector("#market-owned");
  const ownedCount = document.querySelector("#market-owned-count");
  const tabs = document.querySelector("#market-tabs");
  const canvas = document.querySelector("#market-map");
  const ctx = canvas.getContext("2d");
  const tip = document.querySelector("#market-map-tip");
  const selectStep = document.querySelector("#market-step-select");
  const brandStep = document.querySelector("#market-step-brand");
  const reviewStep = document.querySelector("#market-step-review");
  const successStep = document.querySelector("#market-step-success");
  const brandName = document.querySelector("#brand-name");
  const brandUrl = document.querySelector("#brand-url");
  const brandLogo = document.querySelector("#brand-logo");
  const logoError = document.querySelector("#brand-logo-error");
  const preview = document.querySelector("#brand-preview");
  const previewLogo = document.querySelector("#brand-preview-logo");
  const previewName = document.querySelector("#brand-preview-name");
  const colorList = document.querySelector("#brand-colors");
  const liveStatus = document.querySelector(".market-live");
  const inventory = game.getMarketItems();
  const localPlaces = readPlaces().filter((record) => inventory.some((item) => item.id === record.itemId));
  let places = localPlaces.map((record) => ({ ...record, mine: true }));
  let store = null;
  let category = "parcel";
  let selected = inventory.find((item) => item.category === category);
  let step = 1;
  let zoom = 1;
  let brandColor = BRAND_COLORS[0];
  let logoData = "";
  let logoPath = "";

  game.setBrandings(places);

  function sponsorFor(item) {
    return places.find((place) => place.itemId === item.id);
  }

  function isMine(item) {
    return sponsorFor(item)?.mine === true;
  }

  async function syncPlaces() {
    if (!store) return;
    places = (await store.list()).filter((record) => inventory.some((item) => item.id === record.itemId));
    cachePlaces(places);
    game.setBrandings(places);
    updateOwnedCount();
    if (!root.hidden) {
      renderTabs();
      renderSelect();
      drawMap();
    }
  }

  function updateOwnedCount() {
    const count = places.filter((place) => place.mine).length;
    ownedCount.textContent = String(count);
    ownedCount.hidden = count === 0;
  }

  function setProgress(value) {
    step = value;
    for (const node of document.querySelectorAll("[data-market-progress]")) {
      const nodeStep = Number(node.dataset.marketProgress);
      node.classList.toggle("active", nodeStep === value);
      node.classList.toggle("done", nodeStep < value);
    }
    selectStep.hidden = value !== 1;
    brandStep.hidden = value !== 2;
    reviewStep.hidden = value !== 3;
    successStep.hidden = value !== 4;
  }

  function open() {
    menu.hidden = true;
    root.hidden = false;
    game.openMarketplace(selected?.id);
    renderTabs();
    renderSelect();
    drawMap();
    updateOwnedCount();
  }

  function close() {
    root.hidden = true;
    menu.hidden = false;
    setProgress(1);
    game.closeMarketplace();
  }

  function showInCity() {
    root.hidden = true;
    menu.hidden = false;
    setProgress(1);
    game.showcaseMarketItem(selected.id);
  }

  function renderTabs() {
    tabs.replaceChildren();
    for (const [key, meta] of Object.entries(CATEGORY_META)) {
      const count = inventory.filter((item) => item.category === key && !sponsorFor(item)).length;
      const button = document.createElement("button");
      button.type = "button";
      button.className = key === category ? "active" : "";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", key === category ? "true" : "false");
      button.innerHTML = `<i>${meta.icon}</i><span>${meta.label}<small>${count} disponibles</small></span>`;
      button.addEventListener("click", () => {
        category = key;
        selected = inventory.find((item) => item.category === category && !sponsorFor(item)) ||
          inventory.find((item) => item.category === category && isMine(item)) ||
          inventory.find((item) => item.category === category);
        renderTabs();
        renderSelect();
        drawMap();
        game.focusMarketItem(selected?.id);
      });
      tabs.append(button);
    }
  }

  function renderSelect() {
    if (!selected) return;
    const sponsor = sponsorFor(selected);
    const owned = sponsor?.mine ? sponsor : null;
    const occupied = sponsor && !owned;
    const meta = CATEGORY_META[selected.category];
    selectStep.innerHTML = `
      <div class="market-panel-heading">
        <p class="market-eyebrow">Paso 1 de 3 · ${escapeHtml(meta.singular)}</p>
        <h2>${escapeHtml(selected.name)}</h2>
        <p>${escapeHtml(selected.description)}</p>
      </div>
      <div class="asset-visual asset-${escapeHtml(selected.category)}">
        <span>${meta.icon}</span>
        <div><b>${escapeHtml(selected.zone)}</b><small>ID ${escapeHtml(selected.shortId)}</small></div>
        <em>${owned ? "Tu lugar" : occupied ? "Ocupado" : "Disponible"}</em>
      </div>
      <dl class="asset-facts">
        <div><dt>Ubicación</dt><dd>${escapeHtml(selected.zone)}</dd></div>
        <div><dt>Visibilidad</dt><dd>${escapeHtml(selected.reach)}</dd></div>
        <div><dt>Publicación</dt><dd>12 meses</dd></div>
      </dl>
      <div class="asset-price">
        <span><small>Precio anual</small><strong>${money(selected.price)}</strong></span>
        <em>Pago único</em>
      </div>
      <div class="market-assurance">
        <span>${occupied ? "●" : "✓"}</span>
        <p><b>${occupied ? `Patrocinado por ${escapeHtml(sponsor.company)}` : "Lo ves antes de publicar"}</b><small>${occupied ? "Elegí otro punto disponible del mapa." : "Podés previsualizar tu marca y editarla después."}</small></p>
      </div>
      <button id="market-choose" class="market-primary" type="button" ${occupied ? "disabled" : ""}>
        ${owned ? "Editar mi espacio" : occupied ? "Este lugar ya está ocupado" : "Elegir este lugar"} <span>→</span>
      </button>
      <p class="market-demo-note">${store ? "Reserva compartida mediante Supabase" : "Modo local · No se realizará ningún cobro"}</p>
    `;
    const choose = selectStep.querySelector("#market-choose");
    choose.addEventListener("click", () => {
      if (occupied) return;
      if (owned) {
        brandName.value = owned.company;
        brandUrl.value = owned.url || "";
        brandColor = owned.color || BRAND_COLORS[0];
        logoData = owned.logo || "";
        logoPath = owned.logoPath || "";
      } else {
        brandName.value = "";
        brandUrl.value = "";
        brandColor = BRAND_COLORS[0];
        logoData = "";
        logoPath = "";
      }
      renderBrandColors();
      updatePreview();
      setProgress(2);
      brandName.focus();
    });
  }

  function renderBrandColors() {
    colorList.replaceChildren();
    for (const color of BRAND_COLORS) {
      const button = document.createElement("button");
      button.type = "button";
      button.style.background = color;
      button.className = color === brandColor ? "active" : "";
      button.setAttribute("aria-label", `Usar color ${color}`);
      button.addEventListener("click", () => {
        brandColor = color;
        renderBrandColors();
        updatePreview();
      });
      colorList.append(button);
    }
  }

  function updatePreview() {
    const name = brandName.value.trim() || "Tu empresa";
    preview.style.setProperty("--brand", brandColor);
    previewName.textContent = name;
    previewLogo.textContent = logoData ? "" : name.slice(0, 2).toUpperCase();
    previewLogo.style.backgroundImage = logoData ? `url("${logoData}")` : "";
  }

  function renderReview() {
    const name = escapeHtml(brandName.value.trim());
    const url = safeUrl(brandUrl.value);
    reviewStep.innerHTML = `
      <div class="market-panel-heading">
        <button class="market-back" type="button" data-market-back="2">← Volver</button>
        <p class="market-eyebrow">Paso 3 de 3</p>
        <h2>Revisá y publicá</h2>
        <p>Confirmá que todo esté bien. La reserva se guardará para todos los visitantes.</p>
      </div>
      <div class="review-card">
        <div class="review-brand" style="--brand:${brandColor}">
          <span style="${logoData ? `background-image:url('${logoData}')` : ""}">${logoData ? "" : name.slice(0, 2).toUpperCase()}</span>
          <p><b>${name}</b><small>${url ? escapeHtml(new URL(url).hostname) : "Sin link de destino"}</small></p>
        </div>
        <div class="review-asset">
          <span>${CATEGORY_META[selected.category].icon}</span>
          <p><small>${CATEGORY_META[selected.category].singular}</small><b>${escapeHtml(selected.name)}</b></p>
          <strong>${money(selected.price)}</strong>
        </div>
      </div>
      <dl class="review-total">
        <div><dt>Publicación por 12 meses</dt><dd>${money(selected.price)}</dd></div>
        <div><dt>Activación</dt><dd>Incluida</dd></div>
        <div class="total"><dt>Total</dt><dd>${money(selected.price)}</dd></div>
      </dl>
      <label class="market-check"><input id="market-terms" type="checkbox" /><span>Acepto que el contenido puede ser moderado antes de publicarse.</span></label>
      <p id="market-terms-error" class="market-error" hidden>Necesitamos tu confirmación para continuar.</p>
      <button id="market-publish" class="market-primary" type="button">Publicar mi espacio <span>→</span></button>
      <p class="market-demo-note">Sin tarjeta y sin cargo real.</p>
    `;
    reviewStep.querySelector("[data-market-back]").addEventListener("click", () => setProgress(2));
    reviewStep.querySelector("#market-publish").addEventListener("click", publish);
  }

  async function publish() {
    const terms = reviewStep.querySelector("#market-terms");
    const termsError = reviewStep.querySelector("#market-terms-error");
    if (!terms.checked) {
      termsError.hidden = false;
      terms.focus();
      return;
    }
    const record = {
      itemId: selected.id,
      company: brandName.value.trim(),
      url: safeUrl(brandUrl.value),
      logo: logoData,
      logoPath,
      color: brandColor,
      createdAt: new Date().toISOString(),
      mine: true,
    };
    const publishButton = reviewStep.querySelector("#market-publish");
    publishButton.disabled = true;
    publishButton.textContent = "Publicando…";
    try {
      const saved = store ? await store.save(record, selected) : record;
      places = [...places.filter((place) => place.itemId !== saved.itemId), saved];
      cachePlaces(places);
      game.setBrandings(places);
      updateOwnedCount();
      renderSuccess(saved);
      setProgress(4);
    } catch (error) {
      termsError.textContent = error.message || "No pudimos publicar el espacio. Intentá nuevamente.";
      termsError.hidden = false;
      publishButton.disabled = false;
      publishButton.innerHTML = 'Publicar mi espacio <span>→</span>';
    }
  }

  function renderSuccess(record) {
    successStep.innerHTML = `
      <div class="market-success">
        <span class="market-success-check">✓</span>
        <p class="market-eyebrow">¡Listo!</p>
        <h2>Tu marca ya vive en Hoyo</h2>
        <p><b>${escapeHtml(record.company)}</b> ahora aparece en <b>${escapeHtml(selected.name)}</b>. Guardamos este espacio en “Mis lugares”.</p>
        <div class="success-ticket">
          <span>${CATEGORY_META[selected.category].icon}</span>
          <p><small>Tu espacio</small><b>${escapeHtml(selected.name)}</b><em>${escapeHtml(selected.zone)}</em></p>
          <strong>Publicado</strong>
        </div>
        <button id="market-see-city" class="market-primary" type="button">Verlo en la ciudad <span>↗</span></button>
        <button id="market-another" class="market-secondary" type="button">Elegir otro lugar</button>
        <small>En un producto real, este paso enviaría el contenido a moderación y recién después procesaría el pago.</small>
      </div>
    `;
    successStep.querySelector("#market-see-city").addEventListener("click", showInCity);
    successStep.querySelector("#market-another").addEventListener("click", () => {
      setProgress(1);
      renderTabs();
      renderSelect();
      drawMap();
    });
  }

  function showOwned() {
    const place = places.find((candidate) => candidate.mine);
    if (!place) return;
    const item = inventory.find((candidate) => candidate.id === place.itemId);
    if (!item) return;
    category = item.category;
    selected = item;
    setProgress(1);
    renderTabs();
    renderSelect();
    drawMap();
    game.focusMarketItem(selected.id);
  }

  function mapPoint(item) {
    const scale = (Math.min(canvas.width, canvas.height) * 0.43 * zoom) / 172;
    return [canvas.width / 2 + item.x * scale, canvas.height / 2 + item.z * scale];
  }

  function drawMap() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#d9f1fc";
    ctx.fillRect(0, 0, w, h);
    const centerX = w / 2;
    const centerY = h / 2;
    const scale = (Math.min(w, h) * 0.43 * zoom) / 172;
    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, 154 * scale, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#f0d8a2";
    ctx.fillRect(0, 0, w, h);
    ctx.beginPath();
    ctx.arc(centerX, centerY, 148 * scale, 0, Math.PI * 2);
    ctx.fillStyle = "#a9dc65";
    ctx.fill();
    ctx.strokeStyle = "#8d959c";
    ctx.lineWidth = 7.4 * scale;
    for (let k = -4; k <= 4; k++) {
      const at = k * 36 * scale;
      ctx.beginPath();
      ctx.moveTo(centerX + at, centerY - 150 * scale);
      ctx.lineTo(centerX + at, centerY + 150 * scale);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(centerX - 150 * scale, centerY + at);
      ctx.lineTo(centerX + 150 * scale, centerY + at);
      ctx.stroke();
    }
    ctx.restore();

    const visible = inventory.filter((item) => item.category === category);
    for (const item of visible) {
      const [x, y] = mapPoint(item);
      const active = item.id === selected?.id;
      const sponsor = sponsorFor(item);
      const owned = sponsor?.mine;
      const occupied = sponsor && !owned;
      ctx.beginPath();
      ctx.arc(x, y, active ? 12 : owned ? 8 : 6, 0, Math.PI * 2);
      ctx.fillStyle = owned ? "#6d5ce7" : occupied ? "#5f6878" : active ? "#2257e6" : "#ffffff";
      ctx.fill();
      ctx.lineWidth = active ? 5 : 3;
      ctx.strokeStyle = active ? "rgba(34,87,230,.24)" : sponsor ? "#ffffff" : "#2257e6";
      ctx.stroke();
    }
  }

  function chooseFromMap(event) {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
    let nearest = null;
    let distance = 22;
    for (const item of inventory.filter((candidate) => candidate.category === category)) {
      const [px, py] = mapPoint(item);
      const d = Math.hypot(px - x, py - y);
      if (d < distance) {
        nearest = item;
        distance = d;
      }
    }
    if (!nearest) return;
    selected = nearest;
    tip.textContent = `${nearest.name} · ${money(nearest.price)}`;
    tip.classList.add("show");
    window.setTimeout(() => tip.classList.remove("show"), 1800);
    renderSelect();
    drawMap();
    game.focusMarketItem(selected.id);
  }

  openButton.addEventListener("click", open);
  closeButton.addEventListener("click", close);
  ownedButton.addEventListener("click", showOwned);
  canvas.addEventListener("pointerdown", chooseFromMap);
  document.querySelector("#market-zoom-in").addEventListener("click", () => {
    zoom = Math.min(1.35, zoom + 0.1);
    drawMap();
  });
  document.querySelector("#market-zoom-out").addEventListener("click", () => {
    zoom = Math.max(0.8, zoom - 0.1);
    drawMap();
  });
  document.querySelector('[data-market-back="1"]').addEventListener("click", () => setProgress(1));
  brandName.addEventListener("input", updatePreview);
  brandUrl.addEventListener("blur", () => {
    if (brandUrl.value.trim()) brandUrl.value = safeUrl(brandUrl.value) || brandUrl.value;
  });
  brandLogo.addEventListener("change", async () => {
    logoError.hidden = true;
    try {
      const [file] = brandLogo.files;
      if (!file) return;
      logoData = await compactImage(file);
      updatePreview();
    } catch (error) {
      logoError.textContent = error.message || "No pudimos leer esa imagen.";
      logoError.hidden = false;
      brandLogo.value = "";
    }
  });
  brandStep.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!brandName.value.trim()) {
      brandName.setCustomValidity("Escribí el nombre de tu marca.");
      brandName.reportValidity();
      return;
    }
    brandName.setCustomValidity("");
    if (brandUrl.value.trim() && !safeUrl(brandUrl.value)) {
      brandUrl.setCustomValidity("Ingresá un link válido.");
      brandUrl.reportValidity();
      return;
    }
    brandUrl.setCustomValidity("");
    renderReview();
    setProgress(3);
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (step > 1 && step < 4) setProgress(step - 1);
    else close();
  });

  renderBrandColors();
  updateOwnedCount();

  try {
    const { connectSponsorStore, sponsorStoreEnabled } = await import("./sponsor-store.js");
    if (sponsorStoreEnabled) {
      store = await connectSponsorStore();
      await syncPlaces();
      liveStatus.lastChild.textContent = " Conectado";
      store.subscribe(() => {
        syncPlaces().catch((error) => console.warn("No se pudo actualizar sponsors", error));
      });
    } else {
      liveStatus.lastChild.textContent = " Modo local";
    }
  } catch (error) {
    console.warn("Supabase no disponible; usando persistencia local", error);
    liveStatus.lastChild.textContent = " Modo local";
  }
}
