import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const partyStoreEnabled = Boolean(url && key);

const supabase = partyStoreEnabled
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (value) => CODE_ALPHABET[value % CODE_ALPHABET.length]).join("");
}

function fromRow(row) {
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

async function requireSession() {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  let user = sessionData.session?.user;
  if (!user) {
    const { data, error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
    user = data.user;
  }
  if (!user) throw new Error("No se pudo crear una sesión para entrar a la party.");
  return user;
}

export async function connectPartyStore() {
  if (!supabase) return null;
  const user = await requireSession();

  return {
    userId: user.id,

    async create(settings) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const payload = {
          code: makeCode(),
          host_id: user.id,
          duration_seconds: settings.duration,
          bot_count: settings.botCount,
          object_refill: settings.objectRefill,
        };
        const { data, error } = await supabase.from("party_rooms").insert(payload).select("*").single();
        if (!error) return fromRow(data);
        if (error.code !== "23505") throw error;
      }
      throw new Error("No pudimos generar un código único. Probá de nuevo.");
    },

    async find(code) {
      const normalized = code.trim().toUpperCase();
      const { data, error } = await supabase
        .from("party_rooms")
        .select("*")
        .eq("code", normalized)
        .maybeSingle();
      if (error) throw error;
      return data ? fromRow(data) : null;
    },

    async start(roomId) {
      const startedAt = new Date(Date.now() + 1400).toISOString();
      const { data, error } = await supabase
        .from("party_rooms")
        .update({ status: "playing", started_at: startedAt })
        .eq("id", roomId)
        .eq("host_id", user.id)
        .eq("status", "lobby")
        .select("*")
        .single();
      if (error) throw error;
      return fromRow(data);
    },

    async finish(roomId) {
      const { error } = await supabase
        .from("party_rooms")
        .update({ status: "finished" })
        .eq("id", roomId)
        .eq("host_id", user.id);
      if (error) throw error;
    },

    async subscribe(room, profile, callbacks) {
      const channel = supabase
        .channel(`party:${room.id}`, {
          config: {
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
          ({ new: row }) => callbacks.onRoom?.(fromRow(row)),
        );

      await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("La party tardó demasiado en conectar.")), 10000);
        channel.subscribe(async (status) => {
          if (status === "SUBSCRIBED") {
            window.clearTimeout(timeout);
            try {
              await channel.track(profile);
              resolve();
            } catch (error) {
              reject(error);
            }
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            window.clearTimeout(timeout);
            reject(new Error("No se pudo conectar la party en tiempo real."));
          }
        });
      });

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
