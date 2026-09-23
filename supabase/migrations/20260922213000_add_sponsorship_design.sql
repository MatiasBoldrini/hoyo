alter table public.sponsorships
add column design jsonb not null default '{"x": 0.5, "y": 0.5, "scale": 0.46, "rotation": 0}'::jsonb;

alter table public.sponsorships
add constraint sponsorships_design_shape check (
  jsonb_typeof(design) = 'object'
  and design ?& array['x', 'y', 'scale', 'rotation']
  and (design->>'x')::numeric between 0.05 and 0.95
  and (design->>'y')::numeric between 0.05 and 0.95
  and (design->>'scale')::numeric between 0.18 and 0.82
  and (design->>'rotation')::numeric between -45 and 45
);
