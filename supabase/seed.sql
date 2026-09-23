-- The catalog function is installed and run by the production migration.
-- Running it again makes local resets deterministic and keeps this seed
-- idempotent without maintaining a second copy of 1373 IDs.
select public.sync_market_catalog();
