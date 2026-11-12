-- =========================================================================
-- Códigos de los pacientes de demostración: «DEMO-001» … «DEMO-012».
-- Los pacientes reales conservan el formato del protocolo (P.<centro><nnn>);
-- los demo usan un prefijo propio para no coincidir con ningún código real.
-- =========================================================================

alter table public.patients drop constraint if exists patients_codigo_check;
alter table public.patients add constraint patients_codigo_check
  check (codigo ~ '^P\.[A-Z]{2,4}[0-9]{3}$' or codigo ~ '^DEMO-[0-9]{3}$');
