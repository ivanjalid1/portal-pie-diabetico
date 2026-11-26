-- =========================================================================
-- El análisis punto a punto guarda fuente_rois = 'puntual': se amplía el
-- check de la columna (creado en 20260101000300_dos_tomas.sql).
-- =========================================================================

alter table public.analysis_results drop constraint if exists analysis_results_fuente_rois_check;
alter table public.analysis_results add constraint analysis_results_fuente_rois_check
  check (fuente_rois in ('simulada', 'imagen', 'is2', 'puntual'));
