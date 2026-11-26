-- =========================================================================
-- Revisión manual de cada foto del visor (réplica de termograma de una toma):
-- aprobada, rechazada o pendiente («Falta revisar»), con un comentario, quién
-- la revisó y cuándo. Es sólo una etiqueta: no cambia temperaturas ni análisis.
-- (Pendiente de aplicar: no se ejecutó contra el proyecto de producción.)
-- =========================================================================

create table if not exists public.study_image_reviews (
  id           uuid primary key default gen_random_uuid(),
  study_id     uuid not null references public.studies (id) on delete cascade,
  toma         smallint not null check (toma in (1, 2)),
  replica      smallint not null check (replica between 1 and 20),
  estado       text not null default 'pendiente'
                 check (estado in ('pendiente', 'aprobado', 'rechazado')),
  comentario   text not null default '' check (char_length(comentario) <= 1000),
  revisado_por uuid references public.profiles (id) on delete set null,
  revisado_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint study_image_reviews_unica unique (study_id, toma, replica)
);

create index if not exists study_image_reviews_revisado_por_idx
  on public.study_image_reviews (revisado_por);

alter table public.study_image_reviews enable row level security;

-- El servidor usa la service role (omite RLS) y valida que el estudio sea del
-- médico. Para accesos directos con JWT: el médico tratante y el administrador
-- leen y escriben; el paciente no tiene acceso.
drop policy if exists image_reviews_medico_all on public.study_image_reviews;
create policy image_reviews_medico_all on public.study_image_reviews
  for all to authenticated
  using (public.is_medico() and exists (
    select 1 from public.studies s where s.id = study_id and s.medico_id = auth.uid()))
  with check (public.is_medico() and exists (
    select 1 from public.studies s where s.id = study_id and s.medico_id = auth.uid()));

drop policy if exists image_reviews_admin_all on public.study_image_reviews;
create policy image_reviews_admin_all on public.study_image_reviews
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());
