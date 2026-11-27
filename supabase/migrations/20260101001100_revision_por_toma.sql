-- =========================================================================
-- Revisión manual por TOMA: por toma se usa UNA sola foto (réplica). El
-- revisor puede elegir cuál (`replica_elegida`; null = la sugerida por los
-- criterios automáticos de calidad), marcar la toma aprobada, rechazada o
-- pendiente («Falta revisar») y dejar un comentario. Rechazar es sólo una
-- marca: la toma no se excluye del análisis.
--
-- Reemplaza a la revisión por foto (study_image_reviews), que sólo tenía filas
-- de prueba ya vueltas a «pendiente»: se elimina.
-- =========================================================================

create table if not exists public.study_toma_reviews (
  id              uuid primary key default gen_random_uuid(),
  study_id        uuid not null references public.studies (id) on delete cascade,
  toma            smallint not null check (toma in (1, 2)),
  replica_elegida smallint check (replica_elegida between 1 and 20),
  estado          text not null default 'pendiente'
                    check (estado in ('pendiente', 'aprobado', 'rechazado')),
  comentario      text not null default '' check (char_length(comentario) <= 1000),
  revisado_por    uuid references public.profiles (id) on delete set null,
  revisado_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint study_toma_reviews_unica unique (study_id, toma)
);

create index if not exists study_toma_reviews_revisado_por_idx
  on public.study_toma_reviews (revisado_por);

alter table public.study_toma_reviews enable row level security;

-- El servidor usa la service role (omite RLS) y valida que el estudio sea del
-- médico. Para accesos directos con JWT: el médico tratante y el administrador
-- leen y escriben; el paciente no tiene acceso.
drop policy if exists toma_reviews_medico_all on public.study_toma_reviews;
create policy toma_reviews_medico_all on public.study_toma_reviews
  for all to authenticated
  using (public.is_medico() and exists (
    select 1 from public.studies s where s.id = study_id and s.medico_id = auth.uid()))
  with check (public.is_medico() and exists (
    select 1 from public.studies s where s.id = study_id and s.medico_id = auth.uid()));

drop policy if exists toma_reviews_admin_all on public.study_toma_reviews;
create policy toma_reviews_admin_all on public.study_toma_reviews
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- La revisión por foto queda reemplazada por la revisión por toma.
drop table if exists public.study_image_reviews;
