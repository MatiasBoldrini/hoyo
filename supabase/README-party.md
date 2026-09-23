# Party backend contract

Party keeps the UI/API introduced on `origin/main`, but room discovery, admission
and lifecycle transitions are server-owned.

## Migration history

`20260923120000_create_party_rooms.sql` is intentionally retained unchanged: it
already exists in the hosted migration history. Fresh databases replay it before
`20260923133000_create_party_rooms.sql`; existing databases apply only the latter
hardening migration. Do not repair or delete the historical entry.

## Security model

- Clients cannot `SELECT`, `INSERT`, or `UPDATE` `party_rooms` directly.
- `join_party_room(code)` performs the code lookup under `security definer`.
  There is no API for listing current rooms. After joining, RLS permits a user to
  read only rooms in which that user has a `party_members` row.
- `create_party_room`, `start_party_room`, and `finish_party_room` own all state
  changes. Start and finish verify `auth.uid()` against `host_id`; invalid state
  transitions and starts too close to expiry are rejected.
- Joining locks the room row before counting/inserting membership, so at most
  eight distinct users are admitted even under concurrent joins. A seat remains
  reserved until room deletion/expiry; disconnecting Presence does not free it.
  This deliberately favors an authoritative cap over a reconnect-sensitive
  online count.
- Presence is only display state. Private Realtime policies allow admitted
  database members onto `party:<room uuid>`, while the UI still slices Presence
  to eight as defense in depth.
- Expired/finished rooms cannot be joined and expired rooms stop satisfying the
  room read policy. A game can start only if its full configured duration fits
  before expiry.

## Authentication and Commerce

Party reuses the persisted Supabase browser session. It returns an existing user
as-is, including a verified email user, and creates an anonymous session only
when there is no session and no Magic Link callback in the URL. Party sets
`detectSessionInUrl: false`; Commerce remains the owner of Magic Link exchange.
During a callback Party waits briefly for that exchange rather than replacing it
with an anonymous login.

An anonymous Party user still cannot transact: `sponsor-store.js` requires a
non-anonymous user. Sending and following its Magic Link replaces/upgrades the
browser session with the verified user before Commerce operations are allowed.
No Commerce ownership can be attached to the discarded anonymous identity.

## Checks

Run the JS contract tests directly:

```sh
node --test tests/party-store.test.mjs
```

With a local Supabase stack (and pgTAP) running:

```sh
supabase test db supabase/tests/party_security.sql
```
