-- Public marketplace projection and realtime signal without exposing owner IDs,
-- pending branding, orders, or payment data.

create or replace function public.list_sponsorships()
returns table (
  id uuid,
  asset_id text,
  company text,
  target_url text,
  logo_path text,
  color text,
  animation text,
  mine boolean,
  created_at timestamptz,
  next_price_cents bigint,
  asset_version bigint,
  branding_status text,
  can_takeover boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.history_id,
    c.asset_id,
    case
      when c.branding_status = 'active' or c.owner_id = auth.uid() then c.company
      else 'Ocupado'
    end,
    case
      when c.branding_status = 'active' or c.owner_id = auth.uid() then c.target_url
      else null
    end,
    case
      when c.branding_status = 'active' or c.owner_id = auth.uid() then c.logo_path
      else null
    end,
    case
      when c.branding_status = 'active' or c.owner_id = auth.uid() then c.color
      else '#64748b'
    end,
    case
      when c.branding_status = 'active' or c.owner_id = auth.uid() then c.animation
      else 'fixed'
    end,
    c.owner_id = auth.uid(),
    h.started_at,
    a.takeover_price_cents,
    a.version,
    case when c.owner_id = auth.uid() then c.branding_status else null end,
    not exists (
      select 1
      from public.asset_reservations r
      where r.asset_id = c.asset_id and r.expires_at > now()
    )
  from public.current_sponsorships c
  join public.sponsorship_history h on h.id = c.history_id
  join public.market_assets a on a.id = c.asset_id
  where a.is_enabled
  order by h.started_at;
$$;

revoke all on function public.list_sponsorships() from public;
grant execute on function public.list_sponsorships() to anon, authenticated;

create table public.sponsorship_signals (
  asset_id text primary key references public.market_assets(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  changed_at timestamptz not null default now()
);

alter table public.sponsorship_signals enable row level security;

create policy "sponsorship signals are public"
on public.sponsorship_signals
for select
to anon, authenticated
using (true);

grant select on public.sponsorship_signals to anon, authenticated;

create or replace function public.signal_sponsorship_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset_id text;
begin
  v_asset_id := case when tg_op = 'DELETE' then old.asset_id else new.asset_id end;
  insert into public.sponsorship_signals (asset_id)
  values (v_asset_id)
  on conflict (asset_id) do update
  set revision = public.sponsorship_signals.revision + 1,
      changed_at = now();
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.signal_sponsorship_change() from public, anon, authenticated;

create trigger current_sponsorships_signal_change
after insert or update or delete on public.current_sponsorships
for each row execute function public.signal_sponsorship_change();

insert into public.sponsorship_signals (asset_id)
select asset_id from public.current_sponsorships
on conflict (asset_id) do nothing;

alter publication supabase_realtime add table public.sponsorship_signals;

-- Owners need to preview pending/rejected branding. The existing public policy
-- separately permits reads only for logos referenced by active branding.
create policy "owners read their sponsor logos"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'sponsor-logos'
  and owner_id = auth.uid()::text
);

-- PayPal capture and its webhook can race and legitimately report the same
-- completed provider checkout under different event IDs. Record the additional
-- verified event without transferring ownership twice.
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
  if v_order.amount_cents <> p_amount_cents or v_order.currency <> upper(p_currency) then
    raise exception 'payment amount or currency mismatch';
  end if;
  if v_order.payment_provider is distinct from v_provider then
    raise exception 'payment provider does not match attached checkout';
  end if;
  if v_order.provider_checkout_id is distinct from p_provider_checkout_id then
    raise exception 'provider checkout does not match order';
  end if;

  if v_order.status = 'completed' then
    insert into public.payment_events (
      provider, provider_event_id, provider_checkout_id, order_id, event_type,
      amount_cents, currency, payload
    ) values (
      v_provider, p_provider_event_id, p_provider_checkout_id, p_order_id,
      p_event_type, p_amount_cents, upper(p_currency), v_payload
    );
    return v_order;
  end if;

  if v_order.version <> p_expected_order_version then
    raise exception 'stale order version';
  end if;
  if v_order.status <> 'reserved' or v_order.expires_at <= now() then
    raise exception 'order is not payable';
  end if;

  insert into public.payment_events (
    provider, provider_event_id, provider_checkout_id, order_id, event_type,
    amount_cents, currency, payload
  ) values (
    v_provider, p_provider_event_id, p_provider_checkout_id, p_order_id,
    p_event_type, p_amount_cents, upper(p_currency), v_payload
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
