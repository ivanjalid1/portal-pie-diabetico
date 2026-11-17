# Arquitectura

Este documento describe la arquitectura del portal TermoPie, las decisiones de diseño y los patrones utilizados, indicando **dónde** se aplica cada uno en el código.

## 1. Vista general

El sistema es una aplicación web monolítica **server-side rendered** (Express 5 + EJS) organizada en capas, desplegable como función serverless en Vercel. La persistencia es intercambiable: en memoria (demostración) o Supabase (Postgres + Auth + Storage).

```mermaid
flowchart LR
  subgraph Cliente
    B[Navegador<br/>HTML + CSS + JS mínimo]
  end
  subgraph Vercel["Vercel (función Node 24)"]
    MW[Cadena de middlewares<br/>helmet · sesión · CSRF · auth · RBAC · validación]
    C[Controladores MVC]
    S[Servicios / casos de uso]
    P[Predictor<br/>Strategy]
    E[Bus de eventos<br/>Observer]
    R[Repositorios<br/>contratos]
  end
  subgraph Datos
    M[(Driver memory)]
    SB[(Supabase<br/>Postgres + RLS)]
    ST[(Supabase Storage<br/>bucket privado)]
    AU[Supabase Auth]
  end
  B -- HTTP / formularios --> MW --> C --> S
  S --> P
  S --> E --> AUD[AuditService]
  S --> R
  R -- DATA_DRIVER=memory --> M
  R -- DATA_DRIVER=supabase --> SB
  R --> ST
  S -. AuthProvider .-> AU
```

### Capas

| Capa | Carpeta | Responsabilidad |
| --- | --- | --- |
| Presentación (Vista) | `src/views`, `public/` | Plantillas EJS por rol, sistema de diseño en un único CSS, JS de mejora progresiva. |
| Presentación (Controlador) | `src/controllers`, `src/routes` | Traducir HTTP ↔ casos de uso. Sin reglas de negocio. |
| Middlewares | `src/middlewares` | Seguridad, sesión, autorización, validación, errores, layout. |
| Aplicación (Servicios) | `src/services` | Casos de uso: registrar paciente, crear estudio + análisis, publicar, etc. |
| Dominio | `src/models`, `src/config/domain.js` | Entidades, reglas derivadas (edad, grado de neuropatía, grupo térmico) y constantes del protocolo. |
| Infraestructura | `src/repositories`, `src/config/supabase.js`, `src/services/auth/*Provider.js` | Persistencia, almacenamiento de archivos y proveedores de identidad. |
| Procesamiento de imágenes | `src/imaging` | Lectura de IS2 (ZIP + matriz IR 320×240), segmentación de ambos pies, ROIs aproximadas, conversión cuentas→°C y renderizado ironbow (vistas previas). |

## 2. Patrones de diseño

| Patrón | Dónde | Para qué |
| --- | --- | --- |
| **MVC** | `controllers/`, `views/`, `models/` | Separar presentación, control y dominio. |
| **Repository** | `repositories/contracts.js` (interfaces), `repositories/memory`, `repositories/supabase` | Aislar a los servicios de la tecnología de persistencia. |
| **Factory** | `repositories/RepositoryFactory.js` (`DATA_DRIVER`), `services/predictors/PredictorFactory.js` (`PREDICTOR`) | Elegir implementaciones concretas por configuración. |
| **Strategy** | `services/predictors/UlcerPredictor.js` → `PointwisePredictor` (por defecto, análisis punto a punto + modelo preliminar), `MockUlcerPredictor` (respaldo para imágenes no radiométricas), `LogisticRegressionPredictor`, `CnnPredictor`; `services/auth/AuthProvider.js` → `PasswordAuthProvider`, `SupabaseAuthProvider`, `GoogleOAuthProvider` | Intercambiar el algoritmo de predicción y el mecanismo de autenticación sin tocar los casos de uso. |
| **Singleton** | `config/index.js` (`getConfig`), `config/supabase.js` (`getSupabaseClients`) | Una sola configuración inmutable y un único cliente de base de datos por proceso. |
| **Chain of Responsibility** | `app.js` (cadena global) y `routes/index.js` (`requireAuth → requireRole → multer → verifyCsrf → validate → controlador`) | Cada eslabón decide si corta (redirección, 403, error de validación) o delega. |
| **Observer** | `utils/eventBus.js` (`DomainEventBus`), `services/AuditService.js` | Los servicios publican eventos (`patient.created`, `analysis.completed`, …) y la auditoría se suscribe sin acoplamiento. |
| **DTO / Mapper** | `models/PatientView.js`, `repositories/supabase/mappers.js`, `utils/csv.js` | Combinar ficha clínica + perfil sólo para presentación; mapear camelCase ↔ snake_case; exportar CSV anonimizado. |
| **Service Layer** | `services/*Service.js` | Orquestar casos de uso y reglas (exclusión, consentimiento, pertenencia de objetos). |
| **Inyección de dependencias** | `container.js` (raíz de composición) | Único lugar donde se instancian clases concretas; los tests pueden reemplazar piezas. |

