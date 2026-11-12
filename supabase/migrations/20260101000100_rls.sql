-- =========================================================================
-- Row Level Security por rol.
-- El servidor usa la service-role key (omite RLS) y aplica la autorización en
-- la capa de servicios; estas políticas protegen cualquier acceso directo con
-- la anon key + JWT del usuario (defensa en profundidad).
--
-- Reglas:
--  * admin: gestiona perfiles y lee la auditoría; NO accede a datos clínicos.
--  * medico: CRUD sobre sus pacientes (medico_id = auth.uid()) y sus estudios.
--  * paciente: sólo lectura de su ficha, sus estudios e imágenes, y de los
--    resultados que el médico publicó.
-- =========================================================================

-- ---------- Funciones auxiliares (security definer para evitar recursión) ----------
create or replace function public.current_app_role()
returns public.user_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and activo
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_app_role() = 'admin', false)
$$;

create or replace function public.is_medico()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_app_role() = 'medico', false)
$$;

-- ¿El paciente pertenece al médico autenticado?
create or replace function public.is_my_patient(p_patient uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.patients where id = p_patient and medico_id = auth.uid())
$$;

-- ¿El paciente es el usuario autenticado?
create or replace function public.is_self_patient(p_patient uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.patients where id = p_patient and user_id = auth.uid())
$$;

alter table public.profiles          enable row level security;
alter table public.patients          enable row level security;
alter table public.consents          enable row level security;
alter table public.studies           enable row level security;
alter table public.study_images      enable row level security;
alter table public.analysis_results  enable row level security;
alter table public.roi_mediciones    enable row level security;
alter table public.appointments      enable row level security;
alter table public.audit_log         enable row level security;

-- ---------- profiles ----------
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles
  for select to authenticated using (id = auth.uid());

drop policy if exists profiles_admin_all on public.profiles;
create policy profiles_admin_all on public.profiles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists profiles_medico_patients on public.profiles;
create policy profiles_medico_patients on public.profiles
  for select to authenticated
  using (public.is_medico() and exists (
    select 1 from public.patients p where p.user_id = profiles.id and p.medico_id = auth.uid()));

-- El usuario puede editar sus datos de contacto, pero no su rol ni su estado.
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = public.current_app_role() and activo);

-- ---------- patients ----------
drop policy if exists patients_medico_all on public.patients;
create policy patients_medico_all on public.patients
  for all to authenticated
  using (public.is_medico() and medico_id = auth.uid())
  with check (public.is_medico() and medico_id = auth.uid());

drop policy if exists patients_self_select on public.patients;
create policy patients_self_select on public.patients
  for select to authenticated using (user_id = auth.uid());

-- ---------- consents ----------
drop policy if exists consents_medico_all on public.consents;
create policy consents_medico_all on public.consents
  for all to authenticated
  using (public.is_my_patient(patient_id)) with check (public.is_my_patient(patient_id));

drop policy if exists consents_self_select on public.consents;
create policy consents_self_select on public.consents
  for select to authenticated using (public.is_self_patient(patient_id));

-- ---------- studies ----------
drop policy if exists studies_medico_all on public.studies;
create policy studies_medico_all on public.studies
  for all to authenticated
  using (medico_id = auth.uid() and public.is_my_patient(patient_id))
  with check (medico_id = auth.uid() and public.is_my_patient(patient_id));

drop policy if exists studies_self_select on public.studies;
create policy studies_self_select on public.studies
  for select to authenticated using (public.is_self_patient(patient_id));

-- ---------- study_images ----------
drop policy if exists study_images_medico_all on public.study_images;
create policy study_images_medico_all on public.study_images
  for all to authenticated
  using (exists (select 1 from public.studies s where s.id = study_id and s.medico_id = auth.uid()))
  with check (exists (select 1 from public.studies s where s.id = study_id and s.medico_id = auth.uid()));

drop policy if exists study_images_self_select on public.study_images;
create policy study_images_self_select on public.study_images
  for select to authenticated
  using (exists (select 1 from public.studies s where s.id = study_id and public.is_self_patient(s.patient_id)));

-- ---------- analysis_results ----------
drop policy if exists analysis_medico_all on public.analysis_results;
create policy analysis_medico_all on public.analysis_results
  for all to authenticated
  using (exists (select 1 from public.studies s where s.id = study_id and s.medico_id = auth.uid()))
  with check (exists (select 1 from public.studies s where s.id = study_id and s.medico_id = auth.uid()));

-- El paciente sólo ve resultados que su médico publicó.
drop policy if exists analysis_self_published on public.analysis_results;
create policy analysis_self_published on public.analysis_results
  for select to authenticated
  using (exists (select 1 from public.studies s
                 where s.id = study_id and s.publicado and public.is_self_patient(s.patient_id)));

-- ---------- roi_mediciones ----------
drop policy if exists roi_medico_all on public.roi_mediciones;
create policy roi_medico_all on public.roi_mediciones
  for all to authenticated
  using (exists (select 1 from public.analysis_results a join public.studies s on s.id = a.study_id
                 where a.id = analysis_id and s.medico_id = auth.uid()))
  with check (exists (select 1 from public.analysis_results a join public.studies s on s.id = a.study_id
                 where a.id = analysis_id and s.medico_id = auth.uid()));

drop policy if exists roi_self_published on public.roi_mediciones;
create policy roi_self_published on public.roi_mediciones
  for select to authenticated
  using (exists (select 1 from public.analysis_results a join public.studies s on s.id = a.study_id
                 where a.id = analysis_id and s.publicado and public.is_self_patient(s.patient_id)));

-- ---------- appointments ----------
drop policy if exists appointments_medico_all on public.appointments;
create policy appointments_medico_all on public.appointments
  for all to authenticated
  using (medico_id = auth.uid() and public.is_my_patient(patient_id))
  with check (medico_id = auth.uid() and public.is_my_patient(patient_id));

drop policy if exists appointments_self_select on public.appointments;
create policy appointments_self_select on public.appointments
  for select to authenticated using (public.is_self_patient(patient_id));

-- ---------- audit_log ----------
drop policy if exists audit_admin_select on public.audit_log;
create policy audit_admin_select on public.audit_log
  for select to authenticated using (public.is_admin());

drop policy if exists audit_insert_own on public.audit_log;
create policy audit_insert_own on public.audit_log
  for insert to authenticated with check (actor_id = auth.uid());

-- Las funciones auxiliares no deben ser invocables por anónimos.
revoke execute on function public.current_app_role() from anon;
revoke execute on function public.is_admin() from anon;
revoke execute on function public.is_medico() from anon;
revoke execute on function public.is_my_patient(uuid) from anon;
revoke execute on function public.is_self_patient(uuid) from anon;
