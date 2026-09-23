create table public.party_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z2-9]{8}$'),
  host_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  duration_seconds integer not null check (duration_seconds in (60, 120, 180, 300)),
  bot_count integer not null check (bot_count between 0 and 7),
  object_refill integer not null check (object_refill between 0 and 2),
  status text not null default 'lobby' check (status in ('lobby', 'playing', 'finished')),
  started_at timestamptz,
  expires_at timestamptz not null default (now() + interval '1 hour'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at <= created_at + interval '1 hour')
);

create index party_rooms_code_idx on public.party_rooms(code);
create index party_rooms_expires_at_idx on public.party_rooms(expires_at);

create trigger party_rooms_set_updated_at
before update on public.party_rooms
for each row execute function public.set_updated_at();

alter table public.party_rooms enable row level security;

create policy "Current party rooms are visible by link"
on public.party_rooms
for select
to authenticated
using (expires_at > now());

create policy "Authenticated users can create party rooms"
on public.party_rooms
for insert
to authenticated
with check (
  host_id = auth.uid()
  and expires_at <= now() + interval '1 hour'
  and status = 'lobby'
  and started_at is null
);

create policy "Hosts can update their party rooms"
on public.party_rooms
for update
to authenticated
using (host_id = auth.uid() and expires_at > now())
with check (
  host_id = auth.uid()
  and expires_at <= created_at + interval '1 hour'
);

grant select, insert, update on public.party_rooms to authenticated;

alter publication supabase_realtime add table public.party_rooms;
