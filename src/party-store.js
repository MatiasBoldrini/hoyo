import { createClient } from "@supabase/supabase-js";

const env = import.meta.env || {};
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const partyStoreEnabled = Boolean(url && key);

const supabase = partyStoreEnabled
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Commerce owns Magic Link callback exchange. Party must never consume
        // or replace that session while both clients share browser storage.
        detectSessionInUrl: false,
      },
    })
  : null;

export function normalizePartyCode(code) {
  return String(code || "").trim().toUpperCase();
}

export function hasPendingAuthCallback(locationLike = globalThis.location) {
  if (!locationLike) return false;
  const query = new URLSearchParams(locationLike.search || "");
  const hash = new URLSearchParams(String(locationLike.hash || "").replace(/^#/, ""));
  return (
    query.has("code") ||
    query.has("error_description") ||
    hash.has("access_token") ||
    hash.has("refresh_token") ||
    hash.has("error_description")
  );
}

export function partyRoomFromRow(row) {
  return {
    id: row.id,
    code: row.code,
    hostId: row.host_id,
    duration: row.duration_seconds,
    botCount: row.bot_count,
    objectRefill: row.object_refill,
    status: row.status,
    startedAt: row.started_at ? new Date(row.started_at).getTime() : null,
    expiresAt: new Date(row.expires_at).getTime(),
  };
}

function partyError(error) {
  if (!error) return null;
  const message = String(error.message || "");
  if (message.includes("Party is full")) return new Error("La sala está llena (máximo 8 jugadores).");
  if (message.includes("not found or expired") || error.code === "P0002") {
    return new Error("La party no existe, terminó o el link ya venció.");
  }
  if (message.includes("Only the host")) return new Error("Solo el anfitrión puede hacer eso.");
  if (message.includes("expired before")) return new Error("El link venció antes de poder iniciar la partida.");
  return error;
}

function throwIf(error) {
  if (error) throw partyError(error);
}

const REQUEST_TIMEOUT = 12000;

function withTimeout(request, message) {
  let timeout;
  return Promise.race([
    Promise.resolve(request),
    new Promise((_, reject) => {
      timeout = globalThis.setTimeout(() => reject(new Error(message)), REQUEST_TIMEOUT);
    }),
  ]).finally(() => globalThis.clearTimeout(timeout));
}

async function readSession() {
  const { data, error } = await withTimeout(
    supabase.auth.getSession(),
    "La conexión con la party tardó demasiado.",
  );
  throwIf(error);
  return data.session;
}

async function waitForMagicLinkSession(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readSession();
    if (current?.user) return current.user;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 100));
  }
  return null;
}

async function requireSession() {
  const current = await readSession();
  if (current?.user) {
    // This includes anonymous Party users and, importantly, retains any
    // verified Commerce user rather than signing in anonymously over it.
    return current.user;
  }

  if (hasPendingAuthCallback()) {
    const magicLinkUser = await waitForMagicLinkSession();
    if (magicLinkUser) return magicLinkUser;
    throw new Error("Estamos terminando tu inicio de sesión. Esperá un momento e intentá de nuevo.");
  }

  const { data, error } = await withTimeout(
    supabase.auth.signInAnonymously(),
    "No se pudo iniciar la sesión de la party a tiempo.",
  );
  throwIf(error);
  if (!data.user) throw new Error("No se pudo crear una sesión para entrar a la party.");
  return data.user;
}

export async function connectPartyStore() {
  if (!supabase) return null;
  const user = await requireSession();

  return {
    userId: user.id,

    async create(settings) {
      const { data, error } = await withTimeout(
        supabase
          .rpc("create_party_room", {
            p_duration_seconds: settings.duration,
            p_bot_count: settings.botCount,
            p_object_refill: settings.objectRefill,
          })
          .single(),
        "La creación de la party tardó demasiado.",
      );
      throwIf(error);
      return partyRoomFromRow(data);
    },

    async find(code) {
      const normalized = normalizePartyCode(code);
      if (!/^[A-Z2-9]{8}$/.test(normalized)) return null;
      const { data, error } = await withTimeout(
        supabase.rpc("join_party_room", { p_code: normalized }).single(),
        "La búsqueda de la party tardó demasiado.",
      );
      if (error?.code === "P0002") return null;
      throwIf(error);
      return partyRoomFromRow(data);
    },

    async start(roomId) {
      const { data, error } = await withTimeout(
        supabase.rpc("start_party_room", { p_room_id: roomId }).single(),
        "El inicio de la party tardó demasiado.",
      );
      throwIf(error);
      return partyRoomFromRow(data);
    },

    async finish(roomId) {
      const { error } = await withTimeout(
        supabase.rpc("finish_party_room", { p_room_id: roomId }),
        "No se pudo cerrar la party a tiempo.",
      );
      throwIf(error);
    },

    async subscribe(room, profile, callbacks) {
      const channel = supabase
        .channel(`party:${room.id}`, {
          config: {
            private: true,
            presence: { key: user.id },
            broadcast: { self: false, ack: false },
          },
        })
        .on("presence", { event: "sync" }, () => {
          const state = channel.presenceState();
          const people = Object.entries(state).map(([id, entries]) => ({
            id,
            ...(entries[entries.length - 1] || {}),
          }));
          callbacks.onPeople?.(people);
        })
        .on("broadcast", { event: "game-state" }, ({ payload }) => callbacks.onGameState?.(payload))
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "party_rooms", filter: `id=eq.${room.id}` },
          ({ new: row }) => callbacks.onRoom?.(partyRoomFromRow(row)),
        );

      try {
        await new Promise((resolve, reject) => {
          let settled = false;
          const finish = (callback) => {
            if (settled) return;
            settled = true;
            globalThis.clearTimeout(timeout);
            callback();
          };
          const timeout = globalThis.setTimeout(
            () => finish(() => reject(new Error("La party tardó demasiado en conectar."))),
            10000,
          );
          channel.subscribe(async (status) => {
            if (status === "SUBSCRIBED") {
              try {
                await channel.track(profile);
                finish(resolve);
              } catch (error) {
                finish(() => reject(error));
              }
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
              finish(() => reject(new Error("No se pudo conectar la party en tiempo real.")));
            }
          });
        });
      } catch (error) {
        await supabase.removeChannel(channel);
        throw error;
      }

      return {
        sendGameState(payload) {
          return channel.send({ type: "broadcast", event: "game-state", payload });
        },
        async leave() {
          await channel.untrack();
          await supabase.removeChannel(channel);
        },
      };
    },
  };
}
