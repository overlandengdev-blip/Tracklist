-- ============================================================
-- BACKEND V1: New tables + app_config seeds
-- service_tokens, dj_claim_requests, admin_actions
-- Run in Supabase SQL Editor
-- ============================================================

BEGIN;

-- ============================================================
-- 1. service_tokens — cache external API tokens (Spotify, etc.)
-- ============================================================
create table if not exists public.service_tokens (
  service text primary key,
  access_token text not null,
  expires_at timestamptz not null,
  refreshed_at timestamptz not null default now(),
  metadata jsonb default '{}'
);

alter table public.service_tokens enable row level security;

-- Only service_role can read/write (edge functions use service role client)
-- No authenticated-user policies needed

-- ============================================================
-- 2. dj_claim_requests — DJ profile ownership claims
-- ============================================================
create table if not exists public.dj_claim_requests (
  id uuid primary key default gen_random_uuid(),
  dj_id uuid not null references public.djs on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  verification_method text not null
    check (verification_method in ('soundcloud_oauth', 'email', 'social_media')),
  verification_data jsonb default '{}',
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  admin_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles on delete set null
);

alter table public.dj_claim_requests enable row level security;

-- Indexes
create index if not exists idx_dj_claims_dj on public.dj_claim_requests (dj_id);
create index if not exists idx_dj_claims_user on public.dj_claim_requests (user_id);
create index if not exists idx_dj_claims_status on public.dj_claim_requests (status) where status = 'pending';

-- RLS: user can see own claims, admin can see all
create policy "dj_claims_select_own" on public.dj_claim_requests
  for select to authenticated using (auth.uid() = user_id);
create policy "dj_claims_select_admin" on public.dj_claim_requests
  for select to authenticated using (public.is_admin());
create policy "dj_claims_insert_own" on public.dj_claim_requests
  for insert to authenticated with check (auth.uid() = user_id);
create policy "dj_claims_update_admin" on public.dj_claim_requests
  for update to authenticated using (public.is_admin());

-- ============================================================
-- 3. admin_actions — audit log for all admin operations
-- ============================================================
create table if not exists public.admin_actions (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references public.profiles on delete cascade,
  action text not null,
  entity_type text,
  entity_id uuid,
  details jsonb default '{}',
  created_at timestamptz not null default now()
);

alter table public.admin_actions enable row level security;

-- Index for lookup
create index if not exists idx_admin_actions_admin on public.admin_actions (admin_id, created_at desc);
create index if not exists idx_admin_actions_entity on public.admin_actions (entity_type, entity_id);

-- RLS: admin-only read
create policy "admin_actions_select" on public.admin_actions
  for select to authenticated using (public.is_admin());
-- Inserts done via service_role (bypasses RLS)

-- ============================================================
-- 4. Additional app_config seeds
-- ============================================================
insert into public.app_config (key, value) values
  ('identification_enabled', 'true'::jsonb),
  ('notifications_enabled', 'true'::jsonb),
  ('spotify_enabled', 'false'::jsonb),
  ('mock_identification_enabled', 'true'::jsonb),
  ('max_proposals_per_day', '50'::jsonb),
  ('max_votes_per_day', '100'::jsonb),
  ('max_retries_per_day', '3'::jsonb)
on conflict (key) do update set value = excluded.value;

-- Update existing flags to have correct defaults for dev
update public.app_config set value = 'false'::jsonb where key = 'acrcloud_enabled';
update public.app_config set value = 'false'::jsonb where key = 'audd_enabled';

-- ============================================================
-- 5. Schema version
-- ============================================================
insert into public.schema_version (version, description)
values ('1.2.0', 'Backend v1: service_tokens, dj_claim_requests, admin_actions tables + app_config seeds');

COMMIT;