### Principios SOLID aplicados

- **S**: cada servicio cubre un agregado (pacientes, estudios, controles, auditoría).
- **O**: nuevos predictores, proveedores de identidad o suscriptores de eventos se agregan sin modificar los servicios.
- **L**: cualquier implementación de un contrato de repositorio funciona en su lugar (las pruebas e2e ejecutan los mismos flujos con Supabase).
- **I**: contratos pequeños por agregado (`StudyRepository`, `ConsentRepository`, `FileStorage`, …).
- **D**: los servicios dependen de abstracciones inyectadas, nunca de `@supabase/supabase-js` directamente.

## 3. Diagrama de clases (núcleo)

```mermaid
classDiagram
  direction LR
  class UlcerPredictor {
    <<interface>>
    +info
    +predict(input) PredictionOutput
  }
  class PointwisePredictor {
    -model: pointwise-logreg.json
    +predict(input)
  }
  UlcerPredictor <|.. PointwisePredictor
  class MockUlcerPredictor {
    -umbral: number
    +predict(input)
  }
  class LogisticRegressionPredictor
  class CnnPredictor
  UlcerPredictor <|.. MockUlcerPredictor
  UlcerPredictor <|.. LogisticRegressionPredictor
  UlcerPredictor <|.. CnnPredictor

  class AuthProvider {
    <<interface>>
    +authenticate(email, password) userId
    +createIdentity(email, password)
    +updatePassword(userId, password)
  }
  AuthProvider <|.. PasswordAuthProvider
  AuthProvider <|.. SupabaseAuthProvider
  AuthProvider <|.. GoogleOAuthProvider

  class PatientRepository {
    <<interface>>
    +findById(id)
    +listByMedico(medicoId)
    +create(patient)
    +update(id, patch)
  }
  PatientRepository <|.. MemoryPatientRepository
  PatientRepository <|.. SupabasePatientRepository

  class StudyService {
    +createWithAnalysis()
    +setPublished()
    +getImageAccess()
  }
  class AnalysisService {
    +run(study, patient, images)
  }
  class PatientService {
    +register()
    +listForMedico()
    +recordOutcome()
    +registerConsent()
    +revokeConsent()
    +exportRows()
  }
  class DomainEventBus {
    +publish(event, payload)
  }
  class AuditService {
    +subscribe()
    +record(action, payload)
  }
  StudyService --> AnalysisService
  StudyService --> PatientService
  AnalysisService --> UlcerPredictor
  PatientService --> PatientRepository
  PatientService --> DomainEventBus
  StudyService --> DomainEventBus
  DomainEventBus --> AuditService : notifica
  class Patient {
    codigo
    +edad()
    +gradoNeuropatia()
    +hba1cAlerta()
  }
  class PatientView {
    nombre
    apellido
    email
  }
  Patient <|-- PatientView
```

## 4. Diagrama de secuencia: carga de estudio y análisis

```mermaid
sequenceDiagram
  autonumber
  actor M as Médico/a
  participant R as Router (cadena)
  participant C as MedicoController
  participant S as StudyService
  participant PS as PatientService
  participant FS as FileStorage
  participant A as AnalysisService
  participant P as UlcerPredictor (puntual-v1)
  participant EV as DomainEventBus
  participant AU as AuditService

  M->>R: POST /medico/estudios (multipart: termografía toma 1 + toma 2)
  R->>R: requireAuth → requireRole(medico) → multer → verifyCsrf → validate(studySchema)
  R->>C: createStudy(req.validated, files)
  C->>S: createWithAnalysis(patientId, adquisición, archivos)
  S->>PS: getForMedico(patientId) (pertenencia + consentimiento)
  S->>S: validateStudyImages (firma binaria JPG/PNG/TIFF/IS2)
  S->>FS: save(patientId/studyId/slot.ext) ×2
  S->>EV: publish(study.created)
  EV-->>AU: record()
  S->>A: run(study, patient, images)
  A->>P: predict()
  P-->>A: grillas canónicas, mapa ΔT, métricas por toma, cambio T2−T1, zonas no analizadas, probabilidad preliminar, ROIs de referencia
  A->>EV: publish(analysis.completed)
  A-->>S: AnalysisResult
  S-->>C: estudio analizado
  C-->>M: 303 → /medico/estudios/:id (resultado)
```

## 5. Diagrama de componentes y despliegue

