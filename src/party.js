import { PLAYER_COLORS } from "./game.js";
import { connectPartyStore, normalizePartyCode, partyStoreEnabled } from "./party-store.js";

const panel = document.querySelector("#party");
const closeButton = document.querySelector("#party-close");
const leadNode = document.querySelector("#party-lead");
const nameInput = document.querySelector("#party-name");
const colorNodes = document.querySelector("#party-colors");
const setup = document.querySelector("#party-setup");
const joinForm = document.querySelector("#party-join");
const joinButton = document.querySelector("#party-join-go");
const joinError = document.querySelector("#party-join-error");
const lobby = document.querySelector("#party-lobby");
const durationInput = document.querySelector("#party-duration");
const botsInput = document.querySelector("#party-bots");
const objectsInput = document.querySelector("#party-objects");
const createButton = document.querySelector("#party-create");
const errorNode = document.querySelector("#party-error");
const codeNode = document.querySelector("#party-code");
const copyButton = document.querySelector("#party-copy");
const expiryNode = document.querySelector("#party-expiry");
const summaryNode = document.querySelector("#party-summary");
const countNode = document.querySelector("#party-count");
const peopleNode = document.querySelector("#party-people");
const statusNode = document.querySelector("#party-status");
const startButton = document.querySelector("#party-start");

const MAX_PEOPLE = 8;
const refillNames = ["Normal", "Abundante", "Caos"];
let selectedColor = PLAYER_COLORS[0];

for (const value of PLAYER_COLORS) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.color = String(value);
  button.style.background = `#${value.toString(16).padStart(6, "0")}`;
  button.setAttribute("role", "radio");
  button.setAttribute("aria-label", "Color");
  colorNodes.append(button);
}

function inviteUrl(code) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("party", code);
  return url.toString();
}

function clearPartyFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("party");
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

function messageFrom(error) {
  if (error?.code === "42P01" || error?.code === "42883") {
    return "Falta aplicar la migración de modo party en Supabase.";
  }
  return error?.message || "No se pudo conectar la party.";
}

