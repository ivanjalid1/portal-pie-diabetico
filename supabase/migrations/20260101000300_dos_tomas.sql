-- =========================================================================
-- Estudio comparativo de DOS termografías: toma 1 (basal) y toma 2 (control
-- ~30 días después). El estudio representa la visita de control y guarda la
-- fecha y condiciones de ambas tomas; las mediciones por ROI se guardan por toma.
-- =========================================================================

alter table public.studies drop column if exists toma;
alter table public.studies add column if not exists fecha_toma1 timestamptz;
alter table public.studies add column if not exists toma1_origen_study_id uuid
  references public.studies (id) on delete set null;
alter table public.studies add column if not exists temp_ambiente_toma1 numeric(4,1);
alter table public.studies add column if not exists humedad_relativa_toma1 numeric(4,1)
  check (humedad_relativa_toma1 is null or humedad_relativa_toma1 between 0 and 100);

do $$ begin
  alter table public.studies add constraint toma1_anterior
    check (fecha_toma1 is null or fecha_toma1 < fecha_hora);
exception when duplicate_object then null; end $$;

-- Resultado: clasificación de la toma 1 y origen de las temperaturas por ROI.
alter table public.analysis_results add column if not exists fuente_rois text not null default 'simulada'
  check (fuente_rois in ('simulada', 'imagen', 'is2'));
alter table public.analysis_results add column if not exists delta_t_max_toma1 numeric(4,2);
alter table public.analysis_results add column if not exists delta_t_max_roi_toma1 public.roi;
alter table public.analysis_results add column if not exists grupo_toma1 char(1)
  check (grupo_toma1 is null or grupo_toma1 in ('P', 'C'));
alter table public.analysis_results add column if not exists simetrico_toma1 boolean;

-- Mediciones por ROI y por toma (temperaturas absolutas de ambas tomas).
alter table public.roi_mediciones add column if not exists toma smallint not null default 2
  check (toma in (1, 2));
alter table public.roi_mediciones drop constraint if exists roi_mediciones_pkey;
alter table public.roi_mediciones add primary key (analysis_id, toma, roi);