```mermaid
flowchart TB
  subgraph Navegador
    UI[Vistas EJS renderizadas<br/>app.css · app.js · wizard.js · theme.js<br/>gráficos SVG del servidor]
  end
  subgraph Vercel
    F[api/index.js<br/>createApp]
    subgraph App
      RT[routes] --> CT[controllers] --> SV[services]
      SV --> RP[repositories]
      SV --> PR[predictors]
      SV --> EB[eventBus]
    end
    F --> App
  end
  subgraph Supabase
    PG[(Postgres<br/>tablas + RLS)]
    AUTH[Auth / GoTrue]
    STO[(Storage<br/>bucket «estudios»)]
  end
  CDN[Google Fonts]
  UI <--> F
  UI --> CDN
  RP --> PG
  RP --> STO
  SV --> AUTH
  UI -. URL firmada 120 s .-> STO
```

## 5.1 Visualización de datos

Los gráficos del análisis punto a punto se dibujan en **canvas** en el navegador (`public/js/pointwise.js`). Lee las grillas desde un `<script type="application/json">`, que no se ejecuta y respeta la CSP `script-src 'self'`. Los gráficos de resumen se generan como **SVG en el servidor** (`pw-evolution`, `sparkline`, `gauge`, `plantar-map`). No se usa ninguna librería de gráficos.

- **Mapas por toma:** pie izquierdo y derecho con escala de temperatura común (High Contrast), y mapa **ΔT izq. − der.** con escala divergente azul–blanco–rojo fija en ±3 °C, contorno de \|ΔT\| > umbral, guías de zona, marca del punto de mayor diferencia y gris para las celdas sin par.
- **Histograma** de \|ΔT\| por punto (paso 0,2 °C), con la línea del umbral; las barras sobre el umbral van en rojo.
- **Cambio toma 1 → toma 2** por pie (T2 − T1), con el color centrado en el cambio mediano y el valor de esa mediana informado.
- **Ficha del paciente:** evolución del % de área caliente por toma (eje izquierdo) y de la probabilidad preliminar (eje derecho, línea discontinua y marcadores distintos), con la línea del área mínima. Al lado, los mapas ΔT del último estudio.
- Se eliminaron el bloque «Evolución entre tomas» (dumbbell por región, pendiente del \|ΔT\| máximo, «Toma 1: con asimetría → Toma 2…») y el bloque «Visibilidad para el paciente». El resumen en lenguaje simple queda visible para el paciente al terminar el análisis.
- **Colores de serie:** toma 1 `#7b6cf6`, toma 2 `#0a94a8`. Cada gráfico tiene `aria-label` o `<title>` en español.

### Paleta térmica Fluke High Contrast

La paleta por defecto reproduce la «High Contrast» de la cámara Fluke. La LUT de 256 colores (`src/config/palettes/high-contrast.json`) se **derivó empíricamente** de la barra de color que la cámara incrusta en la miniatura JPEG de cada `.IS2` (columna x 313–317, de y = 26 a y = 181): mediana de 52 miniaturas, mediana móvil de 5 filas y suavizado gaussiano. Se validó con ΔE76 contra la propia imagen de la miniatura, modelando la fusión IR-visible de la cámara (α ≈ 0,75; mediana ≈ 10). El rango de cada imagen se calibra contra su miniatura (`src/imaging/flukeCalibration.js`) con un percentil como respaldo. Las miniaturas nunca se publican. El visor permite alternar **High Contrast / Ironbow / Grises** (variantes pre-renderizadas para las imágenes demo; render al vuelo para IS2) y muestra la escala en °C.

### Identidad

El logo (`public/img/logo.svg`) muestra dos plantas sobre un mosaico verde azulado: la izquierda fría y la derecha cálida, que representan la asimetría térmica que mide el estudio. Se eligió entre tres variantes (`docs/screenshots/logo-variantes.png`) por legibilidad a 16 px y por no depender del color para leerse. Se generan `favicon.svg`, `favicon.ico` (16 + 32), `apple-touch-icon.png` (180), íconos 192/512 y maskable para el `manifest.webmanifest`.

## 6. Seguridad

