import { mountGame, PLAYER_COLORS } from "./game.js";
import { mountCityExplore } from "./city-explore.js";
import { mountParty } from "./party.js";

const canvas = document.querySelector("#view");
const menu = document.querySelector("#menu");
const cityExplore = document.querySelector("#city-explore");
const end = document.querySelector("#end");
const hud = document.querySelector("#hud");
const timer = document.querySelector("#timer");
const board = document.querySelector("#board");
const minimap = document.querySelector("#minimap");
const mapCtx = minimap.getContext("2d");
const finalList = document.querySelector("#final");
const hint = document.querySelector("#hint");
const toast = document.querySelector("#toast");
const nick = document.querySelector("#nick");
const colors = document.querySelector("#colors");
const swatch = document.querySelector("#color-swatch");
const play = document.querySelector("#play");
const openParty = document.querySelector("#open-party");
const again = document.querySelector("#again");
const endTitle = document.querySelector("#end-title");
const endScore = document.querySelector("#end-score");
const loading = document.querySelector("#loading");
const menuMessage = document.querySelector("#menu-message");

const saved = localStorage.getItem("hoyo-name");
if (saved && saved !== "Jugador") nick.value = saved;
let color = Number(localStorage.getItem("hoyo-color") || PLAYER_COLORS[0]);

function colorHex(value) {
  return `#${value.toString(16).padStart(6, "0")}`;
}

function paintSwatch() {
  swatch.style.background = colorHex(color);
}

function placeColors() {
  const anchor = swatch.getBoundingClientRect();
  const pop = colors.getBoundingClientRect();
  const gap = 10;
  let left = anchor.left;
  let top = anchor.top - gap - pop.height;
  left = Math.max(12, Math.min(left, window.innerWidth - pop.width - 12));
  top = Math.max(12, top);
  colors.style.left = `${left}px`;
  colors.style.top = `${top}px`;
}

function setColorsOpen(open) {
  colors.hidden = !open;
  swatch.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) placeColors();
}

swatch.addEventListener("click", (event) => {
  event.stopPropagation();
  setColorsOpen(colors.hidden);
});

for (const value of PLAYER_COLORS) {
  const button = document.createElement("button");
  button.type = "button";
  button.style.background = colorHex(value);
  button.setAttribute("aria-label", "Color");
  button.classList.toggle("on", value === color);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    color = value;
    localStorage.setItem("hoyo-color", String(value));
    for (const node of colors.children) node.classList.remove("on");
    button.classList.add("on");
    paintSwatch();
    setColorsOpen(false);
  });
  colors.append(button);
}

paintSwatch();

document.addEventListener("pointerdown", (event) => {
  if (colors.hidden) return;
  if (event.target === swatch || colors.contains(event.target)) return;
  setColorsOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setColorsOpen(false);
});

window.addEventListener("resize", () => {
  if (!colors.hidden) placeColors();
});

const game = await mountGame(canvas, {
  onReady() {
    loading.hidden = true;
  },
  onFrame(state) {
    paintHud(state);
  },
  onPopup(text, x, y) {
    const pop = document.createElement("div");
    pop.className = "pop";
    pop.textContent = text;
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
    document.body.append(pop);
    setTimeout(() => pop.remove(), 700);
  },
  onNetworkFrame(state) {
    partyController?.sendGameState(state);
  },
});
mountCityExplore(game);
const partyController = mountParty({
  getProfile() {
    return {
      name: nick.value.trim().slice(0, 12) || "Jugador",
      color,
    };
  },
  onOpen() {
    menu.hidden = true;
    end.hidden = true;
    setColorsOpen(false);
  },
  onClose() {
    showMainMenu("Cerraste la party. Podés crear otra o jugar una partida rápida.");
  },
  onStart(options) {
    begin(options);
  },
  onGameState(state) {
    game.syncNetworkState(state);
  },
});
partyController.openFromUrl();

const hudState = { danger: "", time: "", rows: "", toast: null, map: null, dot: "" };
const MAP_LAYER_SIZE = 768;
const MAP_VIEW_RADIUS = 56;
const mapLayer = document.createElement("canvas");
mapLayer.width = MAP_LAYER_SIZE;
mapLayer.height = MAP_LAYER_SIZE;
const mapLayerCtx = mapLayer.getContext("2d");

function paintHud(state) {
  const danger = state.danger.toFixed(2);
  if (danger !== hudState.danger) {
    hudState.danger = danger;
    document.documentElement.style.setProperty("--danger", danger);
  }
  if (state.phase !== "play") return;
  const time = formatTime(state.timeLeft);
  if (time !== hudState.time) {
    hudState.time = time;
    timer.textContent = time;
  }
  const rows = boardKey(state.rows);
  if (rows !== hudState.rows) {
    hudState.rows = rows;
    renderRows(board, state.rows);
  }
  const toastText = state.toast || "";
  if (toastText !== hudState.toast) {
    hudState.toast = toastText;
    toast.hidden = toastText === "";
    toast.textContent = toastText;
  }
  drawMinimap(state.map, state.me, state.rivals);
}

