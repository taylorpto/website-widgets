-- Taylor PTO chat: database schema for the Supabase project "taylor-pto-app".
--
-- Who can see what is enforced HERE (row-level security), not in the app:
--   * Nobody sees anything until a board member approves them.
--   * Joining = sign in, enter the invite code (status "pending"), board approves.
--   * Only admins (board) post in Announcements and see the Board room.
--   * Parents' email addresses are visible to admins only.
-- Secrets (invite code, webhook secret) live in private.settings, which the
-- app can never read directly. This file contains no secrets.

create extension if not exists pg_net with schema extensions;

-- ---------------------------------------------------------------- private
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.settings (
  key   text primary key,
  value text not null
);

-- ---------------------------------------------------------------- tables
create table public.profiles (
  id            uuid primary key references auth.users on delete cascade,
  email         text,
  display_name  text check (display_name is null or char_length(display_name) between 1 and 60),
  grades        smallint[] not null default '{}',
  status        text not null default 'new' check (status in ('new','pending','approved','removed')),
  role          text not null default 'member' check (role in ('member','admin')),
  code_attempts smallint not null default 0,
  created_at    timestamptz not null default now(),
  approved_at   timestamptz,
  approved_by   uuid
);

create table public.rooms (
  id    text primary key,
  name  text not null,
  kind  text not null check (kind in ('announce','chat','board')),
  grade smallint,
  sort  smallint not null
);

insert into public.rooms (id, name, kind, grade, sort) values
  ('announcements', 'Announcements', 'announce', null, 0),
  ('general',       'General',       'chat',     null, 1),
  ('k',             'Kindergarten',  'chat',     0,   10),
  ('g1',            'Grade 1',       'chat',     1,   11),
  ('g2',            'Grade 2',       'chat',     2,   12),
  ('g3',            'Grade 3',       'chat',     3,   13),
  ('g4',            'Grade 4',       'chat',     4,   14),
  ('volunteers',    'Volunteers',    'chat',     null, 20),
  ('board',         'Board',         'board',    null, 30);

create table public.messages (
  id         bigint generated always as identity primary key,
  room_id    text not null references public.rooms on delete cascade,
  user_id    uuid not null default auth.uid() references public.profiles on delete cascade,
  body       text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint body_len check (deleted_at is not null or char_length(body) between 1 and 2000)
);
create index messages_room_time on public.messages (room_id, created_at desc);

create table public.reports (
  id          bigint generated always as identity primary key,
  message_id  bigint not null references public.messages on delete cascade,
  reporter    uuid not null default auth.uid() references public.profiles on delete cascade,
  reason      text check (reason is null or char_length(reason) <= 500),
  created_at  timestamptz not null default now(),
  resolved    boolean not null default false
);

create table public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null default auth.uid() references public.profiles on delete cascade,
  p256dh     text not null,
  auth       text not null,
  rooms      text[] not null default '{announcements}',
  created_at timestamptz not null default now()
);

create table public.reads (
  user_id      uuid not null default auth.uid() references public.profiles on delete cascade,
  room_id      text not null references public.rooms on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (user_id, room_id)
);

-- ---------------------------------------------------------------- helpers
create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'approved');
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and status = 'approved' and role = 'admin');
$$;