- **Sesión**: cookie firmada `httpOnly`, `SameSite=Lax`, `Secure` en producción, 8 h; el contenido se reemplaza completo al iniciar sesión (sin fijación de sesión). Apta para serverless (sin almacenamiento de sesión en servidor).
- **CSRF**: token sincronizado por sesión en todos los formularios; para `multipart` se verifica después de `multer`.
- **Cabeceras**: `helmet` con CSP estricta (`script-src 'self'`, sin scripts en línea ni CDN de scripts), `frame-ancestors 'none'`, `nosniff`.
- **Fuerza bruta**: `express-rate-limit` en `POST /login`; mensajes de error genéricos y hash constante para usuarios inexistentes (evita enumeración por tiempo).
- **Validación**: Zod en todos los formularios; imágenes validadas por **firma binaria**, no por extensión; tamaño máximo configurable.
- **Autorización**: RBAC por rol + control a nivel de objeto en servicios (un médico sólo ve sus pacientes; un paciente sólo lo suyo; el administrador no ve datos clínicos). En Supabase, además, **RLS** por rol.
- **Archivos**: bucket privado; el servidor entrega URLs firmadas de corta duración tras verificar permisos.
- **Contraseñas**: bcrypt (driver memory) o Supabase Auth; contraseñas temporales con cambio obligatorio en el primer ingreso.
- **Auditoría**: todos los eventos relevantes quedan registrados con actor, entidad, detalle e IP.

## 7. Decisiones y alternativas

| Decisión | Alternativa descartada | Motivo |
| --- | --- | --- |
| SSR con EJS y JS mínimo | SPA (React) | Menor complejidad, mejor accesibilidad base, despliegue serverless simple. |
| Cookie firmada | Sesiones en Redis/DB | Vercel no garantiza estado entre invocaciones. |
| Service-role en servidor + RLS como defensa en profundidad | Cliente con anon key + JWT por usuario | El control fino ya está en los servicios; RLS protege ante una fuga de la anon key o futuros clientes directos. |
| Driver `memory` por defecto | Base de datos obligatoria | Permite demostrar el producto sin infraestructura. |
| Ficha clínica seudonimizada (`codigo`) separada del perfil | Una sola tabla de pacientes | Minimización de datos (Ley 25.326) y exportaciones anonimizadas. |

## 8. Análisis punto a punto (Parte 2)

El análisis principal del portal compara los pies **punto a punto (píxel a píxel)**. Las 6 regiones por pie de la Parte 1 se siguen calculando, pero sólo como **referencia secundaria**. Se obtienen de la misma grilla registrada y se muestran plegadas en «Referencia: análisis por regiones (tesis parte 1)».

| Paso | Módulo | Detalle |
| --- | --- | --- |
| 1. Lectura | `src/imaging/is2.js` | Matriz `Images/Main/IR.data` del `.IS2` (320 × 240 cuentas, la primera fila es cabecera). Nunca se usan las fotos visibles. |
| 2. Cuentas → °C | `src/imaging/thermogram.js` (`toCelsius`) | Ajuste lineal aproximado (r ≈ 0,88). No es una calibración radiométrica: las temperaturas son **aproximadas** y las diferencias entre pies son más confiables que los valores absolutos. |
| 3. Segmentación | `scripts/ml/` (U-Net, §8.3) y `src/imaging/segmentation.js` (clásica) | Si existe la máscara de la **U-Net** (precálculo local) se usa esa; si no, o si no es plausible, la clásica. Clásica: suavizado 3×3 y umbral de Otsu. Si más del 40 % del cuadro queda tibio, se repite Otsu sobre esa parte. Semillas en el núcleo caliente de cada pie; para un pie mucho más frío, la semilla se busca en su mitad de la imagen con un umbral propio. Luego viene un **crecimiento de regiones competitivo** (inundación desde lo más caliente): un punto se agrega si el descenso respecto del vecino es < 0,25 °C y está a menos de 40 px de la semilla. Así los dedos fríos se incluyen y la tela o la pierna, separadas por un salto brusco, no. Termina con apertura morfológica, relleno de huecos y componente mayor. |
| 4. Espejado | `src/imaging/pointwise.js` | Convención del equipo: el pie a la izquierda de la imagen es el izquierdo. El derecho se espeja (x → W − 1 − x) para que ambos tengan el lado medial hacia +x. |
| 5. Registro | `footFrame` / `lengthFrames` | Registro **afín** a un marco canónico por pie: **centroide + eje principal** (momentos de segundo orden) + **escala anisótropa** (largo por percentiles 0,5–99,5 % sobre el eje; ancho medido en el antepié). Se hace en dos pasadas: la segunda descarta los puntos fuera del ancho del antepié, como una cuña de pierna junto al talón, antes de recalcular el eje. No se deforma el pie (no es un registro elástico). |
| 6. Grilla canónica | `sampleCanonical` | 40 × 100 celdas por pie, con remuestreo bilineal. La fila 0 es la punta de los dedos y la última el talón; la columna 0 es el borde lateral. Se descarta 1 px de contorno (mezcla piel/fondo). Fuera de la máscara la celda queda **sin dato** (NaN). |
| 7. Mapa ΔT | `asymmetryMetrics` | **ΔT = T(izquierdo) − T(derecho espejado)** en las celdas con dato en ambos pies. Positivo: el pie izquierdo está más caliente. Métricas: % del área con \|ΔT\| > umbral por punto; \|ΔT\| medio, p95 y máximo (este último sobre el mapa suavizado 3×3 para no reaccionar a un píxel aislado); media con signo; ubicación del punto de mayor diferencia (zona, lado medial/lateral y pie más caliente). |
| 8. Cambio entre tomas | `changeMetrics` | Cada pie de la toma 2 cae en la misma grilla canónica que el de la toma 1, así que el mapa **T2 − T1** se compara celda a celda. Se informa el cambio mediano (refleja sobre todo el ambiente y el día), el p95 y el % de «cambio local»: puntos que se apartan de la mediana más que el umbral configurable. En pantalla, el color se centra en la mediana de cada pie; los valores no se alteran. |
| 9. Zonas no analizadas | `zoneCoverage` | Si un pie toca el borde de la imagen (dedos o talón fuera del cuadro) o es más de un 12 % más corto que el otro, se ancla en su extremo íntegro y se usa la longitud esperada. La parte faltante queda sin dato. Una zona (dedos 0–20 %, metatarso 20–42 %, arco 42–70 %, talón 70–100 % del largo) con menos del 50 % de celdas comparables se **excluye de las métricas** y se informa: «En este estudio no se analizó: dedos. Se analizó: metatarso, arco y talón». |

