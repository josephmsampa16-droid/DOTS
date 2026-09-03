-- profiles.push_token was readable by every signed-in user, because the
-- existing "Logged-in users can view profiles" policy grants SELECT on every
-- profile row to any authenticated caller. An Expo push token is a bearer
-- credential: anyone holding it can send that device arbitrary notifications
-- through Expo's public API, so any signed-up user could have spoofed a
-- "Your driver is here" alert at any other user.
--
-- Column-level REVOKE cannot fix this cleanly — a table-level SELECT grant
-- overrides per-column revokes, so closing it that way means enumerating every
-- other column and re-granting them forever after. Instead the tokens move to
-- their own table whose RLS is scoped to the owning user, which is row-level
-- and so exactly what RLS is good at.

create table if not exists public.push_tokens (
  -- The Expo token is the natural key: one row per device, and a device that
  -- changes hands is reassigned rather than duplicated.
  token text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  updated_at timestamptz not null default now()
);

create index if not exists push_tokens_user_id_idx on public.push_tokens (user_id);

-- Carry over anything already stored. There is nothing today, but this keeps
-- the migration correct if it is ever replayed against a database that has
-- collected tokens.
insert into public.push_tokens (token, user_id)
select push_token, id from public.profiles where push_token is not null
on conflict (token) do update set user_id = excluded.user_id, updated_at = now();

alter table public.profiles drop column if exists push_token;

alter table public.push_tokens enable row level security;

-- A rider only ever touches their own device's token. The Edge Function reads
-- these with the service role key, which bypasses RLS, so nothing else needs
-- read access.
drop policy if exists "Users manage own push tokens" on public.push_tokens;
create policy "Users manage own push tokens"
on public.push_tokens
for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

grant select, insert, update, delete on public.push_tokens to authenticated;
