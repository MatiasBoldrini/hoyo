-- Branding goes live as soon as someone claims or edits a place.
-- Pending rows are published too, including anything already submitted.

create or replace function public.publish_branding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.branding_status = 'pending' then
    new.branding_status := 'active';
    new.activated_at := coalesce(new.activated_at, pg_catalog.now());
  end if;
  return new;
end;
$$;

revoke all on function public.publish_branding() from public, anon, authenticated;

drop trigger if exists current_sponsorships_publish_branding on public.current_sponsorships;
create trigger current_sponsorships_publish_branding
before insert or update on public.current_sponsorships
for each row execute function public.publish_branding();

update public.current_sponsorships
set branding_status = 'active',
    activated_at = coalesce(activated_at, now()),
    updated_at = now()
where branding_status = 'pending';
