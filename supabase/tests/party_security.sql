begin;
select plan(15);

select has_table('public', 'party_rooms', 'Party rooms exist');
select has_table('public', 'party_members', 'authoritative Party admission exists');
select has_function(
  'public', 'create_party_room', array['integer', 'integer', 'integer'],
  'room creation RPC exists'
);
select has_function('public', 'join_party_room', array['text'], 'code-only join RPC exists');
select has_function('public', 'start_party_room', array['uuid'], 'host start RPC exists');
select has_function('public', 'finish_party_room', array['uuid'], 'host finish RPC exists');

select table_privs_are(
  'public', 'party_rooms', 'authenticated', array[]::text[],
  'clients cannot enumerate or mutate rooms directly'
);
select table_privs_are(
  'public', 'party_members', 'authenticated', array[]::text[],
  'clients cannot manipulate admission directly'
);
select function_privs_are(
  'public', 'create_party_room', array['integer', 'integer', 'integer'],
  'authenticated', array['EXECUTE'], 'authenticated users can create through RPC'
);
select function_privs_are(
  'public', 'join_party_room', array['text'],
  'authenticated', array['EXECUTE'], 'authenticated users can join only through RPC'
);
select function_privs_are(
  'public', 'start_party_room', array['uuid'],
  'authenticated', array['EXECUTE'], 'authenticated users can request host-only start'
);
select function_privs_are(
  'public', 'finish_party_room', array['uuid'],
  'authenticated', array['EXECUTE'], 'authenticated users can request host-only finish'
);

select is(
  (
    select count(*)::integer
    from pg_policies
    where schemaname = 'public'
      and tablename = 'party_rooms'
      and cmd = 'SELECT'
      and qual like '%is_party_member%'
  ),
  1,
  'room SELECT policy is scoped to admitted members'
);
select is(
  (
    select count(*)::integer
    from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname in ('Party members can receive realtime', 'Party members can send realtime')
  ),
  2,
  'private Realtime channels enforce Party admission'
);
select isnt_empty(
  $$select 1
    from pg_constraint
    where conrelid = 'public.party_rooms'::regclass
      and conname = 'party_rooms_state_is_coherent'
      and convalidated$$,
  'room state consistency is validated'
);

select * from finish();
rollback;
