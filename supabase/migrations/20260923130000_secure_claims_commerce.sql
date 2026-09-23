-- Secure, server-owned marketplace state.
--
-- This migration deliberately replaces the client-writable sponsorships table
-- with a read-only compatibility view. Historical rows are retained in
-- sponsorships_legacy and copied into the new ownership model.

alter table public.sponsorships rename to sponsorships_legacy;

drop policy if exists "Active sponsorships are public" on public.sponsorships_legacy;
drop policy if exists "Authenticated users can claim available assets" on public.sponsorships_legacy;
drop policy if exists "Owners can update their sponsorships" on public.sponsorships_legacy;
drop policy if exists "Owners can delete their sponsorships" on public.sponsorships_legacy;
revoke all on public.sponsorships_legacy from anon, authenticated;

create table public.market_assets (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,127}$'),
  category text not null check (category in ('parcel', 'building', 'vehicle', 'place')),
  name text not null check (char_length(name) between 1 and 100),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  is_enabled boolean not null default true,
  version bigint not null default 1 check (version > 0),
  takeover_price_cents bigint not null default 10000 check (takeover_price_cents >= 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sponsorship_history (
  id uuid primary key default gen_random_uuid(),
  asset_id text not null references public.market_assets(id),
  owner_id uuid not null references auth.users(id),
  acquisition_kind text not null check (acquisition_kind in ('legacy', 'free_claim', 'purchase', 'takeover')),
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null default 'USD' check (currency = 'USD'),
  company text not null check (char_length(company) between 1 and 24),
  target_url text check (target_url is null or target_url ~ '^https://'),
  logo_path text check (
    logo_path is null
    or (
      logo_path !~ '(^|/)\.\.(/|$)'
      and logo_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$'
    )
  ),
  color text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  animation text not null default 'float' check (animation in ('float', 'pulse', 'fixed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text,
  source_order_id uuid,
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);

-- A partial unique index is the lifetime-free-claim invariant. It is not tied
-- to current ownership, so releasing or losing an asset never restores it.
create unique index sponsorship_history_one_free_claim_per_user
  on public.sponsorship_history(owner_id)
  where acquisition_kind = 'free_claim';
create index sponsorship_history_asset_started_idx
  on public.sponsorship_history(asset_id, started_at desc);
create index sponsorship_history_owner_started_idx
  on public.sponsorship_history(owner_id, started_at desc);

create table public.current_sponsorships (
  asset_id text primary key references public.market_assets(id),
  history_id uuid not null unique references public.sponsorship_history(id),
  owner_id uuid not null references auth.users(id),
  company text not null check (char_length(company) between 1 and 24),
  target_url text check (target_url is null or target_url ~ '^https://'),
  logo_path text check (
    logo_path is null
    or (
      logo_path !~ '(^|/)\.\.(/|$)'
      and logo_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$'
    )
  ),
  color text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  animation text not null default 'float' check (animation in ('float', 'pulse', 'fixed')),
  branding_status text not null default 'pending'
    check (branding_status in ('pending', 'active', 'rejected', 'suspended')),
  moderation_note text,
  activated_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((branding_status = 'active' and activated_at is not null) or branding_status <> 'active')
);
create index current_sponsorships_owner_idx on public.current_sponsorships(owner_id);

create table public.commerce_orders (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references auth.users(id),
  asset_id text not null references public.market_assets(id),
  kind text not null check (kind in ('free_claim', 'purchase', 'takeover')),
  status text not null default 'reserved'
    check (status in ('reserved', 'paid', 'completed', 'expired', 'cancelled', 'failed')),
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null default 'USD' check (currency = 'USD'),
  asset_version bigint not null check (asset_version > 0),
  replaces_history_id uuid references public.sponsorship_history(id),
  company text not null check (char_length(company) between 1 and 24),
  target_url text check (target_url is null or target_url ~ '^https://'),
  logo_path text check (
    logo_path is null
    or (
      logo_path !~ '(^|/)\.\.(/|$)'
      and logo_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$'
    )
  ),
  color text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  animation text not null default 'float' check (animation in ('float', 'pulse', 'fixed')),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 128),
  request_fingerprint text not null,
  payment_provider text check (payment_provider is null or payment_provider ~ '^[a-z0-9_-]{2,32}$'),
  provider_checkout_id text,
  version bigint not null default 1 check (version > 0),
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (buyer_id, idempotency_key),
  unique (payment_provider, provider_checkout_id),
  check (
    (provider_checkout_id is null and payment_provider is null)
    or (provider_checkout_id is not null and payment_provider is not null)
  )
);
create index commerce_orders_buyer_created_idx
  on public.commerce_orders(buyer_id, created_at desc);
create index commerce_orders_expiry_idx
  on public.commerce_orders(expires_at) where status = 'reserved';

create table public.asset_reservations (
  asset_id text primary key references public.market_assets(id),
  order_id uuid not null unique references public.commerce_orders(id) on delete cascade,
  buyer_id uuid not null references auth.users(id),
  asset_version bigint not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index asset_reservations_expiry_idx on public.asset_reservations(expires_at);

create table public.payment_events (
  id bigint generated always as identity primary key,
  provider text not null check (provider ~ '^[a-z0-9_-]{2,32}$'),
  provider_event_id text not null check (char_length(provider_event_id) between 1 and 255),
  provider_checkout_id text not null,
  order_id uuid not null references public.commerce_orders(id),
  event_type text not null,
  amount_cents bigint not null check (amount_cents >= 0),
  currency text not null check (currency = 'USD'),
  payload jsonb not null,
  received_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);

create table public.sponsorship_audit (
  id bigint generated always as identity primary key,
  asset_id text not null references public.market_assets(id),
  history_id uuid references public.sponsorship_history(id),
  actor_id uuid references auth.users(id),
  action text not null check (action in ('activated', 'rejected', 'suspended', 'released', 'branding_updated')),
  reason text,
  created_at timestamptz not null default now()
);

alter table public.sponsorship_history
  add constraint sponsorship_history_source_order_fk
  foreign key (source_order_id) references public.commerce_orders(id);

-- Preserve every old row. The catalog is initially bootstrapped from known
-- server rows; the complete world catalog is loaded separately via seed.sql.
insert into public.market_assets (id, category, name, takeover_price_cents, created_at, updated_at)
select asset_id, category, asset_name, 10000, created_at, updated_at
from public.sponsorships_legacy
on conflict (id) do nothing;

insert into public.sponsorship_history (
  id, asset_id, owner_id, acquisition_kind, amount_cents, company, target_url,
  logo_path, color, animation, started_at, ended_at, end_reason, created_at
)
select
  id, asset_id, owner_id, 'legacy', price_usd::bigint * 100, company,
  case when target_url ~ '^https://' then target_url else null end,
  case
    when logo_path like owner_id::text || '/%'
      and logo_path !~ '(^|/)\.\.(/|$)'
    then logo_path
    else null
  end,
  color, animation, created_at,
  case when status = 'active' then null else updated_at end,
  case when status = 'active' then null else 'legacy_' || status end,
  created_at
from public.sponsorships_legacy;

insert into public.current_sponsorships (
  asset_id, history_id, owner_id, company, target_url, logo_path, color,
  animation, branding_status, activated_at, updated_at
)
select
  h.asset_id, h.id, h.owner_id, h.company, h.target_url, h.logo_path, h.color,
  h.animation, 'active', h.started_at, greatest(h.started_at, l.updated_at)
from public.sponsorship_history h
join public.sponsorships_legacy l on l.id = h.id
where l.status = 'active';

-- External logo_url is intentionally not migrated. Logos are always addressed
-- by a validated Storage object key.
alter table public.market_assets enable row level security;
alter table public.sponsorship_history enable row level security;
alter table public.current_sponsorships enable row level security;
alter table public.commerce_orders enable row level security;
alter table public.asset_reservations enable row level security;
alter table public.payment_events enable row level security;
alter table public.sponsorship_audit enable row level security;

revoke all on public.market_assets, public.sponsorship_history,
  public.current_sponsorships, public.commerce_orders,
  public.asset_reservations, public.payment_events, public.sponsorship_audit
  from anon, authenticated;

create policy "enabled assets are readable"
on public.market_assets for select
to anon, authenticated
using (is_enabled);

create policy "buyers read own orders"
on public.commerce_orders for select
to authenticated
using (buyer_id = auth.uid());

create policy "owners read own history"
on public.sponsorship_history for select
to authenticated
using (owner_id = auth.uid());

create policy "owners read current ownership"
on public.current_sponsorships for select
to authenticated
using (owner_id = auth.uid());

grant select on public.market_assets to anon, authenticated;
grant select on public.commerce_orders, public.sponsorship_history, public.current_sponsorships
  to authenticated;

create view public.active_branding
with (security_barrier = true)
as
select
  c.asset_id,
  a.category,
  a.name as asset_name,
  c.company,
  c.target_url,
  c.logo_path,
  c.color,
  c.animation,
  c.activated_at,
  c.updated_at
from public.current_sponsorships c
join public.market_assets a on a.id = c.asset_id
where c.branding_status = 'active' and a.is_enabled;

-- Compatibility read surface. owner_id and logo_url are intentionally gone.
create view public.sponsorships
with (security_barrier = true)
as select
  c.history_id as id,
  b.asset_id,
  b.category,
  b.asset_name,
  b.company,
  b.target_url,
  b.logo_path,
  b.color,
  b.animation,
  'active'::text as status,
  b.activated_at as created_at,
  b.updated_at
from public.active_branding b
join public.current_sponsorships c on c.asset_id = b.asset_id;

revoke all on public.active_branding, public.sponsorships from anon, authenticated;
grant select on public.active_branding, public.sponsorships to anon, authenticated;

create or replace function public.require_verified_user()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null or not exists (
    select 1
    from auth.users u
    where u.id = v_user_id
      and coalesce(u.is_anonymous, false) = false
      and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null)
  ) then
    raise exception using
      errcode = '42501',
      message = 'a verified, non-anonymous user is required';
  end if;
  return v_user_id;
end;
$$;
revoke all on function public.require_verified_user() from public, anon, authenticated;

create or replace function public.complete_market_order(p_order_id uuid)
returns public.commerce_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.commerce_orders;
  v_history_id uuid;
  v_current public.current_sponsorships;
begin
  select * into v_order
  from public.commerce_orders
  where id = p_order_id
  for update;

  if not found or v_order.status not in ('reserved', 'paid') then
    raise exception 'order is not completable';
  end if;
  if v_order.expires_at <= now() then
    raise exception 'order has expired';
  end if;

  perform 1 from public.market_assets
  where id = v_order.asset_id and version = v_order.asset_version and is_enabled
  for update;
  if not found then
    raise exception 'asset version changed or asset is disabled';
  end if;

  select * into v_current
  from public.current_sponsorships
  where asset_id = v_order.asset_id
  for update;

  if v_order.replaces_history_id is distinct from v_current.history_id then
    raise exception 'asset ownership changed';
  end if;

  if v_current.history_id is not null then
    update public.sponsorship_history
    set ended_at = now(), end_reason = 'takeover'
    where id = v_current.history_id and ended_at is null;
    delete from public.current_sponsorships where asset_id = v_order.asset_id;
  end if;

  insert into public.sponsorship_history (
    asset_id, owner_id, acquisition_kind, amount_cents, company, target_url,
    logo_path, color, animation, source_order_id
  ) values (
    v_order.asset_id, v_order.buyer_id, v_order.kind, v_order.amount_cents,
    v_order.company, v_order.target_url, v_order.logo_path, v_order.color,
    v_order.animation, v_order.id
  ) returning id into v_history_id;

  insert into public.current_sponsorships (
    asset_id, history_id, owner_id, company, target_url, logo_path, color,
    animation, branding_status
  ) values (
    v_order.asset_id, v_history_id, v_order.buyer_id, v_order.company,
    v_order.target_url, v_order.logo_path, v_order.color, v_order.animation,
    'pending'
  );

  update public.market_assets
  set
    version = version + 1,
    takeover_price_cents = case
      when v_order.kind = 'takeover' then
        case
          when takeover_price_cents > 4611686018427387903
            then takeover_price_cents
          else takeover_price_cents * 2
        end
      else takeover_price_cents
    end,
    updated_at = now()
  where id = v_order.asset_id;

  delete from public.asset_reservations where order_id = v_order.id;
  update public.commerce_orders
  set status = 'completed', completed_at = now(), updated_at = now(), version = version + 1
  where id = v_order.id
  returning * into v_order;
  return v_order;
end;
$$;
revoke all on function public.complete_market_order(uuid) from public, anon, authenticated;

create or replace function public.reserve_checkout(
  p_asset_id text,
  p_company text,
  p_target_url text,
  p_logo_path text,
  p_color text,
  p_animation text,
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
  v_amount bigint;
  v_fingerprint text;
begin
  if p_ttl_seconds not between 300 and 1800 then
    raise exception 'reservation TTL must be between 300 and 1800 seconds';
  end if;
  if p_target_url is not null and p_target_url !~ '^https://' then
    raise exception 'target_url must use https';
  end if;
  if p_logo_path is not null and p_logo_path not like v_user_id::text || '/%' then
    raise exception 'logo_path must be in the buyer storage folder';
  end if;

  v_fingerprint := md5(concat_ws('|', p_asset_id, p_company, p_target_url,
    p_logo_path, p_color, p_animation, p_expected_asset_version));

  select * into v_order
  from public.commerce_orders
  where buyer_id = v_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_order.request_fingerprint <> v_fingerprint then
      raise exception 'idempotency key was already used with different input';
    end if;
    return v_order;
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
    v_kind := 'takeover';
    v_amount := v_asset.takeover_price_cents;
  elsif not exists (
    select 1 from public.sponsorship_history
    where owner_id = v_user_id and acquisition_kind = 'free_claim'
  ) then
    v_kind := 'free_claim';
    v_amount := 0;
  else
    v_kind := 'purchase';
    v_amount := 10000;
  end if;

  insert into public.commerce_orders (
    buyer_id, asset_id, kind, amount_cents, asset_version,
    replaces_history_id, company, target_url, logo_path, color, animation,
    idempotency_key, request_fingerprint, expires_at
  ) values (
    v_user_id, p_asset_id, v_kind, v_amount, v_asset.version,
    v_current.history_id, trim(p_company), nullif(p_target_url, ''),
    nullif(p_logo_path, ''), p_color, p_animation, p_idempotency_key,
    v_fingerprint, now() + make_interval(secs => p_ttl_seconds)
  ) returning * into v_order;

  insert into public.asset_reservations (
    asset_id, order_id, buyer_id, asset_version, expires_at
  ) values (
    p_asset_id, v_order.id, v_user_id, v_asset.version, v_order.expires_at
  );

  -- A free claim has no external checkout or payment event. Complete it in the
  -- same transaction so two concurrent requests cannot consume it twice.
  if v_kind = 'free_claim' then
    return public.complete_market_order(v_order.id);
  end if;
  return v_order;
end;
$$;
revoke all on function public.reserve_checkout(text,text,text,text,text,text,text,bigint,integer)
  from public, anon;
grant execute on function public.reserve_checkout(text,text,text,text,text,text,text,bigint,integer)
  to authenticated;

create or replace function public.attach_provider_checkout(
  p_order_id uuid,
  p_expected_order_version bigint,
  p_provider text,
  p_provider_checkout_id text
)
returns public.commerce_orders
language plpgsql
security definer
set search_path = ''
as $$
declare v_order public.commerce_orders;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  update public.commerce_orders
  set payment_provider = lower(p_provider),
      provider_checkout_id = p_provider_checkout_id,
      version = version + 1,
      updated_at = now()
  where id = p_order_id
    and version = p_expected_order_version
    and status = 'reserved'
    and expires_at > now()
    and amount_cents > 0
    and payment_provider is null
  returning * into v_order;
  if not found then raise exception 'order is not attachable or version is stale'; end if;
  return v_order;
end;
$$;
revoke all on function public.attach_provider_checkout(uuid,bigint,text,text)
  from public, anon, authenticated;
grant execute on function public.attach_provider_checkout(uuid,bigint,text,text)
  to service_role;

create or replace function public.finalize_payment(
  p_provider text,
  p_provider_event_id text,
  p_provider_checkout_id text,
  p_order_id uuid,
  p_expected_order_version bigint,
  p_amount_cents bigint,
  p_currency text,
  p_event_type text,
  p_payload jsonb
)
returns public.commerce_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.commerce_orders;
  v_existing public.payment_events;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_provider text := lower(p_provider);
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;

  select * into v_existing
  from public.payment_events
  where provider = v_provider and provider_event_id = p_provider_event_id;
  if found then
    if v_existing.order_id <> p_order_id
      or v_existing.provider_checkout_id <> p_provider_checkout_id
      or v_existing.amount_cents <> p_amount_cents
      or v_existing.currency <> upper(p_currency)
      or v_existing.payload is distinct from v_payload
    then
      raise exception 'payment event id was reused with different data';
    end if;
    select * into v_order from public.commerce_orders where id = p_order_id;
    return v_order;
  end if;

  select * into v_order from public.commerce_orders where id = p_order_id for update;
  if not found then raise exception 'order not found'; end if;
  if v_order.version <> p_expected_order_version then
    raise exception 'stale order version';
  end if;
  if v_order.status <> 'reserved' or v_order.expires_at <= now() then
    raise exception 'order is not payable';
  end if;
  if v_order.amount_cents <> p_amount_cents or v_order.currency <> upper(p_currency) then
    raise exception 'payment amount or currency mismatch';
  end if;
  if v_order.payment_provider is distinct from v_provider then
    raise exception 'payment provider does not match attached checkout';
  end if;
  if v_order.provider_checkout_id is distinct from p_provider_checkout_id then
    raise exception 'provider checkout does not match order';
  end if;

  insert into public.payment_events (
    provider, provider_event_id, provider_checkout_id, order_id, event_type, amount_cents,
    currency, payload
  ) values (
    v_provider, p_provider_event_id, p_provider_checkout_id, p_order_id, p_event_type,
    p_amount_cents, upper(p_currency), v_payload
  );
  update public.commerce_orders
  set status = 'paid', updated_at = now(), version = version + 1
  where id = p_order_id;
  return public.complete_market_order(p_order_id);
end;
$$;
revoke all on function public.finalize_payment(text,text,text,uuid,bigint,bigint,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_payment(text,text,text,uuid,bigint,bigint,text,text,jsonb)
  to service_role;

create or replace function public.moderate_branding(
  p_asset_id text,
  p_decision text,
  p_reason text default null
)
returns public.current_sponsorships
language plpgsql
security definer
set search_path = ''
as $$
declare v_current public.current_sponsorships;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  if p_decision not in ('active', 'rejected', 'suspended') then
    raise exception 'invalid moderation decision';
  end if;
  update public.current_sponsorships
  set branding_status = p_decision,
      moderation_note = p_reason,
      activated_at = case when p_decision = 'active' then coalesce(activated_at, now()) else null end,
      updated_at = now()
  where asset_id = p_asset_id
  returning * into v_current;
  if not found then raise exception 'current sponsorship not found'; end if;
  insert into public.sponsorship_audit(asset_id, history_id, actor_id, action, reason)
  values (
    p_asset_id, v_current.history_id, auth.uid(),
    case when p_decision = 'active' then 'activated' else p_decision end,
    p_reason
  );
  return v_current;
end;
$$;
revoke all on function public.moderate_branding(text,text,text) from public, anon, authenticated;
grant execute on function public.moderate_branding(text,text,text) to service_role;

create or replace function public.update_branding(
  p_asset_id text,
  p_company text,
  p_target_url text,
  p_logo_path text,
  p_color text,
  p_animation text
)
returns public.current_sponsorships
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.require_verified_user();
  v_current public.current_sponsorships;
begin
  if p_target_url is not null and p_target_url !~ '^https://' then
    raise exception 'target_url must use https';
  end if;
  if p_logo_path is not null and p_logo_path not like v_user_id::text || '/%' then
    raise exception 'logo_path must be in the owner storage folder';
  end if;
  update public.current_sponsorships
  set company = trim(p_company), target_url = nullif(p_target_url, ''),
      logo_path = nullif(p_logo_path, ''), color = p_color, animation = p_animation,
      branding_status = 'pending', moderation_note = null, activated_at = null,
      updated_at = now()
  where asset_id = p_asset_id and owner_id = v_user_id
  returning * into v_current;
  if not found then raise exception 'current sponsorship not found'; end if;
  insert into public.sponsorship_audit(asset_id, history_id, actor_id, action)
  values (p_asset_id, v_current.history_id, v_user_id, 'branding_updated');
  return v_current;
end;
$$;
revoke all on function public.update_branding(text,text,text,text,text,text) from public, anon;
grant execute on function public.update_branding(text,text,text,text,text,text) to authenticated;

create or replace function public.release_sponsorship(
  p_asset_id text,
  p_reason text default 'released'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.current_sponsorships;
  v_actor uuid := auth.uid();
begin
  select * into v_current
  from public.current_sponsorships where asset_id = p_asset_id for update;
  if not found then return false; end if;
  if auth.role() <> 'service_role' and v_current.owner_id <> public.require_verified_user() then
    raise exception 'not allowed';
  end if;
  update public.sponsorship_history
  set ended_at = now(), end_reason = left(coalesce(p_reason, 'released'), 500)
  where id = v_current.history_id and ended_at is null;
  delete from public.current_sponsorships where asset_id = p_asset_id;
  update public.market_assets set version = version + 1, updated_at = now()
  where id = p_asset_id;
  insert into public.sponsorship_audit(asset_id, history_id, actor_id, action, reason)
  values (p_asset_id, v_current.history_id, v_actor, 'released', p_reason);
  return true;
end;
$$;
revoke all on function public.release_sponsorship(text,text) from public, anon;
grant execute on function public.release_sponsorship(text,text) to authenticated, service_role;

create or replace function public.release_expired_reservations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  if auth.role() <> 'service_role' then raise exception 'service role required'; end if;
  with expired as (
    delete from public.asset_reservations
    where expires_at <= now()
    returning order_id
  )
  update public.commerce_orders o
  set status = 'expired', updated_at = now(), version = version + 1
  from expired e
  where o.id = e.order_id and o.status = 'reserved';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.release_expired_reservations() from public, anon, authenticated;
grant execute on function public.release_expired_reservations() to service_role;

-- Logos are private at the bucket level. Public reads are allowed only when an
-- exact object key is referenced by currently active branding.
update storage.buckets
set public = false, file_size_limit = 1048576,
    allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp']
where id = 'sponsor-logos';

drop policy if exists "Sponsor logos are public" on storage.objects;
drop policy if exists "Users can upload logos in their folder" on storage.objects;
drop policy if exists "Users can update their logos" on storage.objects;
drop policy if exists "Users can delete their logos" on storage.objects;

create policy "active sponsor logos are readable"
on storage.objects for select
to anon, authenticated
using (
  bucket_id = 'sponsor-logos'
  and exists (
    select 1 from public.active_branding b where b.logo_path = name
  )
);

create policy "owners upload sponsor logos"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'sponsor-logos'
  and (storage.foldername(name))[1] = auth.uid()::text
  and lower(storage.extension(name)) in ('png', 'jpg', 'jpeg', 'webp')
);

create policy "owners manage unreferenced sponsor logos"
on storage.objects for update
to authenticated
using (
  bucket_id = 'sponsor-logos'
  and owner_id = auth.uid()::text
  and not exists (select 1 from public.active_branding b where b.logo_path = name)
)
with check (
  bucket_id = 'sponsor-logos'
  and owner_id = auth.uid()::text
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "owners delete unreferenced sponsor logos"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'sponsor-logos'
  and owner_id = auth.uid()::text
  and not exists (select 1 from public.active_branding b where b.logo_path = name)
);

-- The old table remains only as migration evidence and is no longer streamed.
do $$
begin
  alter publication supabase_realtime drop table public.sponsorships_legacy;
exception when undefined_object then
  null;
end
$$;
