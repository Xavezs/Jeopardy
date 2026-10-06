-- Run once in the Supabase SQL editor.
-- Live room state (scores, teams, active clue, powerups...) so a server
-- restart or redeploy no longer wipes a game in progress.
create table if not exists public.game_rooms (
  room_code  text primary key,
  state      jsonb       not null,
  updated_at timestamptz not null default now()
);
create index if not exists game_rooms_updated_at_idx on public.game_rooms (updated_at);

-- Only the bot server touches this table, using the service-role key
-- (which bypasses RLS). With RLS on and no policies, the public anon key
-- cannot read or write it.
alter table public.game_rooms enable row level security;
