import { createClient } from "@supabase/supabase-js";
import { SPONSOR_CONTRACT } from "./sponsor-contract.js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const sponsorStoreEnabled = Boolean(url && key);

const supabase = sponsorStoreEnabled
  ? createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

const DEFAULT_DESIGN = Object.freeze({ x: 0.5, y: 0.5, scale: 0.46, rotation: 0 });

function messageFor(error) {
  const domainConflict = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .some((value) => /target_domain|active_target_domain|dominio/i.test(value));
  if (error?.code === "23505" && domainConflict) {
    return "Ese dominio ya está asociado a otra marca. Cada dominio puede aparecer una sola vez.";
  }
  if (error?.code === "23505") {
    return "Ese lugar cambió de estado. Actualizá la ciudad e intentá de nuevo.";
  }
  if (error?.code === "42501") return "Tu sesión no está autorizada para realizar esa operación.";
  if (/already claimed|already owns/i.test(error?.message || "")) {
    return "Ese lugar ya está ocupado. Elegí uno libre.";
  }
  return error?.message || "El servidor no pudo completar la operación.";
}

function throwIf(error) {
  if (error) throw new Error(messageFor(error));
}

function fromRow(row, logoUrls) {
  const logoPath = row.logo_path || "";
  return {
    id: row.id,
    itemId: row.asset_id,
    company: row.company,
    url: row.target_url || "",
    logo: logoUrls.get(logoPath) || "",
    logoPath,
    color: row.color,
    animation: "fixed",
    design: row.design || { ...DEFAULT_DESIGN },
    mine: row.mine === true,
    createdAt: row.created_at,
    nextPrice: Number(row.next_price_cents || 0) / 100,
    canTakeover: row.can_takeover !== false,
    assetVersion: row.asset_version ?? null,
    brandingStatus: row.branding_status || "",
  };
}

async function signedLogoUrls(rows) {
  const paths = [...new Set(rows.map((row) => row.logo_path).filter(Boolean))];
  const urls = new Map();
  if (paths.length === 0) return urls;
  const { data, error } = await supabase.storage
    .from(SPONSOR_CONTRACT.logoBucket)
    .createSignedUrls(paths, 3600);
  throwIf(error);
  for (const item of data || []) {
    if (item.path && item.signedUrl && !item.error) urls.set(item.path, item.signedUrl);
  }
  return urls;
}

async function session() {
  const { data, error } = await supabase.auth.getSession();
  throwIf(error);
  return data.session;
}

async function requireUser() {
  const current = await session();
  if (!current?.user || current.user.is_anonymous) {
    throw new Error("Iniciá sesión con tu email para continuar.");
  }
  return current.user;
}

function updateBrandingPayload(record, item, logoPath) {
  return {
    p_asset_id: item.id,
    p_company: record.company,
    p_target_url: record.url || null,
    p_logo_path: logoPath || null,
    p_color: record.color,
    p_animation: "fixed",
    p_design: record.design || DEFAULT_DESIGN,
  };
}

