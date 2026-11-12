-- =========================================================================
-- TermoPie · esquema de datos (Postgres / Supabase)
-- Principio de minimización (Ley 25.326): los datos personales identificatorios
-- (nombre, correo, teléfono) viven en `profiles`; la ficha clínica (`patients`)
-- se referencia por el código anónimo (P.HC901, P.RF902, P.VHF903).
-- =========================================================================

create extension if not exists pgcrypto;

-- ---------- Tipos enumerados ----------
do $$ begin
  create type public.user_role as enum ('admin', 'medico', 'paciente');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.sexo as enum ('F', 'M');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.tipo_dm as enum ('I', 'II');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.pie as enum ('derecho', 'izquierdo', 'ambos');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.roi as enum ('dedo_mayor', 'dedos_menores', 'metatarso', 'arco_interno', 'arco_externo', 'talon', 'general');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.categoria_riesgo as enum ('sin_riesgo', 'moderado', 'alto');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.estado_estudio as enum ('borrador', 'analizado');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.estado_control as enum ('pendiente', 'realizado', 'cancelado', 'reprogramado');
exception when duplicate_object then null; end $$;

-- ---------- Función para updated_at ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------- Perfiles (1:1 con auth.users) ----------
create table if not exists public.profiles (
  id                    uuid primary key references auth.users (id) on delete cascade,
  email                 text not null unique check (email = lower(email)),
  role                  public.user_role not null,
  nombre                text not null default '',
  apellido              text not null default '',
  telefono              text,
  activo                boolean not null default true,
  must_change_password  boolean not null default true,
  matricula             text,
  especialidad          text,
  institucion           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  last_login_at         timestamptz
);
create index if not exists profiles_role_idx on public.profiles (role);
drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------- Pacientes (ficha clínica, seudonimizada) ----------
create table if not exists public.patients (
  id                            uuid primary key default gen_random_uuid(),
  user_id                       uuid unique references public.profiles (id) on delete set null,
  medico_id                     uuid not null references public.profiles (id) on delete restrict,
  codigo                        text not null unique check (codigo ~ '^P\.[A-Z]{2,4}[0-9]{3}$'),
  dni                           text unique check (dni is null or dni ~ '^[0-9]{7,8}$'),
  fecha_nacimiento              date not null,
  sexo                          public.sexo not null,
  centro                        text not null,
  tipo_dm                       public.tipo_dm not null,
  anios_evolucion_dm            numeric(4,1) not null check (anios_evolucion_dm between 0 and 80),
  insulinorequiriente           boolean not null default false,
  hba1c                         numeric(3,1) check (hba1c between 3 and 20),
  hba1c_fecha                   date,
  hba1c_imputada                boolean not null default false,
  hba1c_nota                    text,
  tabaquismo                    boolean,            -- null = «a consultar»
  neuropatia                    boolean not null default false,
  neuropatia_puntaje            smallint check (neuropatia_puntaje between 0 and 10),
  vibratoria_der                numeric(4,1) check (vibratoria_der between 0 and 50),
  vibratoria_der_mas50          boolean not null default false,
  vibratoria_izq                numeric(4,1) check (vibratoria_izq between 0 and 50),
  vibratoria_izq_mas50          boolean not null default false,
  ulcera_previa_der             boolean not null default false,
  ulcera_previa_izq             boolean not null default false,
  isquemia                      boolean not null default false,
  ampollas                      boolean not null default false,
  hiperqueratosis               boolean not null default false,
  hiperqueratosis_localizacion  text,
  eritema                       boolean not null default false,
  hematomas                     boolean not null default false,
  indice_tobillo_brazo          numeric(3,2),
  peso_kg                       numeric(5,1),
  cirugias_previas              text,
  patologias_previas            text,
  observaciones                 text,
  exclusion                     jsonb not null default '{}'::jsonb,
  consentimiento_firmado        boolean not null default false,
  consentimiento_fecha          date,
  genero_lesion                 boolean,            -- desenlace; null = sin registrar
  lesion_fecha                  date,
  lesion_pie                    public.pie,
  lesion_roi                    public.roi,
  lesion_notas                  text,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  constraint lesion_coherente check (genero_lesion is distinct from true or (lesion_pie is not null and lesion_roi is not null))
);
create index if not exists patients_medico_idx on public.patients (medico_id);
drop trigger if exists patients_updated_at on public.patients;
create trigger patients_updated_at before update on public.patients
  for each row execute function public.set_updated_at();

-- ---------- Consentimiento informado (historial) ----------
create table if not exists public.consents (
  id                 uuid primary key default gen_random_uuid(),
  patient_id         uuid not null references public.patients (id) on delete cascade,
  version            text not null,
  fecha_firma        date not null,
  registrado_por     uuid references public.profiles (id) on delete set null,
  revocado_at        timestamptz,
  motivo_revocacion  text,
  notas              text,
  created_at         timestamptz not null default now()
);
create index if not exists consents_patient_idx on public.consents (patient_id);

