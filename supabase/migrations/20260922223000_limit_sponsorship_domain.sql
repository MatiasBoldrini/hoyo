create or replace function public.sponsorship_target_domain(value text)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  host text;
  labels text[];
  label_count integer;
  second_level text;
  tld text;
begin
  if value !~* '^https?://' then
    return null;
  end if;

  host := lower(trim(value));
  host := regexp_replace(host, '^https?://', '', 'i');
  host := split_part(host, '/', 1);
  host := split_part(host, '?', 1);
  host := split_part(host, '#', 1);
  host := regexp_replace(host, '^.*@', '');

  if left(host, 1) = '[' then
    host := split_part(host, ']', 1) || ']';
  else
    host := split_part(host, ':', 1);
  end if;

  host := trim(both '.' from host);
  host := regexp_replace(host, '^www\.', '');
  if host = '' then
    return null;
  end if;
  if host ~ '^[0-9]+(\.[0-9]+){3}$' or position(':' in host) > 0 then
    return host;
  end if;

  labels := string_to_array(host, '.');
  label_count := cardinality(labels);
  if label_count < 2 then
    return host;
  end if;

  second_level := labels[label_count - 1];
  tld := labels[label_count];
  if
    label_count >= 3
    and char_length(tld) = 2
    and second_level = any (array['ac', 'co', 'com', 'edu', 'gob', 'gov', 'mil', 'net', 'nom', 'org', 'tur'])
  then
    return concat_ws('.', labels[label_count - 2], second_level, tld);
  end if;
  return concat_ws('.', second_level, tld);
end;
$$;

alter table public.sponsorships
add column target_domain text
generated always as (public.sponsorship_target_domain(target_url)) stored;

alter table public.sponsorships
add constraint sponsorships_target_url_has_domain check (
  target_url is null or target_domain is not null
);

create unique index sponsorships_active_target_domain_key
on public.sponsorships(target_domain)
where target_domain is not null and status in ('active', 'pending');

comment on column public.sponsorships.target_domain is
'Normalized registrable domain used to prevent duplicate sponsor links across paths and subdomains.';
