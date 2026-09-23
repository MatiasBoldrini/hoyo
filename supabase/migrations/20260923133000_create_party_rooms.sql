-- Harden the Party schema originally shipped as 20260923120000.
-- The earlier migration remains in the tree because it is already recorded in
-- the hosted project's migration history. This migration is incremental so the
-- same pair works for both existing projects and fresh local databases.

revoke all on public.party_rooms from anon, authenticated;

drop policy if exists "Current party rooms are visible by link" on public.party_rooms;
drop policy if exists "Authenticated users can create party rooms" on public.party_rooms;
drop policy if exists "Hosts can update their party rooms" on public.party_rooms;
drop policy if exists "Party members can read their room" on public.party_rooms;

create table if not exists public.party_members (
  room_id uuid not null references public.party_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default clock_timestamp(),
  primary key (room_id, user_id)
);

create index if not exists party_members_user_idx
  on public.party_members(user_id, room_id);

-- Rooms created before this hardening migration must keep their host admitted.
insert into public.party_members (room_id, user_id, joined_at)
select id, host_id, created_at
from public.party_rooms
on conflict (room_id, user_id) do nothing;

-- Normalize shapes that the original broad UPDATE policy allowed before adding
-- stricter state constraints.
update public.party_rooms
set started_at = null
where status = 'lobby'
  and started_at is not null;
update public.party_rooms
set started_at = least(created_at, expires_at - interval '1 microsecond')
where status in ('playing', 'finished')
  and started_at is null;

alter table public.party_members enable row level security;
revoke all on public.party_members from anon, authenticated;

drop policy if exists "Party members can read themselves" on public.party_members;
create policy "Party members can read themselves"
on public.party_members
for select
to authenticated
using (user_id = auth.uid());

create or replace function public.is_party_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.party_members
    where room_id = p_room_id
      and user_id = auth.uid()
  );
$$;

create or replace function public.can_access_party_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_topic !~ '^party:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;
  return public.is_party_member(substring(p_topic from 7)::uuid);
end;
$$;

create policy "Party members can read their room"
on public.party_rooms
for select
to authenticated
using (
  expires_at > now()
  and public.is_party_member(id)
);

alter table public.party_rooms
  drop constraint if exists party_rooms_state_is_coherent;
alter table public.party_rooms
  add constraint party_rooms_state_is_coherent check (
    (status = 'lobby' and started_at is null)
    or (status in ('playing', 'finished') and started_at is not null)
  ) not valid;
alter table public.party_rooms validate constraint party_rooms_state_is_coherent;

alter table public.party_rooms
  drop constraint if exists party_rooms_start_precedes_expiry;
alter table public.party_rooms
  add constraint party_rooms_start_precedes_expiry
  check (started_at is null or started_at < expires_at) not valid;
alter table public.party_rooms validate constraint party_rooms_start_precedes_expiry;

create or replace function public.party_random_code()
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  entropy bytea := extensions.gen_random_bytes(8);
  result text := '';
  position integer;
begin
  for position in 0..7 loop
    result := result || substr(alphabet, (get_byte(entropy, position) % 32) + 1, 1);
  end loop;
  return result;
end;
$$;

create or replace function public.create_party_room(
  p_duration_seconds integer,
  p_bot_count integer,
  p_object_refill integer
)
returns setof public.party_rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  created public.party_rooms;
  attempt integer;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  for attempt in 1..5 loop
    begin
      insert into public.party_rooms (
        code, host_id, duration_seconds, bot_count, object_refill,
        status, started_at, expires_at
      )
      values (
        public.party_random_code(), caller, p_duration_seconds, p_bot_count,
        p_object_refill, 'lobby', null, now() + interval '1 hour'
      )
      returning * into created;
      exit;
    exception when unique_violation then
      if attempt = 5 then
        raise;
      end if;
    end;
  end loop;

  insert into public.party_members (room_id, user_id)
  values (created.id, caller);

  return next created;
