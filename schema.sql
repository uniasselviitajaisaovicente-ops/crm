-- =====================================================================
-- CRM · Follow-up de Rematrícula — Schema Supabase
-- =====================================================================
-- Este script é seguro para rodar múltiplas vezes (idempotente).
-- Use IF NOT EXISTS / CREATE OR REPLACE para não perder dados existentes.
-- Rode no SQL Editor do seu projeto Supabase.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Extensões
-- ---------------------------------------------------------------------
create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- 1. Tabela: profiles
--    Espelha 1:1 auth.users. Criada automaticamente via trigger no signup.
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nome        text not null,
  email       text,
  role        text not null default 'colaborador' check (role in ('admin', 'colaborador')),
  criado_em   timestamptz not null default now()
);

comment on table public.profiles is 'Perfil de cada colaborador/admin do CRM, espelhando auth.users';

-- ---------------------------------------------------------------------
-- 2. Tabela: contacts
--    Cada linha é um "aluno/lead" em acompanhamento de rematrícula.
-- ---------------------------------------------------------------------
create table if not exists public.contacts (
  id              uuid primary key default gen_random_uuid(),
  nome            text not null,
  telefone        text,
  email           text,
  status          text not null default 'nao_contatado' check (status in (
                    'nao_contatado',
                    'contato_realizado',
                    'sem_resposta',
                    'retornou_positivo',
                    'retornou_negativo',
                    'rematriculado',
                    'perdido'
                  )),
  colaborador_id  uuid references public.profiles(id) on delete set null,
  meta            jsonb not null default '{}'::jsonb,  -- curso, polo, tipo, status_aluno, turma, codigo_aluno
  criado_em       timestamptz not null default now(),
  atualizado_em   timestamptz not null default now()
);

comment on table public.contacts is 'Contatos/alunos em acompanhamento de rematrícula (quadro kanban)';

create index if not exists idx_contacts_colaborador on public.contacts(colaborador_id);
create index if not exists idx_contacts_status       on public.contacts(status);
create index if not exists idx_contacts_criado_em    on public.contacts(criado_em desc);

-- ---------------------------------------------------------------------
-- 3. Tabela: notes
--    Anotações de acompanhamento vinculadas a um contato.
-- ---------------------------------------------------------------------
create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references public.contacts(id) on delete cascade,
  autor_id    uuid references public.profiles(id) on delete set null,
  autor_nome  text,
  texto       text not null,
  criado_em   timestamptz not null default now()
);

comment on table public.notes is 'Anotações de follow-up feitas por colaboradores sobre um contato';

create index if not exists idx_notes_contact on public.notes(contact_id);

-- ---------------------------------------------------------------------
-- 4. Trigger: atualiza atualizado_em automaticamente em contacts
-- ---------------------------------------------------------------------
create or replace function public.set_atualizado_em()
returns trigger
language plpgsql
as $$
begin
  new.atualizado_em = now();
  return new;
end;
$$;

drop trigger if exists trg_contacts_atualizado_em on public.contacts;
create trigger trg_contacts_atualizado_em
  before update on public.contacts
  for each row
  execute function public.set_atualizado_em();

-- ---------------------------------------------------------------------
-- 5. Trigger: cria profile automaticamente ao criar usuário (signup)
--    Lê o campo "nome" enviado em options.data no supabase.auth.signUp()
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, nome, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'nome', split_part(new.email, '@', 1)),
    new.email,
    'colaborador'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- 6. Função auxiliar: is_admin()
--    security definer evita recursão infinita nas policies de profiles.
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------
-- 7. Row Level Security
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.contacts enable row level security;
alter table public.notes    enable row level security;

-- ===== profiles =====
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
  on public.profiles for select
  to authenticated
  using (true);

drop policy if exists "profiles_update_self_or_admin" on public.profiles;
create policy "profiles_update_self_or_admin"
  on public.profiles for update
  to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (
    -- um colaborador comum não pode se autopromover a admin
    id = auth.uid() and (role = 'colaborador' or public.is_admin())
    or public.is_admin()
  );

-- Nenhuma policy de insert/delete: profiles são geridos via trigger de signup.

-- ===== contacts =====
drop policy if exists "contacts_select_authenticated" on public.contacts;
create policy "contacts_select_authenticated"
  on public.contacts for select
  to authenticated
  using (true);

drop policy if exists "contacts_insert_authenticated" on public.contacts;
create policy "contacts_insert_authenticated"
  on public.contacts for insert
  to authenticated
  with check (
    public.is_admin() or colaborador_id = auth.uid() or colaborador_id is null
  );

drop policy if exists "contacts_update_owner_or_admin" on public.contacts;
create policy "contacts_update_owner_or_admin"
  on public.contacts for update
  to authenticated
  using (colaborador_id = auth.uid() or public.is_admin())
  with check (public.is_admin() or colaborador_id = auth.uid() or colaborador_id is null);

drop policy if exists "contacts_delete_owner_or_admin" on public.contacts;
create policy "contacts_delete_owner_or_admin"
  on public.contacts for delete
  to authenticated
  using (colaborador_id = auth.uid() or public.is_admin());

-- ===== notes =====
drop policy if exists "notes_select_authenticated" on public.notes;
create policy "notes_select_authenticated"
  on public.notes for select
  to authenticated
  using (true);

drop policy if exists "notes_insert_owner_or_admin" on public.notes;
create policy "notes_insert_owner_or_admin"
  on public.notes for insert
  to authenticated
  with check (
    autor_id = auth.uid()
    and exists (
      select 1 from public.contacts c
      where c.id = contact_id
        and (c.colaborador_id = auth.uid() or public.is_admin())
    )
  );

drop policy if exists "notes_delete_owner_or_admin" on public.notes;
create policy "notes_delete_owner_or_admin"
  on public.notes for delete
  to authenticated
  using (autor_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------
-- 8. Tabela: messages
--    Chat geral da equipe (mural), independente de contatos específicos.
-- ---------------------------------------------------------------------
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  autor_id    uuid references public.profiles(id) on delete set null,
  autor_nome  text,
  texto       text not null,
  criado_em   timestamptz not null default now()
);

comment on table public.messages is 'Chat geral da equipe (mural), visível para todos os colaboradores';

create index if not exists idx_messages_criado_em on public.messages(criado_em desc);

alter table public.messages enable row level security;

drop policy if exists "messages_select_authenticated" on public.messages;
create policy "messages_select_authenticated"
  on public.messages for select
  to authenticated
  using (true);

drop policy if exists "messages_insert_own" on public.messages;
create policy "messages_insert_own"
  on public.messages for insert
  to authenticated
  with check (autor_id = auth.uid());

drop policy if exists "messages_delete_own_or_admin" on public.messages;
create policy "messages_delete_own_or_admin"
  on public.messages for delete
  to authenticated
  using (autor_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------
-- 9. Habilitar Realtime nas tabelas de chat
--    Necessário para que novas mensagens/notas apareçam ao vivo sem F5.
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.notes;

-- ---------------------------------------------------------------------
-- 10. Tornar o primeiro usuário admin (rode manualmente após o 1º signup)
-- ---------------------------------------------------------------------
-- update public.profiles set role = 'admin' where email = 'seu-email@exemplo.com';

