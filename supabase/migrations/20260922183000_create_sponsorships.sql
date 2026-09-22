create table public.sponsorships (
  id uuid primary key default gen_random_uuid(),
  asset_id text not null unique,
  category text not null check (category in ('parcel', 'building', 'vehicle', 'place')),
  asset_name text not null check (char_length(asset_name) between 1 and 100),
  company text not null check (char_length(company) between 1 and 24),
  target_url text check (target_url is null or target_url ~ '^https?://'),
  logo_path text,
  logo_url text,
  color text not null check (color ~ '^#[0-9a-fA-F]{6}$'),
  price_usd integer not null check (price_usd >= 0),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('pending', 'active', 'rejected', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index sponsorships_owner_id_idx on public.sponsorships(owner_id);
create index sponsorships_status_idx on public.sponsorships(status);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger sponsorships_set_updated_at
before update on public.sponsorships
for each row execute function public.set_updated_at();

alter table public.sponsorships enable row level security;

create policy "Active sponsorships are public"
on public.sponsorships
for select
using (status = 'active' or owner_id = auth.uid());

create policy "Authenticated users can claim available assets"
on public.sponsorships
for insert
to authenticated
with check (owner_id = auth.uid());

create policy "Owners can update their sponsorships"
on public.sponsorships
for update
to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

create policy "Owners can delete their sponsorships"
on public.sponsorships
for delete
to authenticated
using (owner_id = auth.uid());

grant select on public.sponsorships to anon, authenticated;
grant insert, update, delete on public.sponsorships to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sponsor-logos',
  'sponsor-logos',
  true,
  1048576,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "Sponsor logos are public"
on storage.objects
for select
using (bucket_id = 'sponsor-logos');

create policy "Users can upload logos in their folder"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'sponsor-logos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Users can update their logos"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'sponsor-logos'
  and owner_id = auth.uid()::text
)
with check (
  bucket_id = 'sponsor-logos'
  and owner_id = auth.uid()::text
);

create policy "Users can delete their logos"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'sponsor-logos'
  and owner_id = auth.uid()::text
);

alter publication supabase_realtime add table public.sponsorships;
