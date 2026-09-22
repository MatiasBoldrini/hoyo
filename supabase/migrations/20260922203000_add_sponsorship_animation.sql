alter table public.sponsorships
add column animation text not null default 'float'
check (animation in ('float', 'pulse', 'fixed'));
