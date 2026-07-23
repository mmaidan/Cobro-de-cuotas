-- ============================================================
-- Gestión de Cuotas — Migración inicial para Supabase
-- Ejecutar este archivo completo en: Supabase > SQL Editor > New query
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- PERFILES (rol de cada usuario) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  nombre text not null,
  rol text not null check (rol in ('super','cobrador')),
  created_at timestamptz default now()
);

-- Función auxiliar: ¿el usuario actual es superusuario?
-- security definer -> se ejecuta con permisos de owner y evita recursión de RLS
create or replace function public.is_super()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.profiles
    where id = auth.uid() and rol = 'super'
  );
$$;

alter table public.profiles enable row level security;

create policy "ver_propio_perfil_o_super" on public.profiles
  for select using (auth.uid() = id or public.is_super());

create policy "super_inserta_perfiles" on public.profiles
  for insert with check (public.is_super());

create policy "super_actualiza_perfiles" on public.profiles
  for update using (public.is_super());

create policy "super_elimina_perfiles" on public.profiles
  for delete using (public.is_super());

-- ---------- ALUMNOS ----------
create table if not exists public.alumnos (
  id uuid primary key default gen_random_uuid(),
  apellidos text,
  nombres text,
  dni text,
  curso text,
  turno text,
  telefono text,
  email text,
  tutor_apellido text,
  tutor_nombre text,
  telefono_tutor text,
  email_tutor text,
  activo boolean default true,
  created_at timestamptz default now()
);

alter table public.alumnos enable row level security;

create policy "autenticados_leen_alumnos" on public.alumnos
  for select using (auth.role() = 'authenticated');

create policy "super_inserta_alumnos" on public.alumnos
  for insert with check (public.is_super());

create policy "super_actualiza_alumnos" on public.alumnos
  for update using (public.is_super());

create policy "super_elimina_alumnos" on public.alumnos
  for delete using (public.is_super());

-- ---------- CONFIGURACIÓN (fila única) ----------
create table if not exists public.configuracion (
  id int primary key default 1,
  monto_cuota numeric not null default 15000,
  dia_vencimiento int not null default 10,
  periodo_inicio text not null default to_char(now(), 'YYYY-MM'),
  mora_pct_10dias numeric not null default 10,
  mora_tope_bloques int not null default 3,
  mora_pct_mensual_extra numeric not null default 5,
  constraint solo_una_fila check (id = 1)
);

insert into public.configuracion (id)
  values (1)
  on conflict (id) do nothing;

alter table public.configuracion enable row level security;

create policy "autenticados_leen_config" on public.configuracion
  for select using (auth.role() = 'authenticated');

create policy "super_actualiza_config" on public.configuracion
  for update using (public.is_super());

-- ---------- PAGOS ----------
create table if not exists public.pagos (
  id uuid primary key default gen_random_uuid(),
  alumno_id uuid references public.alumnos(id) on delete cascade,
  periodo text not null,                     -- formato "YYYY-MM"
  monto_base numeric not null,
  recargo_pct numeric not null default 0,
  monto_total numeric not null,
  monto_pagado numeric not null,
  metodo text not null check (metodo in ('efectivo','transferencia')),
  fecha date not null default current_date,
  dias_atraso_al_pagar int default 0,
  registrado_por uuid references auth.users(id),
  created_at timestamptz default now(),
  unique (alumno_id, periodo)
);

alter table public.pagos enable row level security;

create policy "autenticados_leen_pagos" on public.pagos
  for select using (auth.role() = 'authenticated');

create policy "autenticados_registran_pagos" on public.pagos
  for insert with check (auth.role() = 'authenticated');

create policy "autenticados_upsert_pagos" on public.pagos
  for update using (auth.role() = 'authenticated');

create policy "super_elimina_pagos" on public.pagos
  for delete using (public.is_super());

-- ============================================================
-- Después de correr esto: crear el primer superusuario.
-- Ver el paso "Primer superusuario" en el README.
-- ============================================================