Reglas que no se negocian: **no se usa IA generativa ni *inpainting*** y **nunca se modifican ni completan temperaturas**. Sólo se recorta, centra y alinea para mostrar, y las zonas sin dato se pintan en gris.

Parámetros (Configuración → «Análisis punto a punto», con vista previa del efecto):

- umbral por punto, 1,0 °C;
- área mínima para marcar «con asimetría punto a punto», 10 %;
- cambio local relevante entre tomas, 1,0 °C.

Los 10 % se calibraron con la toma 1 de los 54 pacientes de la hoja «DifT°» de la Parte 1. Con ese valor se marcan 27 tomas (la Parte 1 clasificó 26 como P) y la clasificación coincide en 43 de 54. Como las grillas se guardan en cada análisis, cambiar un parámetro y recalcular **no vuelve a procesar las imágenes**.

**Concordancia con la Parte 1.** El ΔT general por regiones calculado sobre la grilla tiene r = 0,84 con la planilla del equipo (54 pacientes, toma 1), con una diferencia mediana de 0,09 °C (con la segmentación clásica: r = 0,83). El script de entrenamiento lo vuelve a calcular.

### 8.1 Modelo preliminar

`PointwisePredictor` (`puntual-v1`) es la estrategia por defecto (`PREDICTOR=puntual`) detrás de la interfaz `UlcerPredictor`. `MockUlcerPredictor` queda como respaldo sólo cuando se suben imágenes no radiométricas (JPG/PNG), y el resultado se rotula «simulado».

- **Variables:** % de área con \|ΔT\| > 1 °C, \|ΔT\| medio y \|ΔT\| p95 de la última toma, con el umbral fijo del modelo.
- **Ajuste:** regresión logística L2, C = 0,5 como en la Parte 1 (`src/services/predictors/logistic.js`).
- **Desenlace:** el mismo sustituto que la Parte 1, **HbA1c > 7 %**, porque en la cohorte casi no hubo úlceras registradas.
- **Muestra:** pacientes con HbA1c y toma 1 analizable. Se excluyen los marcados «PACIENTE NO VALIDO» en la planilla: **n = 53**, 35 positivos.
- **Validación** (reentrenado con la segmentación U-Net):
  - leave-one-out, con la estandarización dentro de cada pliegue: **AUC 0,02** (IC 95 % bootstrap 0–0,05);
  - 5 pliegues estratificados × 20 repeticiones: AUC medio 0,31;
  - AUC univariados 0,50–0,52;
  - con la segmentación clásica eran 0,27 (LOO) y 0,42 (5 × 20). La caída no indica un modelo «peor»: sin señal, la validación cruzada en muestras chicas tiene un sesgo negativo conocido, extremo en LOO;
  - comparación con los demás modelos en §8.5.
- **Conclusión:** con estos datos, **la asimetría punto a punto no predice el desenlace sustituto**. El AUC LOO menor a 0,5 es el sesgo conocido de LOO cuando no hay señal. Por eso:
  - la probabilidad se muestra rotulada «Modelo preliminar · no validado», con su AUC y su n, y sin zonas de riesgo;
  - mientras el AUC de validación sea < 0,7, la **categoría** (sin riesgo / moderado / alto) se toma del **hallazgo térmico** y no de la probabilidad: sin asimetría → sin riesgo; área ≥ mínima → moderado; además con \|ΔT\| p95 ≥ 2,2 °C → alto.
