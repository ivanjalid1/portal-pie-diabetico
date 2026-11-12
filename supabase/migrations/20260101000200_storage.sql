-- =========================================================================
-- Storage: bucket privado `estudios` para las imágenes de cada toma.
-- Ruta de los objetos: <patient_id>/<study_id>/<slot>.<ext>
-- =========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'estudios',
  'estudios',
  false,
  10485760, -- 10 MB
  array['image/jpeg', 'image/png', 'image/tiff', 'application/x-fluke-is2', 'application/zip', 'application/octet-stream']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Médico/a: lectura y carga en carpetas de sus pacientes.
drop policy if exists estudios_medico_select on storage.objects;
create policy estudios_medico_select on storage.objects
  for select to authenticated
  using (bucket_id = 'estudios' and public.is_my_patient(((storage.foldername(name))[1])::uuid));

drop policy if exists estudios_medico_insert on storage.objects;
create policy estudios_medico_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'estudios' and public.is_medico()
              and public.is_my_patient(((storage.foldername(name))[1])::uuid));

-- Paciente: sólo lectura de sus propias imágenes.
drop policy if exists estudios_self_select on storage.objects;
create policy estudios_self_select on storage.objects
  for select to authenticated
  using (bucket_id = 'estudios' and public.is_self_patient(((storage.foldername(name))[1])::uuid));

-- No se permite modificar ni borrar imágenes desde el cliente (integridad de la historia clínica).