export async function connectSponsorStore() {
  if (!supabase) return null;
  return {
    getSession: session,
    onAuthChange(callback) {
      const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => callback(nextSession));
      return () => data.subscription.unsubscribe();
    },
    async sendMagicLink(email) {
      const redirectTo = new URL(window.location.href);
      redirectTo.search = "";
      redirectTo.hash = "";
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo.href, shouldCreateUser: true },
      });
      throwIf(error);
    },
    async logout() {
      const { error } = await supabase.auth.signOut();
      throwIf(error);
    },
    async getClaimStatus() {
      if (!SPONSOR_CONTRACT.rpc.claimStatus) return { available: null };
      await requireUser();
      const { data, error } = await supabase.rpc(SPONSOR_CONTRACT.rpc.claimStatus);
      throwIf(error);
      const value = Array.isArray(data) ? data[0] : data;
      if (typeof value === "boolean") return { available: value };
      if (typeof value?.available === "boolean") return { available: value.available };
      if (typeof value?.free_claim_used === "boolean") {
        return { available: !value.free_claim_used };
      }
      return { available: null };
    },
    async list() {
      const { data, error } = await supabase.rpc(SPONSOR_CONTRACT.rpc.list);
      throwIf(error);
      const rows = data || [];
      const logoUrls = await signedLogoUrls(rows);
      return rows.map((row) => fromRow(row, logoUrls));
    },
    async uploadLogo(dataUrl, item) {
      if (!dataUrl?.startsWith("data:")) return "";
      const user = await requireUser();
      const blob = await (await fetch(dataUrl)).blob();
      if (blob.type !== "image/webp") throw new Error("La imagen tiene que subirse como WebP.");
      const safeAsset = item.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      const path = `${user.id}/${safeAsset}/${crypto.randomUUID()}.webp`;
      const { error } = await supabase.storage
        .from(SPONSOR_CONTRACT.logoBucket)
        .upload(path, blob, { contentType: "image/webp", upsert: false });
      throwIf(error);
      return path;
    },
    async save(record, item) {
      await requireUser();
      const logoPath = record.logo?.startsWith("data:")
        ? await this.uploadLogo(record.logo, item)
        : record.logoPath || "";
      const { error } = await supabase.rpc(
        SPONSOR_CONTRACT.rpc.updateBranding,
        updateBrandingPayload(record, item, logoPath),
      );
      throwIf(error);
      const row = (await this.list()).find((candidate) => candidate.itemId === item.id);
      if (!row) throw new Error("El servidor no devolvió la marca confirmada.");
      return row;
    },
    async acquire(record, item, currentRecord) {
      await requireUser();
      const logoPath = record.logo?.startsWith("data:")
        ? await this.uploadLogo(record.logo, item)
        : record.logoPath || "";
      let assetVersion = currentRecord?.assetVersion ?? null;
      if (assetVersion === null) {
        const { data: asset, error: assetError } = await supabase
          .from("market_assets")
          .select("version")
          .eq("id", item.id)
          .single();
        throwIf(assetError);
        assetVersion = asset.version;
      }
      const retryKey = `hoyo-checkout:${item.id}`;
      const idempotencyKey = sessionStorage.getItem(retryKey) || crypto.randomUUID();
      sessionStorage.setItem(retryKey, idempotencyKey);
      const { data, error } = await supabase.functions.invoke(SPONSOR_CONTRACT.functions.checkout, {
        body: {
          asset_id: item.id,
          company: record.company,
          target_url: record.url || null,
          logo_path: logoPath || null,
          color: record.color,
          animation: "fixed",
          design: record.design || DEFAULT_DESIGN,
          idempotency_key: idempotencyKey,
          expected_asset_version: assetVersion,
          success_url: `${location.origin}${location.pathname}?checkout=returned`,
          cancel_url: `${location.origin}${location.pathname}?checkout=cancelled`,
        },
      });
      if (error) {
        let detail = error.message;
        try {
          const body = await error.context?.json?.();
          const nested = body?.error;
          detail = (typeof nested === "string" ? nested : nested?.message) ||
            (typeof body?.message === "string" ? body.message : "") ||
            detail;
        } catch {
          detail = error.message;
        }
        throw new Error(messageFor({ message: detail }));
      }
      sessionStorage.removeItem(retryKey);
      if (data?.status === "completed") return data;
      throw new Error("El servidor no confirmó el lugar gratis.");
    },
    async remove(record) {
      await requireUser();
      const { data, error } = await supabase.rpc(SPONSOR_CONTRACT.rpc.release, {
        p_asset_id: record.itemId,
        p_reason: "released",
      });
      throwIf(error);
      if (data !== true) throw new Error("El servidor no confirmó la liberación del espacio.");
    },
    subscribe(onChange) {
      const channel = supabase
        .channel("public-sponsorships")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: SPONSOR_CONTRACT.table },
          onChange,
        )
        .subscribe();
      return () => supabase.removeChannel(channel);
    },
  };
}
