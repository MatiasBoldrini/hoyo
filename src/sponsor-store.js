import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const sponsorStoreEnabled = Boolean(url && key);

const supabase = sponsorStoreEnabled
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;

let userId = "";

function fromRow(row) {
  return {
    id: row.id,
    itemId: row.asset_id,
    company: row.company,
    url: row.target_url || "",
    logo: row.logo_url || "",
    logoPath: row.logo_path || "",
    color: row.color,
    ownerId: row.owner_id,
    mine: row.owner_id === userId,
    createdAt: row.created_at,
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
  if (!user) throw new Error("Supabase no pudo crear la sesión anónima.");
  userId = user.id;
  return user;
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

export async function connectSponsorStore() {
  if (!supabase) return null;
  await requireSession();
  return {
    userId,
    async list() {
      const { data, error } = await supabase
        .from("sponsorships")
        .select("id,asset_id,company,target_url,logo_path,logo_url,color,owner_id,created_at")
        .in("status", ["active", "pending"])
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data.map(fromRow);
    },
    async save(record, item) {
      let logoPath = record.logoPath || "";
      let logoUrl = record.logo && !record.logo.startsWith("data:") ? record.logo : "";
      if (record.logo?.startsWith("data:")) {
        const blob = await dataUrlToBlob(record.logo);
        logoPath = `${userId}/${item.id}.webp`;
        const { error: uploadError } = await supabase.storage
          .from("sponsor-logos")
          .upload(logoPath, blob, { contentType: "image/webp", upsert: true });
        if (uploadError) throw uploadError;
        logoUrl = supabase.storage.from("sponsor-logos").getPublicUrl(logoPath).data.publicUrl;
      }
      const payload = {
        asset_id: item.id,
        category: item.category,
        asset_name: item.name,
        company: record.company,
        target_url: record.url || null,
        logo_path: logoPath || null,
        logo_url: logoUrl || null,
        color: record.color,
        price_usd: item.price,
        owner_id: userId,
        status: "active",
      };
      const { data, error } = await supabase
        .from("sponsorships")
        .upsert(payload, { onConflict: "asset_id" })
        .select("id,asset_id,company,target_url,logo_path,logo_url,color,owner_id,created_at")
        .single();
      if (error) {
        if (error.code === "23505" || error.code === "42501") {
          throw new Error("Ese lugar acaba de ser elegido por otra persona. Probá con otro.");
        }
        throw error;
      }
      return fromRow(data);
    },
    subscribe(onChange) {
      const channel = supabase
        .channel("public-sponsorships")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "sponsorships" },
          () => onChange(),
        )
        .subscribe();
      return () => {
        supabase.removeChannel(channel);
      };
    },
  };
}