-- ---------- Estudios (tomas) ----------
create table if not exists public.studies (
  id                         uuid primary key default gen_random_uuid(),
  patient_id                 uuid not null references public.patients (id) on delete cascade,
  medico_id                  uuid not null references public.profiles (id) on delete restrict,
  toma                       smallint not null default 1 check (toma in (1, 2)),
  fecha_hora                 timestamptz not null default now(),
  centro                     text,
  temp_ambiente              numeric(4,1) not null,
  humedad_relativa           numeric(4,1) not null check (humedad_relativa between 0 and 100),
  distancia_cm               numeric(5,1) not null default 80,
  emisividad                 numeric(3,2) not null default 0.98,
  rango_min                  numeric(4,1) not null default 24,
  rango_max                  numeric(4,1) not null default 35,
  paleta                     text not null default 'Ironbow',
  tiempo_estabilizacion_min  smallint not null default 15,
  fondo                      text not null default 'Cartulina' check (fondo in ('Cartulina', 'Tela')),
  valida                     boolean not null default true,
  motivo_invalidez           text,
  checklist                  text[] not null default '{}',
  estado                     public.estado_estudio not null default 'borrador',
  notas_medico               text not null default '',
  publicado                  boolean not null default false,
  publicado_at               timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint motivo_si_invalida check (valida or motivo_invalidez is not null)
);
create index if not exists studies_patient_idx on public.studies (patient_id, fecha_hora desc);
create index if not exists studies_medico_idx on public.studies (medico_id, fecha_hora desc);
drop trigger if exists studies_updated_at on public.studies;
create trigger studies_updated_at before update on public.studies
  for each row execute function public.set_updated_at();

-- ---------- Imágenes del estudio ----------
create table if not exists public.study_images (
  id             uuid primary key default gen_random_uuid(),
  study_id       uuid not null references public.studies (id) on delete cascade,
  slot           text not null,
  storage_path   text,
  public_url     text,
  mime           text not null,
  size_bytes     integer not null default 0,
  original_name  text,
  created_at     timestamptz not null default now(),
  unique (study_id, slot),
  constraint ubicacion check (storage_path is not null or public_url is not null)
);

-- ---------- Resultado del análisis ----------
create table if not exists public.analysis_results (
  id                  uuid primary key default gen_random_uuid(),
  study_id            uuid not null references public.studies (id) on delete cascade,
  predictor_version   text not null,
  delta_t_max         numeric(4,2) not null,
  delta_t_max_roi     public.roi not null,
  umbral              numeric(3,1) not null default 1.0,
  grupo               char(1) not null check (grupo in ('P', 'C')),
  simetrico           boolean,
  probabilidad        numeric(4,1) not null check (probabilidad between 0 and 100),
  categoria           public.categoria_riesgo not null,
  horizonte_semanas   smallint not null default 6,
  factores            jsonb not null default '[]'::jsonb,
  simulado            boolean not null default true,
  created_at          timestamptz not null default now()
);
create index if not exists analysis_study_idx on public.analysis_results (study_id, created_at desc);

-- ---------- Mediciones por ROI (temperaturas absolutas + ΔT) ----------
create table if not exists public.roi_mediciones (
  analysis_id  uuid not null references public.analysis_results (id) on delete cascade,
  roi          public.roi not null,
  avg_der      numeric(4,2) not null,
  avg_izq      numeric(4,2) not null,
  max_der      numeric(4,2),
  max_izq      numeric(4,2),
  min_der      numeric(4,2),
  min_izq      numeric(4,2),
  dt           numeric(4,2) not null,
  primary key (analysis_id, roi)
);

-- ---------- Controles de seguimiento ----------
create table if not exists public.appointments (
  id          uuid primary key default gen_random_uuid(),
  patient_id  uuid not null references public.patients (id) on delete cascade,
  medico_id   uuid not null references public.profiles (id) on delete restrict,
  study_id    uuid references public.studies (id) on delete set null,
  fecha       date not null,
  motivo      text not null default 'Control termográfico de seguimiento',
  estado      public.estado_control not null default 'pendiente',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists appointments_medico_idx on public.appointments (medico_id, fecha) where estado = 'pendiente';
create index if not exists appointments_patient_idx on public.appointments (patient_id, fecha);
drop trigger if exists appointments_updated_at on public.appointments;
create trigger appointments_updated_at before update on public.appointments
  for each row execute function public.set_updated_at();

-- ---------- Auditoría ----------
create table if not exists public.audit_log (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid references public.profiles (id) on delete set null,
  actor_email  text not null default 'sistema',
  action       text not null,
  entity       text,
  entity_id    text,
  detail       text,
  ip           text,
  created_at   timestamptz not null default now()
);
create index if not exists audit_created_idx on public.audit_log (created_at desc);
create index if not exists audit_action_idx on public.audit_log (action, created_at desc);
