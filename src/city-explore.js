const BRAND_COLORS = ["#2257e6", "#f05a35", "#111827", "#16a06d", "#8b5cf6", "#eab308"];
const ICONS = { building: "▥", vehicle: "◆", place: "●", parcel: "▦" };

function safeUrl(value) {
  const raw = value.trim();
  if (!raw) return "";
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^https:\/\//i.test(raw)) return "";
  try {
    const url = new URL(/^https:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
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
  const sessionLabel = document.querySelector("#explore-session");
  const logoutButton = document.querySelector("#explore-logout");
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
  const formStatus = document.querySelector("#explore-form-status");
  const saveButton = document.querySelector("#explore-save");
  const price = document.querySelector("#editor-price");
  const authForm = document.querySelector("#explore-auth-form");
  const authEmail = document.querySelector("#explore-auth-email");
  const authSend = document.querySelector("#explore-auth-send");
  const authStatus = document.querySelector("#explore-auth-status");
  const colors = document.querySelector("#brand-colors");
  const livePreview = document.querySelector("#editor-live-preview");
  const previewLogo = document.querySelector("#editor-preview-logo");
  const previewName = document.querySelector("#editor-preview-name");
  const inventory = game.getCityItems();
  let records = [];
  let store = null;
  let currentSession = null;
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
    editorLocked = false;
    objectIcon.textContent = ICONS[item.category] || "●";
    objectName.textContent = item.name;
    objectZone.textContent = item.zone;
    objectState.textContent = mine ? "Tu objeto" : occupied ? `De ${record.company}` : "Disponible";
    objectState.className = occupied ? "occupied" : mine ? "mine" : "";
    brandLink.href = record?.url || "";
    brandLink.hidden = !record?.url;
    brandName.value = mine ? record?.company || "" : "";
    brandUrl.value = mine ? record?.url || "" : "";
    logoData = mine ? record?.logo || "" : "";
    logoPath = mine ? record?.logoPath || "" : "";
    brandLogo.value = "";
    brandColor = mine ? record?.color || BRAND_COLORS[0] : BRAND_COLORS[0];
    setAnimation(mine ? record?.animation || "float" : "float");
    for (const input of form.elements) input.disabled = false;
    saveButton.hidden = Boolean(occupied && record.canTakeover === false);
    saveButton.textContent = mine ? "Guardar cambios" : occupied ? "Reemplazar" : "Reclamar gratis";
    const protection = record?.protectedUntil
      ? ` · protegido hasta ${new Date(record.protectedUntil).toLocaleDateString("es-AR")}`
      : "";
    price.textContent = occupied
      ? `Próximo precio: USD ${record.nextPrice || item.price}${protection}`
      : "";
    price.hidden = !occupied;
    authForm.hidden = Boolean(currentSession?.user && !currentSession.user.is_anonymous);
    formError.hidden = true;
    formStatus.textContent = "";
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
    game.setBrandings(records);
    if (selected) openEditor(selected);
  }

  function renderSession(nextSession) {
    currentSession = nextSession;
    const email = nextSession?.user && !nextSession.user.is_anonymous ? nextSession.user.email : "";
    sessionLabel.textContent = email || "Sin sesión";
    logoutButton.hidden = !email;
    if (selected) openEditor(selected);
  }

  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
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
      connection.textContent = error.message || "No pudimos cerrar la sesión.";
    } finally {
      logoutButton.disabled = false;
    }
  });

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
    if (!store) {
      formError.textContent = "No se puede publicar sin conexión al servidor.";
      formError.hidden = false;
      return;
    }
    if (!currentSession?.user || currentSession.user.is_anonymous) {
      authForm.hidden = false;
      authEmail.focus();
      formError.textContent = "Iniciá sesión con tu email antes de continuar.";
      formError.hidden = false;
      return;
    }
    const existing = recordFor(selected);
    const action = !existing ? "claim" : existing.mine ? "update" : "takeover";
    saveButton.disabled = true;
    saveButton.setAttribute("aria-busy", "true");
    saveButton.textContent = action === "takeover" ? "Preparando pago…" : "Guardando…";
    formError.hidden = true;
    formStatus.textContent = "";
    try {
      const record = previewRecord();
      if (action !== "update") {
        const checkoutUrl = await store.acquire(record, selected, existing);
        if (!checkoutUrl) {
          await syncRecords();
          formStatus.textContent = "El lugar es tuyo. La marca quedó pendiente de revisión.";
          saveButton.disabled = false;
          saveButton.textContent = "Guardar cambios";
          return;
        }
        formStatus.textContent = "Redirigiendo al pago seguro…";
        window.location.assign(checkoutUrl);
        return;
      }
      const saved = await store.save(record, selected);
      records = [...records.filter((candidate) => candidate.itemId !== saved.itemId), saved];
      game.setBrandings(records);
      objectState.textContent = "Guardado";
      objectState.className = "mine";
      brandLink.href = saved.url || "";
      brandLink.hidden = !saved.url;
      formStatus.textContent = "Cambios confirmados por el servidor.";
      saveButton.textContent = "Guardado ✓";
      window.setTimeout(() => {
        saveButton.disabled = false;
        saveButton.textContent = "Guardar cambios";
      }, 1200);
    } catch (error) {
      formError.textContent = error.message || "No pudimos guardar los cambios.";
      formError.hidden = false;
      saveButton.disabled = false;
      saveButton.textContent =
        action === "takeover" ? "Reemplazar" : action === "claim" ? "Reclamar gratis" : "Guardar cambios";
    } finally {
      saveButton.removeAttribute("aria-busy");
    }
  });

  renderColors();
  try {
    const { connectSponsorStore, sponsorStoreEnabled } = await import("./sponsor-store.js");
    if (!sponsorStoreEnabled) {
      connection.textContent = "Sólo lectura · sin servidor";
      return;
    }
    store = await connectSponsorStore();
    renderSession(await store.getSession());
    await syncRecords();
    connection.textContent = "Ciudad sincronizada";
    store.onAuthChange((nextSession) => {
      renderSession(nextSession);
      syncRecords().catch(() => {});
    });
    store.subscribe(() => {
      syncRecords().catch((error) => console.warn("No se pudieron actualizar las marcas", error));
    });
  } catch (error) {
    console.warn("Supabase no disponible", error);
    connection.textContent = "Sólo lectura · sin conexión";
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
