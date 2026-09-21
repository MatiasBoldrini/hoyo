import { mountGame, PLAYER_COLORS } from "./game.js";

const canvas = document.querySelector("#view");
const menu = document.querySelector("#menu");
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
const play = document.querySelector("#play");
const again = document.querySelector("#again");
const endTitle = document.querySelector("#end-title");
const endScore = document.querySelector("#end-score");
const loading = document.querySelector("#loading");

const saved = localStorage.getItem("hoyo-name");
if (saved) nick.value = saved;
let color = Number(localStorage.getItem("hoyo-color") || PLAYER_COLORS[0]);

for (const value of PLAYER_COLORS) {
  const button = document.createElement("button");
  button.type = "button";
  button.style.background = `#${value.toString(16).padStart(6, "0")}`;
  button.classList.toggle("on", value === color);
  button.addEventListener("click", () => {
    color = value;
    localStorage.setItem("hoyo-color", String(value));
    for (const node of colors.children) node.classList.remove("on");
    button.classList.add("on");
  });
  colors.append(button);
}

const game = await mountGame(canvas, {
  onReady() {
    loading.hidden = true;
  },
  onFrame(state) {
    document.documentElement.style.setProperty("--danger", state.danger.toFixed(3));
    if (state.phase === "play") {
      timer.textContent = formatTime(state.timeLeft);
      renderRows(board, state.rows);
      drawMinimap(state.map, state.me);
      toast.hidden = !state.toast;
      toast.textContent = state.toast || "";
    }
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
});

function formatTime(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function drawMinimap(plan, me) {
  const size = minimap.width;
  const ctx = mapCtx;
  const center = size / 2;
  const reach = center - 3;
  ctx.clearRect(0, 0, size, size);
  if (!plan) return;
  const scale = reach / plan.span;
  const project = (x, z) => [center + x * scale, center + z * scale];
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
  const walk = plan.patches.find((patch) => patch.t === "ring" && patch.color === "#e6ebf0");
  ctx.save();
  if (island) {
    ctx.beginPath();
    ctx.arc(center, center, island.r * scale, 0, Math.PI * 2);
    ctx.clip();
  }
  if (walk) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(center, center, walk.inner * scale, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#8b939c";
    ctx.fillRect(0, 0, size, size);
  }
  for (const block of plan.blocks || []) paintBlock(ctx, block, project, scale);
  if (walk) ctx.restore();
  for (const patch of plan.patches) {
    if (patch.t !== "ring") continue;
    ctx.fillStyle = patch.color;
    ctx.beginPath();
    ctx.arc(center, center, patch.outer * scale, 0, Math.PI * 2);
    ctx.arc(center, center, patch.inner * scale, 0, Math.PI * 2, true);
    ctx.fill("evenodd");
  }
  ctx.restore();
  if (me) {
    const [x, y] = project(me.x, me.z);
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = me.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  }
  ctx.restore();
}

const HOME_TONES = ["#8ed44a", "#74c447", "#9ad85a", "#62b84c"];
const COAST_TONES = ["#c6dc72", "#d7e68c"];

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

function begin() {
  const name = nick.value.trim().slice(0, 12) || "Jugador";
  nick.value = name;
  localStorage.setItem("hoyo-name", name);
  menu.hidden = true;
  end.hidden = true;
  hud.hidden = false;
  nick.blur();
  hint.classList.remove("hide");
  setTimeout(() => hint.classList.add("hide"), 4200);
  game.start(name, color);
}

play.addEventListener("click", begin);
again.addEventListener("click", begin);
nick.addEventListener("keydown", (event) => {
  if (event.key === "Enter") begin();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !menu.hidden) begin();
});
window.addEventListener("pointermove", (event) => {
  if (menu.hidden && end.hidden) game.setPointer(event.clientX, event.clientY);
});

game.onEnd = (result) => {
  hud.hidden = true;
  end.hidden = false;
  endTitle.textContent = result.won ? "¡Sos el hoyo más grande!" : `Quedaste #${result.rank}`;
  const best = Math.max(result.score, Number(localStorage.getItem("hoyo-best") || 0));
  localStorage.setItem("hoyo-best", String(best));
  endScore.textContent = `Puntaje ${result.score} · récord ${best}`;
  renderRows(finalList, result.rows);
};
