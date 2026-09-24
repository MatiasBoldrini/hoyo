-- Payments are paused. Empty assets are claimed immediately at USD 0.
-- Occupied assets cannot be taken over until checkout is enabled again.
-- The first claim per user stays a free_claim. Later empty claims are stored
-- as zero-amount purchases so the lifetime free-claim index can return later.

create or replace function public.reserve_checkout(
  p_asset_id text,
  p_company text,
  p_target_url text,
  p_logo_path text,
  p_color text,
  p_animation text,
  p_design jsonb,
  p_idempotency_key text,
  p_expected_asset_version bigint default null,
  p_ttl_seconds integer default 900
)
returns public.commerce_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.require_verified_user();
  v_asset public.market_assets;
  v_current public.current_sponsorships;
  v_order public.commerce_orders;
  v_kind text;
  v_fingerprint text;
  v_target_domain text := public.sponsorship_target_domain(nullif(p_target_url, ''));
begin
  if p_design is null then
    p_design := '{"x": 0.5, "y": 0.5, "scale": 0.46, "rotation": 0}'::jsonb;
  end if;
  if p_ttl_seconds not between 300 and 1800 then
    raise exception 'reservation TTL must be between 300 and 1800 seconds';
  end if;
  if p_target_url is not null and p_target_url !~ '^https://' then
    raise exception 'target_url must use https';
  end if;
  if p_logo_path is not null and p_logo_path not like v_user_id::text || '/%' then
    raise exception 'logo_path must be in the buyer storage folder';
  end if;
  if p_target_url is not null and v_target_domain is null then
    raise exception 'target_url must contain a domain';
  end if;

  v_fingerprint := md5(concat_ws('|', p_asset_id, p_company, p_target_url,
    p_logo_path, p_color, p_animation, p_design::text, p_expected_asset_version));

  select * into v_order
  from public.commerce_orders
  where buyer_id = v_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_order.request_fingerprint <> v_fingerprint then
      raise exception 'idempotency key was already used with different input';
    end if;
    return v_order;
  end if;

  if v_target_domain is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_target_domain, 0)
    );
    if exists (
      select 1
      from public.current_sponsorships c
      where c.target_domain = v_target_domain
        and c.asset_id <> p_asset_id
        and c.branding_status in ('active', 'pending')
    ) then
      raise exception 'target domain is already claimed';
    end if;
  end if;

  select * into v_asset
  from public.market_assets
  where id = p_asset_id and is_enabled
  for update;
  if not found then raise exception 'asset not found'; end if;
  if p_expected_asset_version is not null and p_expected_asset_version <> v_asset.version then
    raise exception 'stale asset version';
  end if;

  delete from public.asset_reservations
  where asset_id = p_asset_id and expires_at <= now();
  update public.commerce_orders
  set status = 'expired', updated_at = now(), version = version + 1
  where asset_id = p_asset_id and status = 'reserved' and expires_at <= now();

  if exists (select 1 from public.asset_reservations where asset_id = p_asset_id) then
    raise exception 'asset is temporarily reserved';
  end if;

  select * into v_current
  from public.current_sponsorships
  where asset_id = p_asset_id
  for update;
  if v_current.owner_id = v_user_id then raise exception 'buyer already owns this asset'; end if;

  if v_current.history_id is not null then
    raise exception 'asset is already claimed';
  elsif not exists (
    select 1 from public.sponsorship_history
    where owner_id = v_user_id and acquisition_kind = 'free_claim'
  ) then
    v_kind := 'free_claim';
  else
    v_kind := 'purchase';
  end if;

  insert into public.commerce_orders (
    buyer_id, asset_id, kind, amount_cents, asset_version,
    replaces_history_id, company, target_url, logo_path, color, animation, design,
    idempotency_key, request_fingerprint, expires_at
  ) values (
    v_user_id, p_asset_id, v_kind, 0, v_asset.version,
    null, trim(p_company), nullif(p_target_url, ''),
    nullif(p_logo_path, ''), p_color, p_animation, p_design, p_idempotency_key,
    v_fingerprint, now() + make_interval(secs => p_ttl_seconds)
  ) returning * into v_order;

  insert into public.asset_reservations (
    asset_id, order_id, buyer_id, asset_version, expires_at
  ) values (
    p_asset_id, v_order.id, v_user_id, v_asset.version, v_order.expires_at
  );

  return public.complete_market_order(v_order.id);
end;
$$;

revoke all on function public.reserve_checkout(text,text,text,text,text,text,jsonb,text,bigint,integer)
  from public, anon;
grant execute on function public.reserve_checkout(text,text,text,text,text,text,jsonb,text,bigint,integer)
  to authenticated;
