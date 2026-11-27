# Despliegue y configuración

## 1. Ejecución local

```bash
npm install
cp .env.example .env       # opcional: sin .env se usa el driver memory
npm run dev                # http://localhost:3000
npm test && npm run lint
```

Con `DATA_DRIVER=memory` la aplicación arranca con la semilla de demostración en memoria (se reinicia en cada arranque).

## 2. Variables de entorno

| Variable | Valor por defecto | Descripción |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` activa cookies `Secure` y caché de estáticos. |
| `PORT` | `3000` | Puerto local. |
| `APP_URL` | `http://localhost:3000` | URL pública (se muestra al entregar credenciales). |
| `DATA_DRIVER` | `memory` | `memory` o `supabase`. |
| `PREDICTOR` | `puntual` | Estrategia de predicción: `puntual` (análisis punto a punto + modelo preliminar), `mock` (simulado), `logreg`, `cnn`. |
| `SEED` | `demo` | Semilla del driver memory: `demo` o `real` (pacientes reales de `data-local/real/`; **sólo local**, nunca en Vercel). |
| `REAL_DATA_DIR` | `data-local/real` | Carpeta de los datos reales precalculados. |
| `ASYMMETRY_THRESHOLD` | `1.0` | Umbral |ΔT| (°C) del grupo P/C. `2.2` = referencia bibliográfica. |
| `SESSION_SECRET` | — | **Obligatorio en producción.** Secreto de firma de la cookie. |
| `SESSION_MAX_AGE_HOURS` | `8` | Duración de la sesión. |
| `COOKIE_SECURE` | `true` en producción | Cookie sólo por HTTPS. |
| `LOGIN_RATE_LIMIT_MAX` / `_WINDOW_MIN` | `10` / `15` | Intentos de ingreso por ventana. |
| `BCRYPT_ROUNDS` | `10` | Costo de bcrypt (driver memory). |
| `MAX_UPLOAD_MB` | `4` | Tamaño máximo por archivo. |
| `SHOW_DEMO_ACCOUNTS` | `true` | Muestra el recuadro «Cuentas demo». Poner `false` con datos reales. |
| `SUPABASE_URL` | — | `https://<ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | — | Clave pública (se usa sólo en el servidor para validar credenciales). |
| `SUPABASE_SERVICE_ROLE_KEY` | — | **Secreta, sólo servidor.** |
| `SUPABASE_BUCKET` | `estudios` | Bucket privado de imágenes. |
| `SUPABASE_SIGNED_URL_TTL` | `120` | Vigencia (s) de las URLs firmadas de imágenes. |

## 3. Supabase

1. Crear el proyecto (región `sa-east-1` recomendada) e instalar el CLI.
2. Vincular y aplicar las migraciones:

   ```bash
   supabase link --project-ref <ref> -p <db-password>
   supabase db push
   ```

   Se crean: tipos, tablas, índices, triggers `updated_at`, **políticas RLS por rol** y el bucket privado `estudios` con sus políticas.
3. Obtener las claves (`supabase projects api-keys --project-ref <ref>`) y completar `.env` con `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY`.
4. Cargar la semilla demo (usuarios en Auth, datos y las termografías demo en Storage):

   ```bash
   npm run seed:supabase            # idempotente
   npm run seed:supabase -- --reset # borra los datos demo y vuelve a cargar
   ```

5. Cambiar `DATA_DRIVER=supabase` y verificar:

   ```bash
   SUPABASE_E2E=1 npx jest tests/supabase
   ```

> En **Authentication → Providers → Email** conviene desactivar el registro público (*Allow new users to sign up*): las cuentas las crea el servidor con la Admin API.

## 4. Vercel

1. Importar el repositorio en Vercel (framework *Other*). No requiere comando de build.
2. `vercel.json` enruta todas las peticiones a `api/index.js` (la app Express) e incluye `src/views/**` y `public/**` en la función. Los archivos de `public/` también se sirven como estáticos.
3. Definir las variables de entorno del punto 2 (como mínimo `NODE_ENV=production`, `SESSION_SECRET`, `APP_URL` y, si corresponde, las de Supabase).
4. Desplegar. Con el driver `memory`, cada arranque en frío restaura los datos demo.

**Límites a tener en cuenta**
- El cuerpo de la petición en funciones de Vercel está limitado a ~4,5 MB: con dos imágenes grandes conviene subirlas directamente a Supabase Storage con *signed upload URLs* (`createSignedUploadUrl`) y enviar al servidor sólo las rutas. El contrato `FileStorage` permite agregarlo sin cambiar los servicios.
- No se usa disco: las imágenes se mantienen en memoria (driver memory) o en Storage.

## 5. Cambiar de driver

`DATA_DRIVER=memory|supabase`. La `RepositoryFactory` (`src/repositories/RepositoryFactory.js`) devuelve los repositorios y el `AuthProvider` correspondientes. Para agregar otro motor (p. ej. Prisma + Postgres propio) se implementan los contratos de `src/repositories/contracts.js` y se agrega un `case` en la fábrica.

## 6. Conectar el algoritmo real

El análisis está aislado detrás de la interfaz `UlcerPredictor` (`src/services/predictors/UlcerPredictor.js`):

```js
class MiPredictor extends UlcerPredictor {
  get info() { return { id: 'logreg', version: 'logreg-v1', nombre: 'Regresión logística', descripcion: '…' }; }
  async predict({ patient, study, images }) {
    // images: [{ slot: 'toma1' | 'toma2', buffer, mime, originalName }]
    // Devuelve rois (toma 2) y roisToma1, más la clasificación de cada toma.
    return { predictorVersion, rois, deltaTMax, deltaTMaxRoi, umbral, grupo, simetrico,
             probabilidad, categoria, horizonteSemanas: 6, factores, simulado: false };
  }
}
```

1. Implementar la clase (ya existen los esqueletos `LogisticRegressionPredictor` y `CnnPredictor` en `FuturePredictors.js`).
2. Registrarla en `PredictorFactory.js` y elegirla con `PREDICTOR=logreg`.
3. Usar `thermalGroup(rois, umbral)` y `categoryFor(probabilidad)` de `src/config/domain.js` para mantener las reglas comunes.

Si el procesamiento se hace en Python (OpenCV, scikit-learn, PyTorch), la estrategia puede llamar a un microservicio HTTP (`CNN_ENDPOINT_URL`) enviando las imágenes y recibiendo el mismo contrato de salida.

### Archivos `.IS2` (Fluke): decodificación implementada

El portal ya decodifica la imagen infrarroja de los `.IS2` (`src/imaging/`):

1. El `.IS2` es un ZIP (`src/imaging/zip.js`, lector sin dependencias). Se valida la firma `PK` y la extensión.
2. `Images/Main/IR.data` contiene **320 × 241 valores `uint16` little-endian**; la primera fila (640 bytes) es cabecera y se saltea → 320 × 240 píxeles de **cuentas crudas** (`src/imaging/is2.js`).
3. Sólo se lee la matriz IR: nunca las fotos visibles (`Images/Main/*.jpg`) ni la miniatura `Thumbnails/014000F0.jpg`, que tiene impresos fecha, hora y emisividad.
4. **Vista previa**: rango calibrado contra la miniatura de la cámara (percentiles como respaldo), paleta Fluke High Contrast (o Ironbow / Grises con `?paleta=`), ampliación bicúbica y barra de color (`renderThermogram`). Se usa en `POST /medico/estudios/vista-previa` (asistente) y en `/media/estudios/:id/:slot?vista=png`.
5. **ROIs aproximadas** (`analyzeThermogram`): umbral de Otsu + componentes conexas para separar ambos pies (el pie izquierdo del paciente aparece a la izquierda de la imagen, convención validada contra las mediciones del equipo), bandas por longitud del pie (dedos 0–20 %, metatarso 20–42 %, arco 42–70 %, talón 70–100 %) y división medial/lateral.
6. **Cuentas → °C**: `T ≈ −32,97 + 0,012978 · cuentas`, ajuste lineal entre cuentas medias por ROI y las temperaturas medidas por el equipo con el software del fabricante (34 termogramas, r = 0,88). Es una aproximación: la conversión exacta usa la calibración radiométrica de la cámara (`CalibrationData.gpbenc`), pendiente de implementar.

Cuando se suben archivos **IS2**, la estrategia por defecto `puntual-v1` los analiza punto a punto (segmentación, espejado, registro afín y mapa ΔT; ver [arquitectura §8](arquitectura.md#8-análisis-punto-a-punto-parte-2)). Con JPG/PNG, que no son radiométricos, se usa el predictor simulado y el resultado lo indica.

### Imágenes demo a partir de termogramas reales

`npm run generate:images` lee los pares desde `scripts/demo-pairs.local.json` (privado, excluido de git: contiene las rutas reales dentro de `tesis-2026info/`, también excluida de git y de Vercel; el versionado `scripts/demo-pairs.json` sólo lista `par-NN` y los días aproximados entre tomas) y genera `public/demo/par-NN-toma{1,2}.png` en High Contrast más las variantes `-ironbow` y `-grises` (800 × 600, sin metadatos) y `src/seed/demoImages.json` (temperaturas por ROI estimadas de cada imagen, que la semilla usa para que los valores sean coherentes con lo que se ve).

**Emparejamiento toma 1 / toma 2**: por código de paciente (`P.HC0xx` en la primera toma ↔ carpeta `2PHC.0xx` de la segunda) y verificado con la fecha de captura de cada IS2 (entre 28 y 41 días entre tomas en los 10 pares elegidos; se descartaron los pares con el reloj de la cámara desfasado, las carpetas con imágenes duplicadas y las identificadas sólo por nombre). Se eligieron imágenes con ambos pies completos y buen contraste. Los datos clínicos de la demo son ficticios y no corresponden a esos códigos.

## 7. Seguridad operativa

- Nunca exponer `SUPABASE_SERVICE_ROLE_KEY` al navegador ni subir `.env` al repositorio (está en `.gitignore`).
- Rotar `SESSION_SECRET` invalida todas las sesiones.
- Con datos reales: `SHOW_DEMO_ACCOUNTS=false`, eliminar los usuarios demo (Authentication → Users en el panel de Supabase; las fichas asociadas deben borrarse antes por la restricción de clave foránea del médico) y definir las políticas de retención.

## 8. Datos reales en producción

La producción (Vercel + Supabase) tiene los mismos pacientes reales que la carga local `SEED=real`; sólo la usa el equipo. Los datos reales **nunca** pasan por git ni por el paquete de Vercel: van del disco local (`data-local/`) directo a Postgres y a Storage privado.

1. Respaldo previo: exportación JSON de todas las tablas y de los usuarios de Auth con la service role, en `data-local/backups/`.
2. Migración `20260101000900_datos_reales.sql` (`supabase db push`): admite datos clínicos y de ambiente faltantes (no se inventan), guarda «neuropatía sin dato», admite estudios con una sola toma y crea el bucket privado `modelos`.
3. Carga (idempotente; primero `--dry-run`, que simula todo en memoria e informa tamaños):

   ```bash
   node scripts/seed-supabase-real.js --dry-run --models
   node scripts/seed-supabase-real.js --models --purge-demo --rotate-staff=.credenciales-produccion.local
   ```

   - `--models`: sube los modelos de `data-local/` al bucket `modelos` (pronóstico por zona, CNN de neuropatía, atlas de angiosomas, referencia del TCI y, si existe, el modelo de desenlace).
   - `--purge-demo`: borra los pacientes `DEMO-…`, sus imágenes y las cuentas demo de pacientes y de `medico2@demo.com`.
   - `--rotate-staff=<archivo>`: contraseñas aleatorias nuevas para `medico@demo.com` y `admin@demo.com`, escritas sólo en ese archivo (ignorado por git y por Vercel).
   - Pacientes: fichas, estudios y análisis punto a punto (segmentación U-Net precalculada, TCI, riesgo a 12 meses, alertas) calculados con el mismo predictor que la carga local. Imágenes en `estudios/<patient_id>/<study_id>/<toma>.png`, servidas sólo con URLs firmadas a través de `/media`.
   - Los pacientes **no** tienen acceso al portal: el perfil (necesario para que el equipo vea nombre y teléfono) usa un correo no entregable `<código>@sin-acceso.invalid`, una contraseña aleatoria que no se guarda, la identidad de Auth bloqueada y el perfil desactivado.
   - Excluye a los pacientes sin consentimiento (`src/utils/consent.js`).
4. Modelos en el arranque en frío: con `DATA_DRIVER=supabase`, `api/index.js` descarga el bucket `modelos` a `/tmp` y define `PRONOSTICO_MODELO`, `RIESGO_FACTOR_MODELO`, `ANGIOSOME_ATLAS`, `OUTCOME_MODEL` y `TCI_REFERENCE_DIR` antes de cargar la app (`src/config/remoteModels.js`). `MODELS_BUCKET=none` lo desactiva.
5. Variables de Vercel: además de las de Supabase, `SHOW_DEMO_ACCOUNTS=false` (no mostrar las cuentas demo en el ingreso).

Qué queda distinto de local:

- La herramienta de corrección de máscaras (`/mascaras`) está deshabilitada: depende de las matrices de `data-local/ml/` (cientos de MB) y sólo tiene sentido en local.
- Los desenlaces registrados se guardan en la ficha del paciente en Postgres (no en `data-local/outcomes/`).
- Los estudios nuevos usan la segmentación clásica, igual que en local; la U-Net sólo está precalculada para la cohorte.
- Visor: `scripts/upload-visor-real.js` sube al bucket privado `estudios` las matrices de cada réplica (`termica/…`), las fotos visibles re-codificadas sin metadatos (`visible/…`) y el manifiesto `visor.json` con la calidad automática de cada réplica (incluida la marca «en el promedio»). Se sirven sólo por las rutas autenticadas del visor.

### Actualizar los datos ya cargados (p. ej. promedio de réplicas)

Cuando cambia el precálculo (`data-local/real-v3`: promedio de réplicas, §8.14 de arquitectura; etiqueta de los «NO VALIDO», §8.15):

1. Respaldo de todas las tablas y usuarios en `data-local/backups/`.
2. Migraciones pendientes (`supabase db push`; p. ej. `20260101001000_revision_imagenes.sql`, revisión manual de las fotos).
3. Recalcular los estudios existentes con las grillas nuevas (idempotente; primero `--dry-run`, que lee la base pero no escribe):

   ```bash
   REAL_DATA_DIR=data-local/real-v3 node scripts/seed-supabase-real.js --actualizar --dry-run
   REAL_DATA_DIR=data-local/real-v3 node scripts/seed-supabase-real.js --actualizar
   REAL_DATA_DIR=data-local/real-v3 node scripts/upload-visor-real.js --dry-run
   REAL_DATA_DIR=data-local/real-v3 node scripts/upload-visor-real.js
   ```

   `--actualizar` reemplaza el análisis de cada estudio (configuración vigente), vuelve a subir la imagen de cada toma y quita la marca automática «no válido» que la carga anterior ponía a los marcados en la planilla; no toca fichas, consentimientos, revisiones de fotos ni invalidaciones cargadas a mano.