function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function boardKey(rows) {
  let key = "";
  for (const row of rows) {
    key += `${row.rank}\0${row.name}\0${row.score}\0${row.color}\0${row.me ? 1 : 0}\n`;
  }
  return key;
}

function drawMinimap(plan, me, rivals = []) {
  if (!plan) return;
  if (hudState.map !== plan) {
    hudState.map = plan;
    hudState.dot = "";
    drawMapLayer(mapLayerCtx, plan);
  }
  const size = minimap.width;
  const center = size / 2;
  const reach = center - 3;
  const layerScale = (mapLayer.width / 2 - 2) / plan.span;
  const focusX = me ? me.x : 0;
  const focusZ = me ? me.z : 0;
  const srcR = MAP_VIEW_RADIUS * layerScale;
  const sx = mapLayer.width / 2 + focusX * layerScale;
  const sy = mapLayer.height / 2 + focusZ * layerScale;
  const rivalKey = rivals.map((rival) => `${Math.round(rival.x)}:${Math.round(rival.z)}`).join(",");
  const dot = `${Math.round(sx)}:${Math.round(sy)}:${me ? me.color : ""}:${rivalKey}`;
  if (dot === hudState.dot) return;
  hudState.dot = dot;
  mapCtx.clearRect(0, 0, size, size);
  mapCtx.fillStyle = "#1eb6e6";
  mapCtx.fillRect(0, 0, size, size);
  mapCtx.save();
  mapCtx.beginPath();
  mapCtx.arc(center, center, reach, 0, Math.PI * 2);
  mapCtx.clip();
  mapCtx.imageSmoothingEnabled = true;
  mapCtx.drawImage(mapLayer, sx - srcR, sy - srcR, srcR * 2, srcR * 2, 0, 0, size, size);
  for (const rival of rivals) {
    const px = center + ((rival.x - focusX) / MAP_VIEW_RADIUS) * (size / 2);
    const py = center + ((rival.z - focusZ) / MAP_VIEW_RADIUS) * (size / 2);
    if (Math.hypot(px - center, py - center) > reach - 4) continue;
    mapCtx.beginPath();
    mapCtx.arc(px, py, 4, 0, Math.PI * 2);
    mapCtx.fillStyle = rival.color;
    mapCtx.fill();
  }
  if (me) {
    mapCtx.beginPath();
    mapCtx.arc(center, center, 6, 0, Math.PI * 2);
    mapCtx.fillStyle = me.color;
    mapCtx.fill();
    mapCtx.lineWidth = 2;
    mapCtx.strokeStyle = "#ffffff";
    mapCtx.stroke();
  }
  mapCtx.restore();
}