create or replace function public.can_see_room(r text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_approved() and exists (
    select 1 from public.rooms where id = r and (kind <> 'board' or public.is_admin()));
$$;

create or replace function public.can_post_room(r text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_approved() and exists (
    select 1 from public.rooms where id = r and (kind = 'chat' or public.is_admin()));
$$;

-- ---------------------------------------------------------------- privileges
revoke all on all tables in schema public from anon, authenticated;

grant select (id, display_name, grades, status, role, created_at) on public.profiles to authenticated;
grant update (display_name, grades) on public.profiles to authenticated;
grant select on public.rooms to authenticated;
grant select, insert (room_id, body) on public.messages to authenticated;
grant select, insert (message_id, reason) on public.reports to authenticated;
grant update (resolved) on public.reports to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant select, insert, update on public.reads to authenticated;

-- ---------------------------------------------------------------- row-level security
alter table public.profiles           enable row level security;
alter table public.rooms              enable row level security;
alter table public.messages           enable row level security;
alter table public.reports            enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.reads              enable row level security;

create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or (status = 'approved' and public.is_approved()) or public.is_admin());
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy rooms_read on public.rooms for select to authenticated
  using (public.can_see_room(id));

create policy messages_read on public.messages for select to authenticated
  using (public.can_see_room(room_id));
create policy messages_post on public.messages for insert to authenticated
  with check (user_id = auth.uid() and public.can_post_room(room_id));

create policy reports_file on public.reports for insert to authenticated
  with check (reporter = auth.uid() and public.is_approved());
create policy reports_admin_read on public.reports for select to authenticated
  using (public.is_admin());
create policy reports_admin_resolve on public.reports for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy push_own on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy reads_own on public.reads for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------------------------------------------------------------- sign-up
-- Every new sign-in gets a profile in status "new". Emails listed in
-- private.settings 'admin_emails' (comma-separated) start as approved admins.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  admins text := coalesce((select value from private.settings where key = 'admin_emails'), '');
  is_board boolean := lower(new.email) = any (string_to_array(replace(lower(admins), ' ', ''), ','));
begin
  insert into public.profiles (id, email, status, role, approved_at)
  values (new.id, new.email,
          case when is_board then 'approved' else 'new' end,
          case when is_board then 'admin' else 'member' end,
          case when is_board then now() end);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Step 2 of joining: enter the invite code, name and grades. Moves "new" -> "pending".
create or replace function public.redeem_invite(p_code text, p_name text, p_grades smallint[])
returns text language plpgsql security definer set search_path = '' as $$
declare
  me public.profiles%rowtype;
  code text := (select value from private.settings where key = 'invite_code');
begin
  select * into me from public.profiles where id = auth.uid() for update;
  if not found then return 'no_profile'; end if;
  if me.status <> 'new' then return me.status; end if;
  if me.code_attempts >= 10 then return 'locked'; end if;
  if upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g')) <> upper(code) then
    update public.profiles set code_attempts = code_attempts + 1 where id = me.id;
    return 'bad_code';
  end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 60 then return 'bad_name'; end if;
  update public.profiles
     set status = 'pending', display_name = trim(p_name),
         grades = coalesce((select array_agg(distinct g) from unnest(p_grades) g where g between 0 and 4), '{}')
   where id = me.id;
  return 'pending';
end $$;

-- ---------------------------------------------------------------- admin tools
create or replace function public.admin_people(p_status text default null)
returns table (id uuid, email text, display_name text, grades smallint[], status text, role text, created_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  return query select p.id, p.email, p.display_name, p.grades, p.status, p.role, p.created_at
    from public.profiles p
   where (p_status is null and p.status <> 'new') or p.status = p_status
   order by p.status = 'pending' desc, p.created_at desc;
end $$;

create or replace function public.admin_set_status(p_user uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if p_status not in ('approved','removed','pending') then raise exception 'bad status'; end if;
  if p_user = auth.uid() then raise exception 'cannot change your own status'; end if;
  update public.profiles
     set status = p_status,
         approved_at = case when p_status = 'approved' then now() else approved_at end,
         approved_by = case when p_status = 'approved' then auth.uid() else approved_by end
   where id = p_user;
end $$;

create or replace function public.admin_set_role(p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if p_role not in ('member','admin') then raise exception 'bad role'; end if;
  if p_user = auth.uid() then raise exception 'cannot change your own role'; end if;
  update public.profiles set role = p_role where id = p_user;
end $$;

create or replace function public.admin_invite_code(p_new text default null)
returns text language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'not allowed'; end if;
  if p_new is not null then
    if char_length(trim(p_new)) < 6 then raise exception 'code too short'; end if;
    update private.settings set value = upper(trim(p_new)) where key = 'invite_code';
  end if;
  return (select value from private.settings where key = 'invite_code');
end $$;

-- Authors can remove their own messages; admins can remove any.
create or replace function public.delete_message(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.messages set deleted_at = now(), body = ''
   where id = p_id and deleted_at is null
     and (user_id = auth.uid() or public.is_admin());
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.is_approved(), public.is_admin(), public.can_see_room(text), public.can_post_room(text),
  public.redeem_invite(text, text, smallint[]), public.admin_people(text), public.admin_set_status(uuid, text),
  public.admin_set_role(uuid, text), public.admin_invite_code(text), public.delete_message(bigint) to authenticated;

-- ---------------------------------------------------------------- push hooks
-- New messages and new pending families call the "notify" Edge Function,
-- which sends the push notifications.
create or replace function private.call_notify(payload jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url     := (select value from private.settings where key = 'notify_url'),
    body    := payload,
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-hook-secret', (select value from private.settings where key = 'hook_secret')));
end $$;

create or replace function private.on_message() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.call_notify(jsonb_build_object('type', 'message', 'id', new.id,
    'room_id', new.room_id, 'user_id', new.user_id, 'body', left(new.body, 240)));
  return new;
end $$;
create trigger messages_notify after insert on public.messages
  for each row execute function private.on_message();

create or replace function private.on_profile_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'pending' and old.status = 'new' then
    perform private.call_notify(jsonb_build_object('type', 'pending', 'user_id', new.id, 'name', new.display_name));
  elsif new.status = 'approved' and old.status <> 'approved' then
    perform private.call_notify(jsonb_build_object('type', 'approved', 'user_id', new.id));
  end if;
  return new;
end $$;
create trigger profiles_notify after update of status on public.profiles
  for each row execute function private.on_profile_status();

-- ---------------------------------------------------------------- realtime
alter publication supabase_realtime add table public.messages;