- **Archivos:** los coeficientes, medias, desvíos y métricas agregadas están en `src/config/models/pointwise-logreg.json`, sin datos por paciente. Se regeneran con `npm run train:model`.

**Limitaciones (a validar por el equipo):**

- La conversión a °C es aproximada.
- El registro es afín, sin correspondencia anatómica fina (dedos individuales).
- La segmentación puede incluir tela o pierna junto al talón, o perder dedos fríos; el resultado se marca «Segmentación a revisar» si la calidad es < 0,6. La U-Net (§8.3) reduce mucho estos casos, pero aprendió de etiquetas débiles y no de contornos manuales.
- Las zonas «no analizadas» pueden deberse a dedos fuera del cuadro o a dedos demasiado fríos para segmentarlos.
- Algunas cámaras tenían el reloj desconfigurado: esas fechas se estiman y se avisa en las notas.
- El desenlace es sustituto y el n es chico.

### 8.2 Datos reales sólo en local

```mermaid
flowchart LR
  P[tesis-2026info/<br/>IS2 + planilla<br/>no versionada] -->|npm run precompute:real| D[data-local/real/<br/>dataset.json + PNG<br/>ignorada por git y Vercel]
  D -->|npm run train:model| M[src/config/models/<br/>pointwise-logreg.json<br/>sólo agregados]
  D -->|SEED=real| S[seed/realData.js<br/>driver memory]
  S --> A[Portal en localhost]
```

- `scripts/precompute-real.js` procesa todas las réplicas `.IS2` de cada toma y elige la de mejor calidad: solapamiento y simetría de las máscaras, penalizando los cortes. Renderiza esa toma con High Contrast y guarda sus grillas en `data-local/real/`. No imprime nombres, DNI ni teléfonos.
- Los pacientes cuya fila de la planilla tiene la marca de que **no dieron su consentimiento** («sin consentimiento», «no firmó el consentimiento», incluso con errores de tipeo; regla genérica en `src/utils/consent.js`) se **excluyen por completo**: no se procesan sus tomas ni se generan imágenes, no entran al dataset ni al entrenamiento, y el cargador los vuelve a descartar por si acaso.
- Con `SEED=real` y esa carpeta presente, el contenedor carga los pacientes reales en el driver `memory`. Se conservan las cuentas del personal de demostración y se quitan los pacientes `DEMO-…`. Las imágenes se leen del disco al pedirlas (montaje de sólo lectura en el `FileStorage`), sin cargarlas en memoria.
- Sin la carpeta (CI, Vercel, pruebas), el portal usa la semilla de demostración. Sus grillas punto a punto están en `src/seed/demoPointwise.json`: termogramas ya anonimizados, sin datos de identidad.

### 8.3 Segmentación con U-Net (offline)

La segmentación clásica falla sobre todo por **dedos fríos que quedan afuera** y por **puentes de tela entre los talones**; las fugas de pierna más allá del talón son raras. Para eso se entrenó una U-Net chica, sólo en CPU.

| Paso | Script | Detalle |
| --- | --- | --- |
| Exportación | `scripts/ml/export-seg-data.js` (`npm run ml:export`) | Cada réplica IS2 de los pacientes con consentimiento → temperatura (`.npy`, 240 × 320) y máscara clásica. Clave = hash de la ruta (las carpetas pueden tener nombres). Todo en `data-local/ml/`. |
| Etiquetas débiles | `build_labels.py` | Máscara clásica + apertura 3 × 3, componente mayor y relleno de huecos; **prior de forma** en el talón (largo / ancho del antepié ≤ 3,4 y recorte lateral del último 30 % a más de 0,6 anchos del eje); **recuperación de dedos fríos** con Otsu local, sólo hacia los dedos y dentro del ancho del antepié. Subconjunto «limpio» para entrenar: calidad clásica ≥ 0,6, largo / ancho 2,1–3,4 por pie y áreas parecidas (484 de 606 imágenes). |
| Modelo | `train_unet.py` | U-Net de 4 niveles (16-32-64-128 canales, 0,48 M parámetros). Entrada: temperatura normalizada por imagen (percentiles 1–99), reducida a 120 × 160. Salida: 3 clases (fondo, pie a la izquierda, pie a la derecha). Pérdida: entropía cruzada + Dice. Aumento: espejado (intercambiando las clases), rotación ± 10°, escala ± 10 %, desplazamiento, contraste / brillo / gamma y ruido. 40 épocas, lotes de 8, 3 hilos. |
| División | | **Por paciente**: 20 % de los pacientes a validación (21 pacientes, 131 imágenes; 111 limpias). |
| Inferencia | `segment_unet.py` | Logits reescalados a 240 × 320, argmax, apertura, componente mayor y relleno por pie → `data-local/ml/unet-masks/`. Exportado también a ONNX (`data-local/models/unet-feet.onnx`, 1,9 MB). |
| Autocomprobación | `selfcheck.py` | Datos sintéticos: prior de forma, post-proceso, división por paciente, formas de la red y validación cruzada. |