export function mountParty({ getProfile, onProfileChange, onOpen, onClose, onStart, onGameState }) {
  let store = null;
  let room = null;
  let connection = null;
  let people = [];
  let opening = false;
  let inGame = false;
  let joinedAt = 0;
  let pendingCode = "";
  let startTimer = 0;
  let expiryTimer = 0;
  let statusPoll = 0;
  let profileTimer = 0;

  function paintColors() {
    for (const button of colorNodes.children) {
      const on = Number(button.dataset.color) === selectedColor;
      button.setAttribute("aria-checked", on ? "true" : "false");
    }
  }

  function setIdentityLocked(locked) {
    nameInput.disabled = locked;
    for (const button of colorNodes.children) button.disabled = locked;
  }

  function seedIdentity() {
    const profile = getProfile() || {};
    nameInput.value = String(profile.name || "").trim().slice(0, 12);
    const next = Number(profile.color);
    selectedColor = PLAYER_COLORS.includes(next) ? next : PLAYER_COLORS[0];
    paintColors();
    setIdentityLocked(false);
  }

  function commitDraft() {
    const name = nameInput.value.trim().slice(0, 12);
    onProfileChange?.({ name, color: selectedColor });
    return { name: name || "Jugador", color: selectedColor };
  }

  function pushProfile() {
    if (!connection || !room || room.status !== "lobby" || isExpired()) return;
    const profile = { ...commitDraft(), joinedAt };
    const me = people.find((person) => person.id === store?.userId);
    if (me) {
      me.name = profile.name;
      me.color = profile.color;
      renderRoom();
    }
    connection.updateProfile(profile)?.catch(() => {});
  }

  function scheduleProfilePush() {
    window.clearTimeout(profileTimer);
    profileTimer = window.setTimeout(() => {
      profileTimer = 0;
      pushProfile();
    }, 200);
  }

  function showScreen(screen) {
    setup.hidden = screen !== "setup";
    joinForm.hidden = screen !== "join";
    lobby.hidden = screen !== "lobby";
    if (screen === "join") {
      leadNode.hidden = false;
      leadNode.textContent = pendingCode
        ? `Te unís a ${pendingCode}. Elegí tu nombre y color antes de entrar.`
        : "Elegí tu nombre y color antes de entrar.";
    } else if (screen === "setup") {
      leadNode.hidden = false;
      leadNode.textContent = "Una sala privada. El link dura una hora.";
    } else {
      leadNode.hidden = true;
    }
  }

  function showError(error) {
    const text = messageFrom(error);
    if (!joinForm.hidden) {
      joinError.textContent = text;
      joinError.hidden = false;
      return;
    }
    if (!setup.hidden) {
      errorNode.textContent = text;
      errorNode.hidden = false;
      return;
    }
    statusNode.textContent = text;
  }

  function isHost() {
    return Boolean(room && store && room.hostId === store.userId);
  }

  function isExpired() {
    return Boolean(room && room.expiresAt <= Date.now());
  }

  function orderedPeople() {
    return [...people].sort((a, b) => {
      if (a.id === room?.hostId) return -1;
      if (b.id === room?.hostId) return 1;
      return Number(a.joinedAt || 0) - Number(b.joinedAt || 0) || a.id.localeCompare(b.id);
    });
  }

  function admitted() {
    // The database RPC/private Realtime policy is authoritative. This check is
    // only a UI defense while Presence converges.
    return orderedPeople()
      .slice(0, MAX_PEOPLE)
      .some((person) => person.id === store?.userId);
  }

  function renderExpiry() {
    if (!room) return;
    const seconds = Math.max(0, Math.ceil((room.expiresAt - Date.now()) / 1000));
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    expiryNode.textContent = seconds
      ? `El link vence en ${minutes}:${String(rest).padStart(2, "0")}`
      : "Este link ya venció.";
    if (!seconds && room.status === "lobby") {
      statusNode.textContent = "Este link ya venció.";
      startButton.disabled = true;
    }
  }

  function renderRoom() {
    if (!room) return;
    codeNode.textContent = room.code;
    summaryNode.replaceChildren();
    for (const text of [
      `${room.duration / 60} min`,
      `${room.botCount} ${room.botCount === 1 ? "bot" : "bots"}`,
      `Objetos: ${refillNames[room.objectRefill]}`,
    ]) {
      const chip = document.createElement("span");
      chip.textContent = text;
      summaryNode.append(chip);
    }
    const ordered = orderedPeople();
    const visible = ordered.slice(0, MAX_PEOPLE);
    countNode.textContent = `${Math.min(ordered.length, MAX_PEOPLE)}/${MAX_PEOPLE}`;
    peopleNode.replaceChildren();
    for (const person of visible) {
      const item = document.createElement("li");
      const swatch = document.createElement("i");
      swatch.style.background = `#${Number(person.color || 0x748ffc).toString(16).padStart(6, "0")}`;
      const name = document.createElement("span");
      name.textContent = person.name || "Jugador";
      const role = document.createElement("em");
      role.textContent =
        person.id === room.hostId ? "Anfitrión" : person.id === store?.userId ? "Vos" : "Listo";
      item.append(swatch, name, role);
      peopleNode.append(item);
    }
    if (isExpired()) {
      statusNode.textContent = "Este link ya venció.";
    } else if (ordered.length > MAX_PEOPLE && !admitted()) {
      statusNode.textContent = "La sala está llena. Podés volver y crear otra party.";
    } else if (room.status === "finished") {
      statusNode.textContent = "La partida terminó.";
    } else if (room.status === "playing") {
      statusNode.textContent = "La partida está empezando…";
    } else {
      statusNode.textContent = isHost()
        ? "Compartí el link y empezá cuando estén listos."
        : "Esperando al anfitrión…";
    }
    startButton.hidden = !isHost() || room.status !== "lobby";
    startButton.disabled = ordered.length === 0 || isExpired();
    setIdentityLocked(room.status !== "lobby" || isExpired());
    renderExpiry();
  }

  function watchLobby() {
    window.clearInterval(statusPoll);
    statusPoll = window.setInterval(() => {
      const current = room;
      if (!current || current.status !== "lobby" || !store) return;
      store
        .find(current.code)
        .then((next) => {
          if (!next || room?.id !== current.id || room.status !== "lobby") return;
          if (next.status === "lobby") return;
          room = next;
          renderRoom();
          scheduleStart();
        })
        .catch(() => {});
    }, 1000);
  }

  function scheduleStart() {
    if (room?.status === "playing") window.clearInterval(statusPoll);
    if (
      !room ||
      room.status !== "playing" ||
      !room.startedAt ||
      inGame ||
      startTimer ||
      isExpired()
    ) {
      return;
    }
    if (!admitted()) {
      renderRoom();
      return;
    }
    const remaining = room.duration * 1000 - Math.max(0, Date.now() - room.startedAt);
    if (remaining <= 0) {
      statusNode.textContent = "Esta partida ya terminó.";
      return;
    }
    const delay = Math.max(0, room.startedAt - Date.now());
    statusNode.textContent =
      delay > 200 ? "¡Preparados! La partida va a empezar…" : "Entrando a la partida…";
    startTimer = window.setTimeout(() => {
      startTimer = 0;
      inGame = true;
      panel.hidden = true;
      onStart({
        duration: room.duration,
        botCount: room.botCount,
        objectRefill: room.objectRefill,
        startedAt: room.startedAt,
        networkId: store.userId,
        networkHost: isHost(),
      });
    }, delay);
  }

  async function enter(nextRoom) {
    if (nextRoom.expiresAt <= Date.now()) throw new Error("Ese link de party ya venció.");
    if (connection) await connection.leave();
    room = nextRoom;
    people = [];
    joinedAt = Date.now();
    const profile = commitDraft();
    try {
      connection = await store.subscribe(
        room,
        { name: profile.name, color: profile.color, joinedAt },
        {
          onPeople(nextPeople) {
            people = nextPeople;
            renderRoom();
            scheduleStart();
          },
          onRoom(next) {
            room = next;
            renderRoom();
            scheduleStart();
          },
          onGameState(payload) {
            if (inGame) onGameState(payload);
          },
        },
      );
    } catch (error) {
      room = null;
      throw error;
    }
    showScreen("lobby");
    history.replaceState(null, "", new URL(inviteUrl(room.code)));
    renderRoom();
    scheduleStart();
    watchLobby();
    window.clearInterval(expiryTimer);
    expiryTimer = window.setInterval(renderExpiry, 1000);
  }

  async function ensureStore() {
    if (store) return store;
    if (!partyStoreEnabled) {
      throw new Error(
        "Configurá VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY para usar el modo party.",
      );
    }
    store = await connectPartyStore();
    return store;
  }

  async function open(code = "") {
    if (opening) return;
    opening = true;
    onOpen();
    panel.hidden = false;
    errorNode.hidden = true;
    joinError.hidden = true;
    createButton.disabled = false;
    joinButton.disabled = false;
    joinButton.textContent = "Entrar a la party";
    seedIdentity();
    if (code) {
      pendingCode = normalizePartyCode(code);
      showScreen("join");
      if (!/^[A-Z2-9]{8}$/.test(pendingCode)) {
        showError(new Error("La party no existe o el link ya venció."));
      }
      window.setTimeout(() => {
        nameInput.focus();
        nameInput.select();
      }, 0);
    } else {
      pendingCode = "";
      showScreen("setup");
    }
    opening = false;
  }

  async function leave({ showMenu = true } = {}) {
    window.clearTimeout(startTimer);
    window.clearTimeout(profileTimer);
    window.clearInterval(expiryTimer);
    window.clearInterval(statusPoll);
    startTimer = 0;
    profileTimer = 0;
    expiryTimer = 0;
    statusPoll = 0;
    pendingCode = "";
    joinedAt = 0;
    if (connection) await connection.leave();
    connection = null;
    room = null;
    people = [];
    inGame = false;
    panel.hidden = true;
    clearPartyFromUrl();
    if (showMenu) onClose();
  }

  setup.addEventListener("submit", async (event) => {
    event.preventDefault();
    createButton.disabled = true;
    errorNode.hidden = true;
    commitDraft();
    try {
      await ensureStore();
      const created = await store.create({
        duration: Number(durationInput.value),
        botCount: Number(botsInput.value),
        objectRefill: Number(objectsInput.value),
      });
      await enter(created);
    } catch (error) {
      showError(error);
    } finally {
      createButton.disabled = false;
    }
  });

  joinForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!pendingCode || joinButton.disabled) return;
    joinButton.disabled = true;
    joinButton.textContent = "Entrando…";
    joinError.hidden = true;
    commitDraft();
    try {
      await ensureStore();
      const nextRoom = await store.find(pendingCode);
      if (!nextRoom) throw new Error("La party no existe o el link ya venció.");
      await enter(nextRoom);
    } catch (error) {
      showError(error);
      joinButton.textContent = "Entrar a la party";
    } finally {
      joinButton.disabled = false;
    }
  });

  closeButton.addEventListener("click", () => leave());

  nameInput.addEventListener("input", () => {
    commitDraft();
    scheduleProfilePush();
  });

  nameInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (!joinForm.hidden) joinForm.requestSubmit();
    else if (!setup.hidden) setup.requestSubmit();
  });

  for (const button of colorNodes.children) {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      selectedColor = Number(button.dataset.color);
      paintColors();
      commitDraft();
      pushProfile();
    });
  }

  copyButton.addEventListener("click", async () => {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(inviteUrl(room.code));
      copyButton.textContent = "Copiado";
      window.setTimeout(() => {
        copyButton.textContent = "Copiar link";
      }, 1600);
    } catch {
      window.prompt("Copiá este link para invitar:", inviteUrl(room.code));
    }
  });

  startButton.addEventListener("click", async () => {
    if (!room || !isHost() || isExpired()) return;
    startButton.disabled = true;
    statusNode.textContent = "Iniciando…";
    window.clearTimeout(profileTimer);
    pushProfile();
    try {
      room = await store.start(room.id);
      connection?.sendRoom(room);
      renderRoom();
      scheduleStart();
    } catch (error) {
      showError(error);
      startButton.disabled = false;
    }
  });

  return {
    open,
    async openFromUrl() {
      const code = new URL(window.location.href).searchParams.get("party");
      if (code) await open(code);
    },
    sendGameState(state) {
      if (inGame) connection?.sendGameState(state);
    },
    async finish() {
      if (!room || !inGame) return;
      if (isHost()) {
        try {
          await store.finish(room.id);
        } catch {
          // El resultado local sigue siendo válido aunque la sala ya haya vencido.
        }
      }
    },
    get active() {
      return Boolean(room);
    },
    leave,
  };
}
