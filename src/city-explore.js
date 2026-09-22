const BRAND_COLORS = ["#2257e6", "#f05a35", "#111827", "#16a06d", "#8b5cf6", "#eab308"];
const STORAGE_KEY = "hoyo-market-places-v2";
const ICONS = { building: "▥", vehicle: "◆", place: "●", parcel: "▦" };

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

async function compactImage(file) {
  if (file.size > 1024 * 1024) throw new Error("El archivo supera 1 MB.");
  const source = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const scale = Math.min(256 / source.width, 256 / source.height, 1);
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close();
  return canvas.toDataURL("image/webp", 0.84);
}

export async function mountCityExplore(game) {
  const canvas = document.querySelector("#view");
  const menu = document.querySelector("#menu");
  const root = document.querySelector("#city-explore");
  const openButton = document.querySelector("#open-explore");
  const closeButton = document.querySelector("#explore-close");
  const help = document.querySelector("#explore-help");
  const notice = document.querySelector("#explore-notice");
  const connection = document.querySelector("#explore-connection-text");
  const editor = document.querySelector("#explore-editor");
  const editorClose = document.querySelector("#explore-editor-close");
  const objectIcon = document.querySelector("#editor-object-icon");
  const objectName = document.querySelector("#editor-object-name");
  const objectZone = document.querySelector("#editor-object-zone");
  const objectState = document.querySelector("#editor-object-state");
  const brandLink = document.querySelector("#editor-brand-link");
  const form = document.querySelector("#explore-form");
  const brandName = document.querySelector("#brand-name");
  const brandUrl = document.querySelector("#brand-url");
  const brandLogo = document.querySelector("#brand-logo");
  const logoError = document.querySelector("#brand-logo-error");
  const formError = document.querySelector("#explore-form-error");
  const saveButton = document.querySelector("#explore-save");
  const colors = document.querySelector("#brand-colors");
  const livePreview = document.querySelector("#editor-live-preview");
  const previewLogo = document.querySelector("#editor-preview-logo");
  const previewName = document.querySelector("#editor-preview-name");
  const inventory = game.getCityItems();
  let records = readCache().filter((record) => inventory.some((item) => item.id === record.itemId));
  let store = null;
  let selected = null;
  let logoData = "";
  let logoPath = "";
  let brandColor = BRAND_COLORS[0];
  let animation = "float";
  let dragging = false;
  let dragged = false;
  let lastX = 0;
  let lastY = 0;
  let previewTimer = 0;
  let editorLocked = false;
  let hoverFrame = 0;

  game.setBrandings(records);

  const recordFor = (item) => records.find((record) => record.itemId === item?.id);

  function renderColors() {
    colors.replaceChildren();
    for (const color of BRAND_COLORS) {
      const button = document.createElement("button");
      button.type = "button";
      button.style.background = color;
      button.className = color === brandColor ? "active" : "";
      button.disabled = editorLocked;
      button.setAttribute("aria-label", `Usar color ${color}`);
      button.addEventListener("click", () => {
        if (editorLocked) return;
        brandColor = color;
        renderColors();
        updatePreview();
      });
      colors.append(button);
    }
  }

  function previewRecord() {
    return {
      itemId: selected.id,
      company: brandName.value.trim() || "Tu empresa",
      url: safeUrl(brandUrl.value),
      logo: logoData,
      logoPath,
      color: brandColor,
      animation,
      mine: true,
    };
  }

  function updatePreview() {
    if (!selected) return;
    const record = previewRecord();
    livePreview.style.setProperty("--brand", brandColor);
    previewName.textContent = record.company;
    previewLogo.textContent = logoData ? "" : record.company.slice(0, 2).toUpperCase();
    previewLogo.style.backgroundImage = logoData ? `url("${logoData}")` : "";
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => game.previewBranding(record), 70);
  }

  function setAnimation(value) {
    animation = value;
    const input = form.querySelector(`input[name="brand-animation"][value="${value}"]`);
    if (input) input.checked = true;
  }

  function openEditor(item) {
    selected = item;
    const record = recordFor(item);
    const mine = record?.mine;
    const occupied = record && !mine;
    editorLocked = Boolean(occupied);
    objectIcon.textContent = ICONS[item.category] || "●";
    objectName.textContent = item.name;
    objectZone.textContent = item.zone;
    objectState.textContent = mine ? "Tu objeto" : occupied ? `De ${record.company}` : "Disponible";
    objectState.className = occupied ? "occupied" : mine ? "mine" : "";
    brandLink.href = record?.url || "";
    brandLink.hidden = !record?.url;
    brandName.value = record?.company || "";
    brandUrl.value = record?.url || "";
    logoData = record?.logo || "";
    logoPath = record?.logoPath || "";
    brandLogo.value = "";
    brandColor = record?.color || BRAND_COLORS[0];
    setAnimation(record?.animation || "float");
    for (const input of form.elements) input.disabled = Boolean(occupied);
    saveButton.hidden = Boolean(occupied);
    formError.hidden = true;
    logoError.hidden = true;
    renderColors();
    editor.hidden = false;
    notice.classList.add("hidden");
    updatePreview();
  }

  function closeEditor({ restore = true } = {}) {
    clearTimeout(previewTimer);
    editor.hidden = true;
    selected = null;
    game.clearExploreSelection();
    if (restore) game.setBrandings(records);
    notice.classList.remove("hidden");
  }

  function openExplore() {
    menu.hidden = true;
    root.hidden = false;
    help.hidden = false;
    notice.classList.remove("hidden");
    game.beginExplore();
    canvas.focus();
  }

  function closeExplore() {
    closeEditor();
    document.body.classList.remove("explore-hover");
    game.clearExploreHover();
    root.hidden = true;
    menu.hidden = false;
    game.endExplore();
  }

  async function syncRecords() {
    if (!store) return;
    records = (await store.list()).filter((record) => inventory.some((item) => item.id === record.itemId));
    writeCache(records);
    game.setBrandings(records);
    if (selected) openEditor(selected);
  }

  openButton.addEventListener("click", openExplore);
  closeButton.addEventListener("click", closeExplore);
  editorClose.addEventListener("click", () => closeEditor());
  document.querySelector("#explore-help-close").addEventListener("click", () => {
    help.hidden = true;
  });

  window.addEventListener("keydown", (event) => {
    if (root.hidden) return;
    if (event.key === "Escape") {
      if (!editor.hidden) closeEditor();
      else closeExplore();
      return;
    }
    if (["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"].includes(event.code)) {
      if (document.activeElement?.matches("input")) return;
      event.preventDefault();
      game.setExploreKey(event.code, true);
    }
  });
  window.addEventListener("keyup", (event) => {
    if (!root.hidden) game.setExploreKey(event.code, false);
  });
  window.addEventListener("blur", () => {
    for (const code of ["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight"]) {
      game.setExploreKey(code, false);
    }
  });

  canvas.addEventListener("pointerdown", (event) => {
    if (root.hidden || event.button !== 0 || !editor.hidden) return;
    dragging = true;
    dragged = false;
    document.body.classList.remove("explore-hover");
    game.clearExploreHover();
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (root.hidden || !editor.hidden) return;
    if (!dragging) {
      cancelAnimationFrame(hoverFrame);
      hoverFrame = requestAnimationFrame(() => {
        const item = game.hoverExploreItem(event.clientX, event.clientY);
        document.body.classList.toggle("explore-hover", Boolean(item));
      });
      return;
    }
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
    game.rotateExplore(dx, dy);
    lastX = event.clientX;
    lastY = event.clientY;
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!dragging || root.hidden) return;
    dragging = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (dragged) return;
    const item = game.pickExploreItem(event.clientX, event.clientY);
    if (item) openEditor(item);
    else {
      notice.textContent = "Acercate un poco más para seleccionar ese objeto";
      notice.classList.remove("hidden");
      window.setTimeout(() => {
        notice.textContent = "Acercate y hacé clic en cualquier objeto";
      }, 1800);
    }
  });
  canvas.addEventListener("pointerleave", () => {
    if (root.hidden) return;
    document.body.classList.remove("explore-hover");
    game.clearExploreHover();
  });

  brandName.addEventListener("input", updatePreview);
  brandUrl.addEventListener("input", updatePreview);
  form.addEventListener("change", (event) => {
    if (event.target.name !== "brand-animation") return;
    animation = event.target.value;
    updatePreview();
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

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selected || !brandName.value.trim()) {
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
    saveButton.disabled = true;
    saveButton.textContent = "Guardando…";
    formError.hidden = true;
    try {
      const record = previewRecord();
      const saved = store ? await store.save(record, selected) : record;
      records = [...records.filter((candidate) => candidate.itemId !== saved.itemId), saved];
      writeCache(records);
      game.setBrandings(records);
      objectState.textContent = "Guardado";
      objectState.className = "mine";
      brandLink.href = saved.url || "";
      brandLink.hidden = !saved.url;
      saveButton.textContent = "Guardado ✓";
      window.setTimeout(() => {
        saveButton.disabled = false;
        saveButton.textContent = "Guardar cambios";
      }, 1200);
    } catch (error) {
      formError.textContent = error.message || "No pudimos guardar los cambios.";
      formError.hidden = false;
      saveButton.disabled = false;
      saveButton.textContent = "Guardar en la ciudad";
    }
  });

  renderColors();
  try {
    const { connectSponsorStore, sponsorStoreEnabled } = await import("./sponsor-store.js");
    if (!sponsorStoreEnabled) {
      connection.textContent = "Modo local";
      return;
    }
    store = await connectSponsorStore();
    await syncRecords();
    connection.textContent = "Ciudad sincronizada";
    store.subscribe(() => {
      syncRecords().catch((error) => console.warn("No se pudieron actualizar las marcas", error));
    });
  } catch (error) {
    console.warn("Supabase no disponible; usando modo local", error);
    connection.textContent = "Modo local";
  }
}
