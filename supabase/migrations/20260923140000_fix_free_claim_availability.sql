-- free_claim_available() used to call require_verified_user() only inside a
-- WHERE clause. On an empty history table PostgreSQL never evaluates that
-- predicate, so an anonymous session received true. Force the auth check first.

create or replace function public.free_claim_available()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.require_verified_user();
begin
  return not exists (
    select 1
    from public.sponsorship_history h
    where h.owner_id = v_user_id
      and h.acquisition_kind = 'free_claim'
  );
end;
$$;

revoke all on function public.free_claim_available() from public, anon;
grant execute on function public.free_claim_available() to authenticated;
