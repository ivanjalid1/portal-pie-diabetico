-- =========================================================================
-- Datos reales de la cohorte en Supabase (scripts/seed-supabase-real.js).
--
-- La planilla clínica no tiene todos los datos de cada paciente y la cámara
-- no registra el ambiente: lo que falta queda vacío (nunca se inventa), como
-- en la carga local SEED=real. Se relajan las restricciones que lo impedían.
-- =========================================================================

-- Ficha clínica: datos que la planilla puede no tener.
alter table public.patients alter column fecha_nacimiento drop not null;
alter table public.patients alter column sexo drop not null;
alter table public.patients alter column tipo_dm drop not null;
alter table public.patients alter column anios_evolucion_dm drop not null;

-- «Sin dato» de neuropatía (el riesgo usa el prior IWGDF por defecto o la CNN).
alter table public.patients add column if not exists neuropatia_sin_dato boolean not null default false;

-- Desenlace registrado en la planilla sin pie / región: se admite (el
-- formulario del portal sigue exigiéndolos al registrar uno nuevo).
alter table public.patients drop constraint if exists lesion_coherente;

-- Estudio: ambiente no registrado y estudios con una sola toma (la fecha de
-- la toma 1 coincide con la del estudio).
alter table public.studies alter column temp_ambiente drop not null;
alter table public.studies alter column humedad_relativa drop not null;
alter table public.studies drop constraint if exists toma1_anterior;
alter table public.studies add constraint toma1_anterior
  check (fecha_toma1 is null or fecha_toma1 <= fecha_hora);

-- Bucket privado `modelos`: coeficientes y pesos derivados de datos reales
-- (pronóstico por zona, CNN de neuropatía, atlas de angiosomas, referencia
-- del TCI). Sin políticas para `authenticated`/`anon`: sólo el servidor
-- (service role) los lee al arrancar.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('modelos', 'modelos', false, 10485760, array['application/json', 'application/octet-stream'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
