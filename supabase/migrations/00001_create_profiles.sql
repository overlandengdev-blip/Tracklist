-- Create profiles table
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  display_name text not null,
  bio text,
  reputation integer not null default 0,
  created_at timestamptz not null default now()
);

-- Enable RLS
alter table public.profiles enable row level security;

-- Policy: any authenticated user can read any profile
create policy "Authenticated users can view all profiles"
  on public.profiles
  for select
  to authenticated
  using (true);

-- Policy: users can only update their own profile
create policy "Users can update their own profile"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Function: auto-create a profile row when a new user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    split_part(new.email, '@', 1)
  );
  return new;
end;
$$;

-- Trigger: fire after a new row is inserted into auth.users
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
