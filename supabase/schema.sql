-- CityMover: Supabase schema voor cloud-saves.
-- Plak dit in Supabase -> SQL Editor -> New query en klik op "Run".
-- Het script is idempotent: je kunt het veilig meerdere keren uitvoeren.

-- 1 save per gebruiker (slot 1). `data` bevat { format, savedAt, save }.
create table if not exists public.saves (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table public.saves is 'CityMover savegames, één rij per gebruiker';

-- Row Level Security: iedereen ziet en wijzigt alleen zijn eigen rij.
alter table public.saves enable row level security;

drop policy if exists "saves_select_own" on public.saves;
create policy "saves_select_own" on public.saves
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "saves_insert_own" on public.saves;
create policy "saves_insert_own" on public.saves
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "saves_update_own" on public.saves;
create policy "saves_update_own" on public.saves
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "saves_delete_own" on public.saves;
create policy "saves_delete_own" on public.saves
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Rechten (Supabase geeft deze standaard al, maar expliciet is duidelijker).
revoke all on table public.saves from anon;
grant select, insert, update, delete on table public.saves to authenticated;

-- updated_at automatisch bijwerken bij elke wijziging.
create or replace function public.saves_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists saves_set_updated_at on public.saves;
create trigger saves_set_updated_at
  before insert or update on public.saves
  for each row
  execute function public.saves_set_updated_at();
