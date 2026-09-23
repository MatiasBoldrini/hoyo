begin;
select plan(17);

select has_table('public', 'market_assets', 'server catalog exists');
select has_table('public', 'sponsorship_history', 'history exists');
select has_table('public', 'current_sponsorships', 'current ownership exists');
select has_table('public', 'commerce_orders', 'versioned orders exist');
select has_table('public', 'payment_events', 'idempotent payment ledger exists');
select has_view('public', 'active_branding', 'public branding view exists');
select has_function('public', 'reserve_checkout', array[
  'text','text','text','text','text','text','text','bigint','integer'
], 'checkout reservation RPC exists');
select has_function('public', 'finalize_payment', array[
  'text','text','text','uuid','bigint','bigint','text','text','jsonb'
], 'payment finalization RPC exists');
select has_function('public', 'attach_provider_checkout', array[
  'uuid','bigint','text','text'
], 'provider checkout attachment RPC exists');

select isnt_empty(
  $$select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'sponsorship_history_one_free_claim_per_user'
      and indexdef like '%WHERE (acquisition_kind = %free_claim%$$,
  'lifetime free claim has a database unique index'
);

select table_privs_are(
  'public', 'current_sponsorships', 'anon', array[]::text[],
  'anonymous cannot access ownership table'
);
select table_privs_are(
  'public', 'payment_events', 'authenticated', array[]::text[],
  'authenticated cannot access payment events'
);
select table_privs_are(
  'public', 'asset_reservations', 'authenticated', array[]::text[],
  'authenticated cannot mutate reservations'
);
select table_privs_are(
  'public', 'sponsorships_legacy', 'authenticated', array[]::text[],
  'legacy records are not exposed'
);
select function_privs_are(
  'public', 'finalize_payment',
  array['text','text','text','uuid','bigint','bigint','text','text','jsonb'],
  'authenticated', array[]::text[],
  'authenticated cannot finalize payments'
);
select function_privs_are(
  'public', 'attach_provider_checkout',
  array['uuid','bigint','text','text'],
  'authenticated', array[]::text[],
  'authenticated cannot attach arbitrary provider checkouts'
);
select function_privs_are(
  'public', 'reserve_checkout',
  array['text','text','text','text','text','text','text','bigint','integer'],
  'authenticated', array['EXECUTE'],
  'authenticated can reserve only through RPC'
);

select * from finish();
rollback;
