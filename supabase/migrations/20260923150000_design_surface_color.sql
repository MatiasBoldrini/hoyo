-- The place color is optional and travels inside design, next to the logo
-- placement. Existing rows without surface stay valid.

do $$
declare
  rec record;
  check_sql constant text := $chk$
    jsonb_typeof(design) = 'object'
    and design ?& array['x', 'y', 'scale', 'rotation']
    and jsonb_typeof(design->'x') = 'number'
    and jsonb_typeof(design->'y') = 'number'
    and jsonb_typeof(design->'scale') = 'number'
    and jsonb_typeof(design->'rotation') = 'number'
    and (design->>'x')::numeric between 0.05 and 0.95
    and (design->>'y')::numeric between 0.05 and 0.95
    and (design->>'scale')::numeric between 0.18 and 0.82
    and (design->>'rotation')::numeric between -45 and 45
    and (
      not (design ? 'surface')
      or (
        jsonb_typeof(design->'surface') = 'string'
        and design->>'surface' ~ '^#[0-9a-fA-F]{6}$'
      )
    )
  $chk$;
begin
  for rec in
    select n.nspname, c.relname, con.conname
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('sponsorship_history', 'current_sponsorships', 'commerce_orders')
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%design->>''rotation''%'
  loop
    execute format('alter table %I.%I drop constraint %I', rec.nspname, rec.relname, rec.conname);
    execute format(
      'alter table %I.%I add constraint %I check (%s)',
      rec.nspname,
      rec.relname,
      rec.conname,
      check_sql
    );
  end loop;
end $$;