Resultados (contra la etiqueta débil, pacientes de validación):

- imágenes limpias: **Dice 0,978**, IoU 0,958;
- todas las de validación: Dice 0,969, IoU 0,942.

Indicadores automáticos sobre las 606 réplicas (clásica → U-Net):

| Indicador | Todas | Marcadas «a revisar» (47) |
| --- | --- | --- |
| Puente entre pies (tela entre talones) | 67 → 16 | 12 → 7 |
| Pie incompleto (largo / ancho < 2,0) | 95 → 35 | 37 → 15 |
| Fuga en el talón (largo / ancho > 3,4) | 1 → 1 | 1 → 0 |

**Revisión visual** de 24 réplicas marcadas «a revisar»:

- la U-Net mejora 14, sobre todo pies fríos enteros y dedos;
- quedan parecidas 6;
- siguen mal 4: escenas atípicas, con objetos calientes en cuadro o pies superpuestos.

En el portal, las tomas con «Segmentación a revisar» bajaron de 10 a 3 (de 178). Los estudios con zonas no analizadas bajaron de 26 a 11.

`npm run precompute:real` usa las máscaras U-Net si existen (`SEGMENTACION=clasica` fuerza la clásica). Cada toma informa qué segmentación se usó, en «Detalle técnico».

**Decisión: la U-Net corre sólo offline.** Para estudios nuevos subidos al portal se mantiene la segmentación clásica, por dos motivos:

- `onnxruntime-node` agrega binarios nativos pesados a una aplicación que se despliega en Vercel;
- las etiquetas son débiles.

Todavía no se justifica. El ONNX queda listo para cuando se decida.

### 8.4 Índice de cambio térmico (TCI)

Definición publicada (Hernández-Contreras D., Peregrina-Barreto H., Rangel-Magdaleno J., González-Bernal J., Altamirano-Robles L. «A quantitative index for classification of plantar thermal changes in the diabetic foot». *Infrared Physics & Technology* 81 (2017) 242–249):

TCI = ( Σ_a | CG_a − DM_a | ) / 4, con a ∈ {MPA, LPA, MCA, LCA}

- CG_a: temperatura media del angiosoma a en el patrón de referencia (grupo control, «patrón mariposa»).
- DM_a: temperatura media del angiosoma a en el pie evaluado.
- Cada pie se compara con la referencia, no con el otro pie.
- Clases de la publicación: 1 (≤ 2), 2 (2–3), 3 (3–4), 4 (4–5), 5 (> 5).

**Incertidumbre.** No se pudo acceder al texto completo; la fórmula se verificó en trabajos que la citan. Algunos la reproducen sin valor absoluto. Aquí se usa el valor absoluto, como la mayoría, porque las clases suponen TCI ≥ 0. El TCI del estudio es el promedio de ambos pies; también se informa el de cada pie.

Implementación (`src/imaging/tci.js`), sobre la grilla canónica registrada:

- **Angiosomas aproximados** (no hay segmentación anatómica):
  - MPA = mitad medial de 0–70 % del largo;
  - LPA = mitad lateral de 0–70 %;
  - MCA / LCA = mitades medial / lateral del talón (70–100 %).
- **Versión punto a punto:** desvío por celda D = T(pie) − T(referencia). Es el mapa de la pestaña «TCI». También se calculan:
  - el TCI puntual: media de |D|;
  - el TCI de patrón: media de |D − mediana(D)|, sin el nivel general del pie.
- **Referencia** (`src/services/predictors/tciReference.js`): a falta de grupo control, los pacientes **más simétricos de la cohorte**. Criterio, toma 1:
  - no marcado «no válido» y calidad ≥ 0,6;
  - |ΔT general| < 1 °C en la planilla de la Parte 1;
  - área con |ΔT| > 1 °C menor al 10 %.

  Con la U-Net son **20 pacientes** (25 con la clásica). El criterio no usa el desenlace. Al puntuar a un miembro se lo **excluye de su propia referencia** (leave-one-out). Los miembros se guardan sólo en `data-local/real/tci-reference.json`. Sin esa carpeta (demo, CI) se usa una referencia de demostración con los pares demo.
