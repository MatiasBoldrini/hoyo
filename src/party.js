import { connectPartyStore, partyStoreEnabled } from "./party-store.js";

const panel = document.querySelector("#party");
const closeButton = document.querySelector("#party-close");
const setup = document.querySelector("#party-setup");
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

export function mountParty({ getProfile, onOpen, onClose, onStart, onGameState }) {
  let store = null;
  let room = null;
  let connection = null;
  let people = [];
  let opening = false;
  let inGame = false;
  let startTimer = 0;
  let expiryTimer = 0;

  function showError(error) {
    errorNode.textContent = messageFrom(error);
    errorNode.hidden = false;
    statusNode.textContent = messageFrom(error);
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
        person.id === room.hostId ? "ANFITRIÓN" : person.id === store?.userId ? "VOS" : "LISTO";
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
    renderExpiry();
  }

  function scheduleStart() {
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
    const profile = getProfile();
    try {
      connection = await store.subscribe(
        room,
        { name: profile.name, color: profile.color, joinedAt: Date.now() },
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
    setup.hidden = true;
    lobby.hidden = false;
    history.replaceState(null, "", new URL(inviteUrl(room.code)));
    renderRoom();
    scheduleStart();
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
    lobby.hidden = true;
    setup.hidden = false;
    errorNode.hidden = true;
    createButton.disabled = true;
    try {
      await ensureStore();
      if (code) {
        statusNode.textContent = "Entrando a la party…";
        const nextRoom = await store.find(code);
        if (!nextRoom) throw new Error("La party no existe o el link ya venció.");
        await enter(nextRoom);
      }
    } catch (error) {
      showError(error);
    } finally {
      createButton.disabled = false;
      opening = false;
    }
  }

  async function leave({ showMenu = true } = {}) {
    window.clearTimeout(startTimer);
    window.clearInterval(expiryTimer);
    startTimer = 0;
    expiryTimer = 0;
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

  closeButton.addEventListener("click", () => leave());

  copyButton.addEventListener("click", async () => {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(inviteUrl(room.code));
      copyButton.textContent = "¡COPIADO!";
      window.setTimeout(() => {
        copyButton.textContent = "COPIAR LINK";
      }, 1600);
    } catch {
      window.prompt("Copiá este link para invitar:", inviteUrl(room.code));
    }
  });

  startButton.addEventListener("click", async () => {
    if (!room || !isHost() || isExpired()) return;
    startButton.disabled = true;
    statusNode.textContent = "Iniciando…";
    try {
      room = await store.start(room.id);
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