function drawMapLayer(ctx, plan) {
  const size = mapLayer.width;
  const center = size / 2;
  const reach = center - 3;
  const scale = reach / plan.span;
  const project = (x, z) => [center + x * scale, center + z * scale];
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  ctx.arc(center, center, reach, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = "#8ec8f8";
  ctx.fillRect(0, 0, size, size);
  for (const patch of plan.patches) {
    if (patch.t !== "disc") continue;
    ctx.fillStyle = patch.color;
    ctx.beginPath();
    ctx.arc(center, center, patch.r * scale, 0, Math.PI * 2);
    ctx.fill();
  }
  const island = plan.patches.find((patch) => patch.clip);
  ctx.save();
  if (island) {
    ctx.beginPath();
    ctx.arc(center, center, island.r * scale, 0, Math.PI * 2);
    ctx.clip();
  }
  for (const patch of plan.patches) {
    if (patch.t !== "rect") continue;
    paintRect(ctx, patch, project, scale);
  }
  for (const block of plan.blocks || []) paintBlock(ctx, block, project, scale);
  ctx.restore();
  for (const patch of plan.patches) {
    if (patch.t !== "ring") continue;
    ctx.fillStyle = patch.color;
    ctx.beginPath();
    ctx.arc(center, center, patch.outer * scale, 0, Math.PI * 2);
    ctx.arc(center, center, patch.inner * scale, 0, Math.PI * 2, true);
    ctx.fill("evenodd");
  }
  ctx.restore();
  ctx.restore();
}

const HOME_TONES = ["#8ed44a", "#74c447", "#9ad85a", "#62b84c"];
const COAST_TONES = ["#c6dc72", "#d7e68c"];

function paintRect(ctx, patch, project, scale) {
  const [x, y] = project(patch.x, patch.z);
  const w = patch.w * scale;
  const h = patch.h * scale;
  ctx.fillStyle = patch.color;
  ctx.fillRect(x - w / 2, y - h / 2, w, h);
}

function paintBlock(ctx, block, project, scale) {
  const [x, y] = project(block.x, block.z);
  const dist = Math.hypot(block.x, block.z);
  const n = Math.abs(Math.round(block.x) * 3 + Math.round(block.z) * 5);
  if (block.kind === "park") {
    ctx.fillStyle = n % 2 ? "#c8f56e" : "#7ed456";
    ctx.beginPath();
    ctx.arc(x, y, (13.6 + (n % 3) * 0.7) * scale, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (block.kind === "plaza") {
    ctx.fillStyle = "#e7f3b4";
    ctx.beginPath();
    ctx.arc(x, y, 14.6 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7ec8ea";
    ctx.beginPath();
    ctx.arc(x, y, 4.1 * scale, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (block.kind === "down") {
    const span = (14.8 + (n % 3) * 2.1) * scale;
    ctx.fillStyle = n % 2 ? "#5c7c88" : "#6e8f7c";
    fillRoundRect(ctx, x - span / 2, y - span / 2, span, span, 2.8 * scale);
    return;
  }
  ctx.fillStyle = dist > 108 ? COAST_TONES[n % COAST_TONES.length] : HOME_TONES[n % HOME_TONES.length];
  ctx.beginPath();
  ctx.arc(x, y, (12.4 + (n % 4) * 0.7) * scale, 0, Math.PI * 2);
  ctx.fill();
}

function parcelTone(block, dist) {
  const n = Math.abs(Math.round(block.x / 36) * 3 + Math.round(block.z / 36) * 5);
  if (dist > 108) return COAST_TONES[n % COAST_TONES.length];
  return HOME_TONES[n % HOME_TONES.length];
}

function fillRoundRect(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

function renderRows(list, rows) {
  list.replaceChildren();
  for (const row of rows) {
    const li = document.createElement("li");
    li.className = row.me ? "row me" : "row";
    const rank = document.createElement("span");
    rank.textContent = String(row.rank);
    const swatch = document.createElement("i");
    swatch.className = "swatch";
    swatch.style.background = row.color;
    const name = document.createElement("b");
    name.textContent = row.name;
    const score = document.createElement("span");
    score.textContent = String(row.score);
    li.append(rank, swatch, name, score);
    list.append(li);
  }
}

function begin(options = {}) {
  const name = nick.value.trim().slice(0, 12) || "Jugador";
  nick.value = name;
  localStorage.setItem("hoyo-name", name);
  menu.hidden = true;
  end.hidden = true;
  hud.hidden = false;
  menuMessage.hidden = true;
  toast.hidden = true;
  again.textContent = "OTRA VEZ";
  nick.blur();
  hint.classList.remove("hide");
  setTimeout(() => hint.classList.add("hide"), 4200);
  game.start(name, color, options);
}

play.addEventListener("click", () => begin());
openParty.addEventListener("click", () => partyController.open());
again.addEventListener("click", () => {
  if (!partyController.active) {
    begin();
    return;
  }
  partyController.leave({ showMenu: false });
  showMainMenu("La party terminó. Creá otra sala para volver a jugar con el grupo.");
});
canvas.addEventListener("click", (event) => {
  if (cityExplore.hidden && (!menu.hidden || !end.hidden)) {
    game.visitBrandAt(event.clientX, event.clientY);
  }
});
nick.addEventListener("keydown", (event) => {
  if (event.key === "Enter") begin();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !menu.hidden) begin();
  if (event.key !== "Escape" || !cityExplore.hidden || !menu.hidden || !end.hidden || hud.hidden) return;
  event.preventDefault();
  game.returnToMenu();
  if (partyController.active) partyController.leave({ showMenu: false });
  showMainMenu("Saliste de la partida. Cambiá tu nombre o color y volvé a entrar.");
});
// Con el mouse, mantener el click y arrastrar gira la cámara. Mientras tanto el
// objetivo queda fijo en pantalla, así el hoyo sigue en la misma dirección relativa.
// En el celular el joystick mueve al personaje y arrastrar el resto de la pantalla gira la cámara.
const coarsePointer = window.matchMedia("(pointer: coarse), (hover: none)");
const desktopHint = hint.textContent;
let turnFrom = null;

function matchActive() {
  return cityExplore.hidden && menu.hidden && end.hidden && !hud.hidden;
}

window.addEventListener("pointerdown", (event) => {
  if (!matchActive()) return;
  if (event.target.closest("#joystick, button, a, input, select, textarea")) return;
  const mouseTurn = event.pointerType === "mouse" && event.button === 0;
  const touchTurn = coarsePointer.matches && event.pointerType !== "mouse";
  if (!mouseTurn && !touchTurn) return;
  turnFrom = event.clientX;
  document.body.classList.add("turning");
});

window.addEventListener("pointermove", (event) => {
  if (!matchActive()) return;
  if (turnFrom !== null) {
    game.rotateCamera(-(event.clientX - turnFrom) * 0.006);
    turnFrom = event.clientX;
    return;
  }
  if (coarsePointer.matches) return;
  game.setPointer(event.clientX, event.clientY);
});

function stopTurning() {
  turnFrom = null;
  document.body.classList.remove("turning");
}
window.addEventListener("pointerup", stopTurning);
window.addEventListener("pointercancel", stopTurning);
window.addEventListener("blur", stopTurning);

game.onEnd = (result) => {
  hud.hidden = true;
  end.hidden = false;
  endTitle.textContent = result.won ? "¡Sos el hoyo más grande!" : `Quedaste #${result.rank}`;
  const best = Math.max(result.score, Number(localStorage.getItem("hoyo-best") || 0));
  localStorage.setItem("hoyo-best", String(best));
  endScore.textContent = `Puntaje ${result.score} · récord ${best}`;
  renderRows(finalList, result.rows);
  again.textContent = partyController.active ? "VOLVER AL MENÚ" : "OTRA VEZ";
  partyController.finish();
};

game.onPlayerDeath = () => {
  if (partyController.active) partyController.leave({ showMenu: false });
  showMainMenu("Te tragaron. Elegí tu nombre y volvé a la ciudad.");
};

const joystick = document.querySelector("#joystick");
const joystickBase = joystick.querySelector(".joystick-base");
const joystickKnob = joystick.querySelector(".joystick-knob");
const exploreEditor = document.querySelector("#explore-editor");
const exploreDirectory = document.querySelector("#explore-directory");
let stickPointer = null;

function releaseStick() {
  stickPointer = null;
  joystickKnob.style.transform = "translate(-50%, -50%)";
  game.setStick(0, 0);
}

function syncJoystick() {
  const exploring = !cityExplore.hidden && exploreEditor.hidden && exploreDirectory.hidden;
  const show = coarsePointer.matches && (matchActive() || exploring);
  if (!show) releaseStick();
  joystick.hidden = !show;
  joystick.setAttribute("aria-hidden", show ? "false" : "true");
  hint.textContent = coarsePointer.matches
    ? "Joystick para moverte · arrastrá para girar la cámara"
    : desktopHint;
}

function moveStick(event) {
  const rect = joystickBase.getBoundingClientRect();
  const dx = event.clientX - (rect.left + rect.width / 2);
  const dy = event.clientY - (rect.top + rect.height / 2);
  const max = rect.width * 0.34;
  const dist = Math.hypot(dx, dy);
  const clamped = Math.min(dist, max);
  const nx = dist > 0 ? dx / dist : 0;
  const ny = dist > 0 ? dy / dist : 0;
  joystickKnob.style.transform = `translate(calc(-50% + ${nx * clamped}px), calc(-50% + ${ny * clamped}px))`;
  const magnitude = max > 0 ? dist / max : 0;
  if (magnitude < 0.18) {
    game.setStick(0, 0);
    return;
  }
  const gain = Math.min(1, (magnitude - 0.18) / 0.82);
  game.setStick(nx * gain, -ny * gain);
}

joystick.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  stickPointer = event.pointerId;
  try {
    joystick.setPointerCapture(event.pointerId);
  } catch {
    // El gesto sigue valiendo si el navegador no permite capturar el puntero.
  }
  moveStick(event);
});
joystick.addEventListener("pointermove", (event) => {
  if (event.pointerId !== stickPointer) return;
  event.preventDefault();
  moveStick(event);
});
function endStick(event) {
  if (event.pointerId !== stickPointer) return;
  releaseStick();
}
joystick.addEventListener("pointerup", endStick);
joystick.addEventListener("pointercancel", endStick);
joystick.addEventListener("lostpointercapture", endStick);

const joystickWatch = new MutationObserver(syncJoystick);
for (const node of [hud, menu, end, cityExplore, exploreEditor, exploreDirectory]) {
  joystickWatch.observe(node, { attributes: true, attributeFilter: ["hidden"] });
}
coarsePointer.addEventListener("change", syncJoystick);
syncJoystick();

function showMainMenu(message) {
  hud.hidden = true;
  end.hidden = true;
  menu.hidden = false;
  toast.hidden = true;
  stopTurning();
  menuMessage.textContent = message;
  menuMessage.hidden = false;
  window.setTimeout(() => {
    nick.focus();
    nick.select();
  }, 0);
}
