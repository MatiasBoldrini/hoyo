begin;
select plan(31);

select has_table('public', 'market_assets', 'server catalog exists');
select has_table('public', 'sponsorship_history', 'history exists');
select has_table('public', 'current_sponsorships', 'current ownership exists');
select has_table('public', 'commerce_orders', 'versioned orders exist');
select has_table('public', 'payment_events', 'idempotent payment ledger exists');
select has_view('public', 'active_branding', 'public branding view exists');
select has_column('public', 'sponsorship_history', 'design', 'history preserves design');
select has_column('public', 'current_sponsorships', 'design', 'current branding preserves design');
select has_column('public', 'commerce_orders', 'design', 'orders freeze design');
select col_has_check('public', 'sponsorship_history', 'design',
  'history design is database validated');
select col_has_check('public', 'current_sponsorships', 'design',
  'current design is database validated');
select col_has_check('public', 'commerce_orders', 'design',
  'order design is database validated');
select has_function('public', 'reserve_checkout', array[
  'text','text','text','text','text','text','jsonb','text','bigint','integer'
], 'checkout reservation RPC exists');
select has_function('public', 'reserve_checkout', array[
  'text','text','text','text','text','text','text','bigint','integer'
], 'pre-design checkout RPC remains compatible');
select has_function('public', 'finalize_payment', array[
  'text','text','text','uuid','bigint','bigint','text','text','jsonb'
], 'payment finalization RPC exists');
select has_function('public', 'attach_provider_checkout', array[
  'uuid','bigint','text','text'
], 'provider checkout attachment RPC exists');
select has_function('public', 'update_branding', array[
  'text','text','text','text','text','text','jsonb'
], 'branding update RPC accepts design');
select has_function('public', 'update_branding', array[
  'text','text','text','text','text','text'
], 'pre-design branding RPC remains compatible');
select has_function('public', 'free_claim_available', array[]::text[],
  'free claim availability RPC exists');

select is(
  (
    select proargnames
    from pg_proc
    where oid = 'public.reserve_checkout(text,text,text,text,text,text,jsonb,text,bigint,integer)'::regprocedure
  ),
  array[
    'p_asset_id','p_company','p_target_url','p_logo_path','p_color',
    'p_animation','p_design','p_idempotency_key','p_expected_asset_version',
    'p_ttl_seconds'
  ]::text[],
  'PostgREST reservation parameter names remain exact'
);

select isnt_empty(
  $$select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'sponsorship_history_one_free_claim_per_user'
      and indexdef like '%WHERE (acquisition_kind = %free_claim%$$,
  'lifetime free claim has a database unique index'
);

select isnt_empty(
  $$select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'current_sponsorships_live_target_domain_key'
      and indexdef like '%branding_status%active%pending%'$$,
  'active and pending branding is unique by normalized domain'
);
select isnt_empty(
  $$select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'commerce_orders_live_target_domain_key'
      and indexdef like '%status%reserved%paid%'$$,
  'pending orders are unique by normalized domain'
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
  array['text','text','text','text','text','text','jsonb','text','bigint','integer'],
  'authenticated', array['EXECUTE'],
  'authenticated can reserve only through RPC'
);
select function_privs_are(
  'public', 'free_claim_available', array[]::text[],
  'authenticated', array['EXECUTE'],
  'authenticated can query only their own free claim availability'
);

select * from finish();
rollback;
