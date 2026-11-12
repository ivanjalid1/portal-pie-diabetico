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
| `PREDICTOR` | `mock` | Estrategia de predicción: `mock`, `logreg`, `cnn`. |
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

Cuando se suben **ambas tomas en IS2**, el predictor `mock-v0` usa estas temperaturas reales por ROI (`fuente_rois = 'is2'`); la probabilidad sigue siendo simulada.

### Imágenes demo a partir de termogramas reales

`npm run generate:images` lee los pares desde `scripts/demo-pairs.local.json` (privado, excluido de git: contiene las rutas reales dentro de `tesis-2026info/`, también excluida de git y de Vercel; el versionado `scripts/demo-pairs.json` sólo lista `par-NN` y los días aproximados entre tomas) y genera `public/demo/par-NN-toma{1,2}.png` en High Contrast más las variantes `-ironbow` y `-grises` (800 × 600, sin metadatos) y `src/seed/demoImages.json` (temperaturas por ROI estimadas de cada imagen, que la semilla usa para que los valores sean coherentes con lo que se ve).

**Emparejamiento toma 1 / toma 2**: por código de paciente (`P.HC0xx` en la primera toma ↔ carpeta `2PHC.0xx` de la segunda) y verificado con la fecha de captura de cada IS2 (entre 28 y 41 días entre tomas en los 10 pares elegidos; se descartaron los pares con el reloj de la cámara desfasado, las carpetas con imágenes duplicadas y las identificadas sólo por nombre). Se eligieron imágenes con ambos pies completos y buen contraste. Los datos clínicos de la demo son ficticios y no corresponden a esos códigos.

## 7. Seguridad operativa

- Nunca exponer `SUPABASE_SERVICE_ROLE_KEY` al navegador ni subir `.env` al repositorio (está en `.gitignore`).
- Rotar `SESSION_SECRET` invalida todas las sesiones.
- Con datos reales: `SHOW_DEMO_ACCOUNTS=false`, eliminar los usuarios demo (Authentication → Users en el panel de Supabase; las fichas asociadas deben borrarse antes por la restricción de clave foránea del médico) y definir las políticas de retención.
