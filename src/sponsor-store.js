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

const BASE_COLUMNS = "id,asset_id,company,target_url,logo_path,logo_url,color,price_usd,owner_id,created_at,updated_at";
// Until the design migration runs remotely, keep syncing brands without their placement.
let designColumn = true;
const columns = () => (designColumn ? `${BASE_COLUMNS},design` : BASE_COLUMNS);
const missingDesignColumn = (error) =>
  designColumn && ["42703", "PGRST204"].includes(error?.code) && /design/.test(error.message || "");
const LOGO_BUCKET = "sponsor-logos";
const DEFAULT_DESIGN = { x: 0.5, y: 0.5, scale: 0.46, rotation: 0 };

function fromRow(row) {
  return {
    id: row.id,
    itemId: row.asset_id,
    company: row.company,
    url: row.target_url || "",
    logo: row.logo_url || "",
    logoPath: row.logo_path || "",
    color: row.color,
    animation: "fixed",
    design: row.design || { ...DEFAULT_DESIGN },
    price: row.price_usd,
    ownerId: row.owner_id,
    mine: row.owner_id === userId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function removeLogo(path) {
  if (!path) return;
  const { error } = await supabase.storage.from(LOGO_BUCKET).remove([path]);
  if (error) console.warn("No se pudo borrar el logo anterior", error);
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
        .select(columns())
        .in("status", ["active", "pending"])
        .order("created_at", { ascending: true });
      if (missingDesignColumn(error)) {
        designColumn = false;
        return this.list();
      }
      if (error) throw error;
      return data.map(fromRow);
    },
    async save(record, item, previous = null) {
      let logoPath = record.logo ? record.logoPath || "" : "";
      let logoUrl = record.logo && !record.logo.startsWith("data:") ? record.logo : "";
      if (record.logo?.startsWith("data:")) {
        const blob = await dataUrlToBlob(record.logo);
        logoPath = `${userId}/${item.id}.webp`;
        const { error: uploadError } = await supabase.storage
          .from(LOGO_BUCKET)
          .upload(logoPath, blob, { contentType: "image/webp", upsert: true });
        if (uploadError) throw uploadError;
        // The path is stable per asset, so the version keeps browsers from showing a stale logo.
        const { publicUrl } = supabase.storage.from(LOGO_BUCKET).getPublicUrl(logoPath).data;
        logoUrl = `${publicUrl}?v=${Date.now()}`;
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
        animation: "fixed",
        design: record.design || DEFAULT_DESIGN,
        price_usd: item.price,
        owner_id: userId,
        status: "active",
      };
      const upsert = () =>
        supabase
          .from("sponsorships")
          .upsert(designColumn ? payload : { ...payload, design: undefined }, { onConflict: "asset_id" })
          .select(columns())
          .single();
      let { data, error } = await upsert();
      if (missingDesignColumn(error)) {
        designColumn = false;
        ({ data, error } = await upsert());
      }
      if (error) {
        const domainConflict = [error.message, error.details, error.hint]
          .filter(Boolean)
          .some((value) => /target_domain|active_target_domain/i.test(value));
        if (error.code === "23505" && domainConflict) {
          throw new Error("Ese dominio ya está asociado a otra marca. Cada dominio puede aparecer una sola vez.");
        }
        if (error.code === "23505" || error.code === "42501") {
          throw new Error("Otra marca reservó este espacio hace un momento. Probá con otro.");
        }
        throw error;
      }
      if (previous?.logoPath && previous.logoPath !== logoPath) await removeLogo(previous.logoPath);
      return fromRow(designColumn ? data : { ...data, design: record.design });
    },
    async remove(record) {
      const { error } = await supabase
        .from("sponsorships")
        .delete()
        .eq("asset_id", record.itemId)
        .eq("owner_id", userId);
      if (error) throw error;
      await removeLogo(record.logoPath);
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
