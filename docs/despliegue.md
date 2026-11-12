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
| `IMAGE_SLOTS_PRESET` | `termica_visible` | Par de imágenes: `termica_visible` o `toma1_toma2`. |
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
4. Cargar la semilla demo (usuarios en Auth, datos y las imágenes sintéticas en Storage):

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
    // images: [{ slot: 'termografia' | 'visible', buffer, mime, originalName }]
    return { predictorVersion, rois, deltaTMax, deltaTMaxRoi, umbral, grupo, simetrico,
             probabilidad, categoria, horizonteSemanas: 6, factores, simulado: false };
  }
}
```

1. Implementar la clase (ya existen los esqueletos `LogisticRegressionPredictor` y `CnnPredictor` en `FuturePredictors.js`).
2. Registrarla en `PredictorFactory.js` y elegirla con `PREDICTOR=logreg`.
3. Usar `thermalGroup(rois, umbral)` y `categoryFor(probabilidad)` de `src/config/domain.js` para mantener las reglas comunes.

Si el procesamiento se hace en Python (OpenCV, scikit-learn, PyTorch), la estrategia puede llamar a un microservicio HTTP (`CNN_ENDPOINT_URL`) enviando las imágenes y recibiendo el mismo contrato de salida.

### Decodificación del archivo `.IS2` (Fluke)

El portal ya acepta `.IS2` (se valida que sea un contenedor ZIP con extensión `.is2`) y lo guarda tal cual. Para procesarlo:

1. Abrir el ZIP (p. ej. `adm-zip` en Node o `zipfile` en Python).
2. Leer `Images/Main/IR.data` (o ruta equivalente según el firmware): matriz de **320 × 241 valores `uint16`** little-endian; la última fila contiene metadatos y se descarta → 320 × 240 píxeles.
3. Convertir cuentas a temperatura con los parámetros de calibración del propio archivo (`CalibrationData`, emisividad, temperatura reflejada y transmisión registradas en los XML/INI del contenedor). Validar contra el valor que muestra Fluke SmartView para algunos píxeles.
4. Las imágenes visibles (`*.jpg`) del contenedor permiten la segmentación de los pies (IR-Fusion).
5. Con la matriz de temperaturas: segmentar ambos pies, ubicar las 6 ROIs por pie, calcular media/máximo/mínimo y ΔT, y aplicar el modelo.

## 7. Seguridad operativa

- Nunca exponer `SUPABASE_SERVICE_ROLE_KEY` al navegador ni subir `.env` al repositorio (está en `.gitignore`).
- Rotar `SESSION_SECRET` invalida todas las sesiones.
- Con datos reales: `SHOW_DEMO_ACCOUNTS=false`, eliminar los usuarios demo (Authentication → Users en el panel de Supabase; las fichas asociadas deben borrarse antes por la restricción de clave foránea del médico) y definir las políticas de retención.
- La estructura interna exacta del `.IS2` (nombres de archivo y calibración) debe verificarse con archivos reales de la cámara antes de implementar el decodificador.