- **Punto de extensión:** `REFERENCE_SOURCES.hernandez2019` reserva la base pública *Plantar Thermogram Database for the Study of Diabetic Foot Complications* (Hernández-Contreras et al., IEEE Access 2019). Para usarla hay que registrar los termogramas de su grupo control a la misma grilla canónica y pasarlos como miembros a `buildReference`. No se descargó.

**Limitación importante.** El TCI usa temperaturas **absolutas**, y la conversión cuentas → °C es aproximada. Además, las temperaturas dependen del ambiente, del día y del centro: un mismo paciente puede pasar de clase 3 en la toma 1 a clase 1 en la toma 2. Por eso el TCI absoluto mide en buena parte las condiciones de adquisición (ver §8.5).

### 8.5 Comparación de modelos

Script: `scripts/ml/train_models.py`. Las features salen de `scripts/ml/export-features.js`, que usa las mismas funciones que el portal.

- **Desenlace:** configurable con `--outcome`.
  - `hba1c7` (por defecto): HbA1c > 7 %, el sustituto de la Parte 1.
  - `lesion`: lesión en el seguimiento, que en el portal registra el médico como «Desenlace real». Hoy no tiene casos suficientes (0 utilizables en la muestra válida).
- **Muestra:** n = 53, 35 positivos. Cada paciente es una fila, así que los pliegues son por paciente.
- **Validación:**
  - logísticas: 5 pliegues estratificados × 20 repeticiones, con C elegido en un CV interno (anidado) y estandarización dentro de cada pliegue;
  - CNN: 5 × 4, con hiperparámetros fijados de antemano (2 bloques conv de 8–16 canales, dropout 0,5, weight decay 1e-3, aumento por intercambio de pies y desplazamientos);
  - AUC media de las repeticiones con IC 95 % por bootstrap de pacientes;
  - test de permutación (200) en las logísticas.
- **Backbone preentrenado:** no se probó. Habría que descargarlo, y con n = 53 no es razonable.

| Modelo | AUC (IC 95 %) | n (positivos) |
| --- | --- | --- |
| Logística actual: área, \|ΔT\| medio, \|ΔT\| p95 | 0,33 (0,26–0,39) | 53 (35) |
| Logística: TCI + área + \|ΔT\| p95 | 0,64 (0,48–0,79), p perm. 0,09 | 53 (35) |
| TCI solo (puntaje directo, mayor TCI = mayor riesgo) | 0,30 (0,15–0,45) | 53 (35) |
| Logística: TCI + área + p95 + cambio entre tomas | 0,53 (0,36–0,70) | 35 (23) |
| Logística actual, misma submuestra con toma 2 | 0,31 (0,21–0,41) | 35 (23) |
| CNN chica: ΔT + desvío TCI | 0,61 (0,45–0,77) | 53 (35) |
| CNN chica: sólo ΔT | 0,53 (0,43–0,63) | 53 (35) |
| *Control: sólo el centro de atención* | *0,64 (0,50–0,77)* | 53 (35) |

AUC univariadas:

- TCI de patrón 0,44; TCI puntual 0,30;
- área 0,50; \|ΔT\| medio 0,52; p95 0,51.

**Conclusión: nada supera el azar de forma convincente.**

- La regla de elección se fijó antes de mirar los resultados: IC 95 % con límite inferior > 0,5 y, entre esos, la mayor AUC. Ningún modelo la cumple.
- La logística con TCI llega a 0,64, pero:
  - el coeficiente del TCI es **negativo**: más TCI, menos riesgo, al revés de la hipótesis;
  - el centro de atención solo da la misma AUC, porque la prevalencia del desenlace y las condiciones de adquisición varían por centro;
  - la variante de patrón, sin el nivel absoluto, no tiene señal.

  Es una **confusión por centro / adquisición**, no un hallazgo fisiológico. El control por centro se agregó después de ver el primer resultado y se informa como tal.
- La CNN muestra el mismo patrón: con sólo ΔT queda en 0,53.
- El modelo actual queda **por debajo** del azar. No hay señal, y la validación cruzada en muestras chicas tiene un sesgo negativo conocido.

**Qué usa el portal.**

- Sigue el modelo logístico preliminar, rotulado «Modelo preliminar · no validado»; la categoría sale del hallazgo térmico.
- La regresión con TCI queda como estrategia opcional `TciPointwisePredictor` (`PREDICTOR=puntual-tci`, `src/config/models/pointwise-tci-logreg.json`).
- La tabla resumida, sólo con agregados, está en `src/config/models/model-comparison.json` y se muestra en «Detalle técnico».

**Pendientes para el equipo:**

- conseguir un desenlace real (lesión) con casos suficientes;
- contar con un grupo control propio, o con la base de 2019 como referencia;
- estandarizar la adquisición entre centros, o ajustar por centro;
- validar la U-Net contra contornos manuales en una muestra.
