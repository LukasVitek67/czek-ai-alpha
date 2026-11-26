-- czek-ai: sdílení API klíčů mezi zařízeními (src/keyVault.js). Šifruje se v appce (AES-256-GCM, klíč ze scrypt
-- kódu uživatele) – server vidí jen šifrovaný blob, id (hash z kódu) a sha256 tokenu pro zápis. Projekt czek-ai-tierlist.
-- Použít: Supabase → SQL editor (nebo apply_migration). Idempotentní.
create table if not exists public.key_vault (
  id text primary key check (id ~ '^[0-9a-f]{32}$'),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  blob text not null check (length(blob) between 20 and 65536),
  rev integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  hour_start timestamptz not null default now(),
  writes_hour integer not null default 0
);
alter table public.key_vault enable row level security; -- bez politik: anon k tabulce nesmí, jen přes funkce níže
revoke all on table public.key_vault from anon, authenticated;

create or replace function public.vault_get(p_id text)
returns json language plpgsql security definer set search_path = public, pg_temp as $$
declare r record;
begin
  if p_id is null or p_id !~ '^[0-9a-f]{32}$' then raise exception 'bad id'; end if;
  select blob, rev, updated_at into r from public.key_vault where id = p_id;
  if not found then return null; end if;
  return json_build_object('blob', r.blob, 'rev', r.rev, 'updated_at', r.updated_at);
end $$;

create or replace function public.vault_put(p_id text, p_token text, p_blob text)
returns json language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; h text; recent integer;
begin
  if p_id is null or p_id !~ '^[0-9a-f]{32}$' or p_token is null or p_token !~ '^[0-9a-f]{32}$'
     or p_blob is null or length(p_blob) < 20 or length(p_blob) > 65536 then
    raise exception 'bad input';
  end if;
  h := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  select * into r from public.key_vault where id = p_id for update;
  if not found then
    select count(*) into recent from public.key_vault where created_at > now() - interval '1 hour';
    if recent >= 300 then raise exception 'rate limit'; end if;
    insert into public.key_vault(id, token_hash, blob) values (p_id, h, p_blob);
    return json_build_object('rev', 1);
  end if;
  if r.token_hash <> h then raise exception 'forbidden'; end if;
  if now() - r.hour_start > interval '1 hour' then r.writes_hour := 0; r.hour_start := now(); end if;
  if r.writes_hour >= 60 then raise exception 'rate limit'; end if;
  update public.key_vault set blob = p_blob, rev = r.rev + 1, updated_at = now(), hour_start = r.hour_start, writes_hour = r.writes_hour + 1 where id = p_id;
  return json_build_object('rev', r.rev + 1);
end $$;

create or replace function public.vault_delete(p_id text, p_token text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  if p_id is null or p_id !~ '^[0-9a-f]{32}$' or p_token is null or p_token !~ '^[0-9a-f]{32}$' then raise exception 'bad input'; end if;
  delete from public.key_vault where id = p_id and token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  get diagnostics n = row_count;
  return n > 0;
end $$;

revoke all on function public.vault_get(text), public.vault_put(text, text, text), public.vault_delete(text, text) from public;
grant execute on function public.vault_get(text), public.vault_put(text, text, text), public.vault_delete(text, text) to anon;
