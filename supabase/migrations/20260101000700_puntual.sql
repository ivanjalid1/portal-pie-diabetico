-- =========================================================================
-- Análisis punto a punto: grillas canónicas por toma, métricas, cambio entre
-- tomas y ficha del modelo preliminar, guardados como JSON en cada análisis.
-- (Pendiente de aplicar: no se ejecutó contra el proyecto de producción.)
-- =========================================================================

alter table public.analysis_results add column if not exists puntual jsonb;