end;
$$;

create or replace function public.join_party_room(p_code text)
returns setof public.party_rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  room_row public.party_rooms;
  member_count integer;
begin
  if caller is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  select *
  into room_row
  from public.party_rooms
  where code = upper(trim(p_code))
  for update;

  if room_row.id is null
     or room_row.expires_at <= clock_timestamp()
     or room_row.status = 'finished' then
    raise exception using errcode = 'P0002', message = 'Party not found or expired';
  end if;

  if exists (
    select 1 from public.party_members
    where room_id = room_row.id and user_id = caller
  ) then
    return next room_row;
    return;
  end if;

  select count(*) into member_count
  from public.party_members
  where room_id = room_row.id;

  if member_count >= 8 then
    raise exception using errcode = 'P0001', message = 'Party is full';
  end if;

  insert into public.party_members (room_id, user_id)
  values (room_row.id, caller);

  return next room_row;
end;
$$;

create or replace function public.start_party_room(p_room_id uuid)
returns setof public.party_rooms
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  room_row public.party_rooms;
  begins_at timestamptz := clock_timestamp() + interval '1.4 seconds';
begin
  select *
  into room_row
  from public.party_rooms
  where id = p_room_id
  for update;

  if room_row.id is null or room_row.host_id is distinct from caller then
    raise exception using errcode = '42501', message = 'Only the host can start this party';
  end if;
  if room_row.status <> 'lobby' then
    raise exception using errcode = 'P0001', message = 'Party is not in the lobby';
  end if;
  if begins_at + make_interval(secs => room_row.duration_seconds) >= room_row.expires_at then
    raise exception using errcode = 'P0001', message = 'Party expired before the game could finish';
  end if;

  update public.party_rooms
  set status = 'playing', started_at = begins_at
  where id = room_row.id
  returning * into room_row;

  return next room_row;
end;
$$;

create or replace function public.finish_party_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  changed integer;
begin
  update public.party_rooms
  set status = 'finished'
  where id = p_room_id
    and host_id = caller
    and status = 'playing';
  get diagnostics changed = row_count;

  if changed = 0 then
    raise exception using errcode = '42501', message = 'Only the host can finish a running party';
  end if;
end;
$$;

revoke all on function public.party_random_code() from public, anon, authenticated;
revoke all on function public.is_party_member(uuid) from public, anon;
revoke all on function public.can_access_party_topic(text) from public, anon;
revoke all on function public.create_party_room(integer, integer, integer) from public, anon;
revoke all on function public.join_party_room(text) from public, anon;
revoke all on function public.start_party_room(uuid) from public, anon;
revoke all on function public.finish_party_room(uuid) from public, anon;
grant execute on function public.create_party_room(integer, integer, integer) to authenticated;
grant execute on function public.is_party_member(uuid) to authenticated;
grant execute on function public.can_access_party_topic(text) to authenticated;
grant execute on function public.join_party_room(text) to authenticated;
grant execute on function public.start_party_room(uuid) to authenticated;
grant execute on function public.finish_party_room(uuid) to authenticated;

-- Realtime Presence/Broadcast uses private channels. Database admission is the
-- authority: only one of the eight persisted members may join a room topic.
drop policy if exists "Party members can receive realtime" on realtime.messages;
drop policy if exists "Party members can send realtime" on realtime.messages;
create policy "Party members can receive realtime"
on realtime.messages
for select
to authenticated
using (
  public.can_access_party_topic((select realtime.topic()))
);
create policy "Party members can send realtime"
on realtime.messages
for insert
to authenticated
with check (
  extension in ('broadcast', 'presence')
  and public.can_access_party_topic((select realtime.topic()))
);

-- The historical migration already adds this table. Keep this guard so a
-- partially provisioned project can still converge without a duplicate error.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'party_rooms'
  ) then
    alter publication supabase_realtime add table public.party_rooms;
  end if;
end
$$;
