-- =========================================================================
-- Contornos (máscaras de los pies) corregidos a mano en «Revisión de fotos»,
-- por estudio, toma y foto (réplica). La máscara y las grillas recalculadas
-- con ella se guardan en el bucket PRIVADO `estudios`
-- (mascaras/<paciente>/<estudio>/toma<k>-r<n>.json.gz, ruta que no empieza
-- con el id del paciente: sólo la lee el servidor). Esta tabla registra quién
-- la corrigió y cuándo. Sólo cambia qué píxeles son pie: las temperaturas no
-- se tocan. Sirven también como etiquetas verdaderas para reentrenar la U-Net
-- (scripts/ml/pull-corrected-masks.js).
-- =========================================================================

create table if not exists public.study_mask_corrections (
  id            uuid primary key default gen_random_uuid(),
  study_id      uuid not null references public.studies (id) on delete cascade,
  toma          smallint not null check (toma in (1, 2)),
  replica       smallint not null check (replica between 1 and 20),
  storage_path  text not null,
  clave         text check (clave ~ '^[0-9a-f]{16}$'),
  pixeles       jsonb,
  corregido_por uuid references public.profiles (id) on delete set null,
  corregido_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint study_mask_corrections_unica unique (study_id, toma, replica)
);

create index if not exists study_mask_corrections_corregido_por_idx
  on public.study_mask_corrections (corregido_por);

alter table public.study_mask_corrections enable row level security;

-- El servidor usa la service role (omite RLS) y valida que el estudio sea del
-- médico. Para accesos directos con JWT: el médico tratante y el administrador
-- leen y escriben; el paciente no tiene acceso.
drop policy if exists mask_corrections_medico_all on public.study_mask_corrections;
create policy mask_corrections_medico_all on public.study_mask_corrections
  for all to authenticated
  using (public.is_medico() and exists (
    select 1 from public.studies s where s.id = study_id and s.medico_id = auth.uid()))
  with check (public.is_medico() and exists (
    select 1 from public.studies s where s.id = study_id and s.medico_id = auth.uid()));

drop policy if exists mask_corrections_admin_all on public.study_mask_corrections;
create policy mask_corrections_admin_all on public.study_mask_corrections
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());
