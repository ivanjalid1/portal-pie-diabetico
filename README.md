# TermoPie · Portal de termografía plantar

![Node](https://img.shields.io/badge/Node-24-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![EJS](https://img.shields.io/badge/Vistas-EJS-B4CA65)
![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%7C%20Auth%20%7C%20Storage-3ECF8E?logo=supabase&logoColor=white)
![Tests](https://img.shields.io/badge/tests-Jest%20%2B%20supertest-C21325?logo=jest&logoColor=white)
![Licencia](https://img.shields.io/badge/licencia-MIT-blue)

Portal médico–paciente para la **estimación del riesgo de úlcera de pie diabético a partir de termografía plantar**. Es la plataforma web del Proyecto Integrador de Ingeniería Biomédica (FCEFyN – Universidad Nacional de Córdoba):

> **«Procesamiento de imágenes y análisis punto a punto de termogramas plantares para la detección temprana del riesgo de pie diabético»**
> Alumna: María Inés Greising Revol · Asesor: Conrado J. Rodríguez · Co-asesoras: Dra. María Ranz y Álvarez, Dra. María Eugenia Lozano y Dra. Beatriz Alejandra García.
>
> Antecedente (Parte 1): «Correlación entre la termografía y la predicción de úlceras en pie diabético», Ana Paula Muñoz (FCEFyN – UNC).

> [!WARNING]
> **Herramienta exploratoria complementaria, no diagnóstica.** El análisis compara ambos pies **punto a punto**: segmentación, espejado del pie derecho, registro afín y mapa ΔT píxel a píxel (estrategia `puntual-v1`). Las temperaturas son aproximadas (conversión lineal de las cuentas de la cámara). La probabilidad proviene de un **modelo preliminar no validado**: regresión logística, desenlace sustituto HbA1c > 7 %, AUC de validación cruzada 0,27 con n = 53. Por eso la categoría de riesgo resume el hallazgo térmico y no esa probabilidad. Detalles y limitaciones en [docs/arquitectura.md §8](docs/arquitectura.md#8-análisis-punto-a-punto-parte-2).

## Capturas

| Ingreso | Tablero del médico |
| --- | --- |
| ![Ingreso](docs/screenshots/01-login.png) | ![Tablero](docs/screenshots/02-dashboard.png) |
| **Resultado punto a punto (mapas ΔT, histograma, cambio entre tomas)** | **Ficha del paciente: evolución punto a punto** |
| ![Resultado](docs/screenshots/04-resultado.png) | ![Evolución](docs/screenshots/05-paciente-evolucion.png) |
| **Estudios realizados** | **Controles** |
| ![Estudios](docs/screenshots/06-estudios-realizados.png) | ![Controles](docs/screenshots/07-controles.png) |
| **«Tu informe» (paciente)** | **Visor con paleta Fluke High Contrast** |
| ![Informe](docs/screenshots/08-paciente-informe.png) | ![Visor](docs/screenshots/10-visor-paletas.png) |
| **Asistente con vistas previas (PNG e IS2)** | **Tema oscuro (opcional)** |
| ![Asistente](docs/screenshots/03-wizard-previews.png) | ![Oscuro](docs/screenshots/09-resultado-dark.png) |

Paletas disponibles en el visor (High Contrast, Ironbow, Grises): [docs/screenshots/12-paletas-comparacion.png](docs/screenshots/12-paletas-comparacion.png).

| Móvil: ingreso | Móvil: tablero | Móvil: evolución | Móvil: informe del paciente |
| --- | --- | --- | --- |
| ![](docs/screenshots/01b-login-mobile.png) | ![](docs/screenshots/20-mobile-dashboard.png) | ![](docs/screenshots/25-mobile-evolucion.png) | ![](docs/screenshots/26-mobile-informe.png) |

## Funcionalidades

**Médico/a**
- Tablero con KPIs y tendencia frente al mes anterior (con *sparklines*), distribución de riesgo, controles vencidos y próximos, últimos estudios con miniatura y % de área con asimetría punto a punto, y los pacientes con mayor asimetría punto a punto.
- **Estudios realizados**: búsqueda por nombre, apellido o código, filtros (fechas, centro, riesgo, grupo por regiones, desenlace), columna de % de área con \|ΔT\| sobre el umbral y marca de «sin toma 2», orden, paginado, tarjetas en móvil y CSV del filtro actual.
- **Controles**: pestañas Próximos / Vencidos / Realizados, ausencia con motivo, marcado automático al guardar la toma 2, línea de tiempo en la ficha y CSV.
- Registro de pacientes por su **correo (Gmail)**: verifica criterios de exclusión y consentimiento, crea la cuenta con contraseña temporal (se muestra una sola vez) y asigna el **código anónimo** (`P.<centro><nnn>`, p. ej. `P.HC901`; los pacientes demo usan `DEMO-001` … `DEMO-012`).
- Ficha clínica completa (DM, HbA1c con alerta >12 meses o imputada, tabaquismo «a consultar», neuropatía con puntaje y grado, vibratoria 0–50 / «>50», antecedentes, hallazgos, campos futuros), con la evolución punto a punto: % de área con asimetría por toma y probabilidad preliminar, más los mapas ΔT del último estudio.
- **Asistente de estudio en 4 pasos** que sigue el protocolo: paciente, fechas de ambas tomas y consentimiento → condiciones ambientales (T 21–24 °C, HR 40–70 %, la humedad resaltada) y checklist de cámara → carga de **dos termografías: toma 1 (basal) y toma 2 (control ~30 días después)** (JPG/PNG/TIFF/IS2, arrastrar y soltar, vista previa; los IS2 de Fluke se previsualizan decodificando la matriz infrarroja en el servidor; la toma 1 puede reutilizarse de un estudio anterior) → análisis.
- Resultado **punto a punto**:
  - mapas de cada pie, mapa **ΔT izq. − der.** con contorno del umbral y punto de mayor diferencia;
  - histograma de \|ΔT\| por punto y métricas (% de área sobre el umbral, \|ΔT\| medio, p95 y máximo);
  - mapa de **cambio toma 1 → toma 2** por pie;
  - aviso de **zonas no analizadas** («En este estudio no se analizó: dedos…»);
  - estudios **sin toma 2**;
  - probabilidad del **modelo preliminar** con su AUC y n, y la ficha del modelo.
  - Las 6 regiones por pie de la Parte 1 quedan como **referencia plegada**.
- Notas, control a 6 semanas, **desenlace real** (¿generó lesión?, pie, ROI), informe imprimible («Guardar como PDF») y **exportación CSV** anonimizada con las columnas de la planilla del equipo.
- Gestión del **consentimiento informado** (historial, revocación).

**Paciente**: último resultado en lenguaje simple, estudios con imágenes (visor con paletas y escala en °C), **«Qué mostró tu estudio»** («X de cada 100 puntos de la planta con más de 1 °C de diferencia», zona con más diferencia, mapa simplificado y zonas no analizadas, descargable en PDF), sin métricas del modelo; **mis controles**, autocuidado, sus datos y su consentimiento.

**Administrador/a**: alta de médicos, activación/desactivación, restablecimiento de contraseñas, estadísticas del sistema y **auditoría**. Por diseño no accede a datos clínicos.

## Inicio rápido

```bash
npm install
npm run dev          # http://localhost:3000 (driver memory con datos demo)
```

### Datos reales (sólo en el equipo local)

Los pacientes reales **nunca se versionan ni se despliegan**. Requieren la carpeta privada `tesis-2026info/` (no versionada):

```bash
npm run precompute:real   # tesis-2026info/ → data-local/real/ (ignorada por git y Vercel)
npm run train:model       # reentrena el modelo preliminar (sólo guarda agregados)
DATA_DRIVER=memory SEED=real npm start   # en PowerShell: $env:DATA_DRIVER='memory'; $env:SEED='real'; npm start
```

Con `SEED=real` se cargan todos los pacientes de la planilla con sus tomas. Las cuentas del personal se mantienen (`medico@demo.com`) y los pacientes `DEMO-…` no se cargan. Cada paciente tiene una cuenta de portal local `<código>@pacientes.local` (p. ej. `phc001@pacientes.local`, contraseña `Demo1234!`). Si falta `data-local/real/`, se usan los datos de demostración.

### Segmentación U-Net, TCI y comparación de modelos (local, Python + PyTorch CPU)

```bash
py -3.13 -m venv data-local/venv-ml          # entorno ignorado por git
data-local/venv-ml/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
data-local/venv-ml/Scripts/python -m pip install numpy scipy scikit-learn pillow onnx onnxscript
npm run ml:export                             # IS2 → data-local/ml/cache
cd scripts/ml
../../data-local/venv-ml/Scripts/python selfcheck.py      # autocomprobación con datos sintéticos
../../data-local/venv-ml/Scripts/python build_labels.py   # etiquetas débiles mejoradas
../../data-local/venv-ml/Scripts/python train_unet.py 40  # U-Net (CPU) → data-local/models/ (+ ONNX)
../../data-local/venv-ml/Scripts/python segment_unet.py   # máscaras U-Net + métricas
cd ../.. && npm run precompute:real && npm run ml:features
cd scripts/ml && ../../data-local/venv-ml/Scripts/python train_models.py [--outcome hba1c7|lesion] [--export]
```

- **U-Net:** 4 niveles, entrenada con etiquetas débiles (segmentación clásica refinada) y división por paciente. En validación: Dice 0,98. Corre sólo offline; si no hay máscara U-Net, el portal usa la segmentación clásica.
- **TCI:** índice de cambio térmico de Hernández-Contreras et al. (2017), punto a punto sobre la grilla registrada, contra los pacientes más simétricos de la cohorte (con leave-one-out).
- **Modelos:** ningún modelo supera el azar de forma convincente, así que el portal mantiene el modelo preliminar «no validado».

Detalle en [docs/arquitectura.md §8.3–8.5](docs/arquitectura.md). Los pesos, máscaras y matrices quedan en `data-local/`; nunca se versionan.

### Cuentas demo (contraseña `Demo1234!`)

| Rol | Usuario |
| --- | --- |
| Médico/a | `medico@demo.com` (también `medico2@demo.com`) |
| Paciente | `paciente@demo.com` (y 11 pacientes `*.demo@gmail.com`, p. ej. `maria.gomez.demo@gmail.com`) |
| Administrador/a | `admin@demo.com` |

Los pacientes y datos clínicos de demostración son **ficticios**. Las termografías demo son **termogramas reales anonimizados** del estudio (usados con autorización del equipo): sólo la matriz infrarroja de las plantas, renderizada con la paleta **Fluke High Contrast** derivada empíricamente de la cámara (y variantes Ironbow y Grises), sin fotos visibles, texto ni metadatos (ver `scripts/generate-demo-images.js`).

El tema por defecto es **claro**; el oscuro se activa con el botón ☀/☾ y se recuerda en el navegador.

## Scripts

| Script | Descripción |
| --- | --- |
| `npm run dev` | Servidor con recarga (`node --watch`). |
| `npm start` | Servidor en modo normal. |
| `npm test` | Pruebas unitarias e integración (Jest + supertest). |
| `SUPABASE_E2E=1 npm test -- tests/supabase` | Pruebas de extremo a extremo contra un proyecto Supabase real. |
| `npm run lint` | ESLint. |
| `npm run format` / `format:check` | Prettier. |
| `npm run generate:images` | Regenera las termografías demo de `public/demo` a partir de los IS2 de la carpeta privada `tesis-2026info/` (no versionada). |
| `npm run precompute:real` | Análisis punto a punto de todos los pacientes reales (`tesis-2026info/` → `data-local/real/`, local). |
| `npm run train:model` | Entrena y valida (LOO y 5 pliegues ×20) el modelo preliminar; escribe `src/config/models/pointwise-logreg.json` (sólo agregados). |
| `npm run ml:export` | Exporta las réplicas IS2 reales a `data-local/ml/cache` (.npy) para la U-Net (local). |
| `npm run ml:features` | Exporta features y mapas registrados para comparar modelos (local). |
| `npm run generate:pointwise` | Regenera las grillas punto a punto de los pares demo (`src/seed/demoPointwise.json`). |
| `npm run seed:supabase` | Carga la semilla demo en Supabase (Auth + DB + Storage). Admite `-- --reset`. |

## Arquitectura en una línea

MVC sobre Express 5 + EJS, capa de servicios, **Repository + Factory** (`DATA_DRIVER=memory|supabase`), **Strategy** para el predictor y la autenticación, **Observer** para la auditoría, **Chain of Responsibility** en los middlewares y una raíz de composición para la inyección de dependencias. Ver:

- [docs/arquitectura.md](docs/arquitectura.md) – capas, patrones y diagramas.
- [docs/modelo-datos.md](docs/modelo-datos.md) – diagrama ER y diccionario de datos.
- [docs/casos-de-uso.md](docs/casos-de-uso.md) – actores, casos de uso e historias de usuario.
- [docs/requerimientos.md](docs/requerimientos.md) – requerimientos funcionales, no funcionales y marco legal (Leyes 25.326 y 26.529).
- [docs/despliegue.md](docs/despliegue.md) – Vercel, Supabase, variables de entorno y cómo conectar el algoritmo real.

## Estructura

```
api/index.js            Entrada serverless (Vercel)
server.js               Entrada local
src/
  app.js                Aplicación Express (middlewares globales)
  container.js          Raíz de composición (DI)
  config/               Configuración (Singleton), dominio, clientes Supabase
  models/               Entidades + DTO PatientView
  repositories/         Contratos, Factory, drivers memory/ y supabase/
  services/             Casos de uso, predictores (Strategy), auth (Strategy)
  controllers/          Controladores MVC
  middlewares/          Auth/RBAC, CSRF, validación, flash, errores, layout
  routes/               Rutas y cadenas de middlewares
  validators/           Esquemas Zod e imágenes (firma binaria)
  views/                Vistas EJS por rol
  seed/                 Datos demo (compartidos por ambos drivers)
  utils/                Eventos, formato, CSV, colores térmicos
public/                 CSS (sistema de diseño), JS, imágenes demo
supabase/               Migraciones (esquema, RLS, storage) y seed
tests/                  unit/, integration/, supabase/ (e2e opcional)
docs/                   Documentación técnica y capturas
```

## Licencia

[MIT](LICENSE) © 2026 Autores del Proyecto Integrador – FCEFyN UNC.
