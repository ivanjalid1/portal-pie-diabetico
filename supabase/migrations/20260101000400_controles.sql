-- =========================================================================
-- Controles de seguimiento: estado «ausente», fecha real de realización,
-- estudio realizado en el control (study_id) y estudio que lo originó.
-- =========================================================================

alter type public.estado_control add value if not exists 'ausente';

alter table public.appointments add column if not exists realizado_en timestamptz;
alter table public.appointments add column if not exists motivo_ausencia text;
alter table public.appointments add column if not exists origen_study_id uuid
  references public.studies (id) on delete set null;

comment on column public.appointments.study_id is 'Estudio realizado en este control (toma 2).';
comment on column public.appointments.origen_study_id is 'Estudio desde el que se programó el control.';

create index if not exists appointments_medico_estado_idx on public.appointments (medico_id, estado, fecha);
