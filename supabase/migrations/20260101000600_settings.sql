-- =========================================================================
-- Configuración global de los parámetros del análisis y snapshot por análisis.
-- (Pendiente de aplicar: no se ejecutó contra el proyecto de producción.)
-- =========================================================================

create table if not exists public.settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id) on delete set null
);

alter table public.settings enable row level security;

-- Lectura: médicos y administradores. Escritura: sólo a través del servidor
-- (service role), que valida rol y registra la auditoría.
drop policy if exists settings_staff_read on public.settings;
create policy settings_staff_read on public.settings
  for select to authenticated using (public.is_admin() or public.is_medico());

-- Parámetros con los que se calculó cada análisis (umbral, corte de simetría,
-- referencia, cambio relevante, cortes de riesgo, horizonte).
alter table public.analysis_results add column if not exists parametros jsonb;
