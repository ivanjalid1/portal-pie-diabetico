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
> **Herramienta exploratoria complementaria, no diagnóstica.** El portal está completo salvo el procesamiento de imágenes: el análisis actual es **simulado** (`mock-v0`) y determinístico. El algoritmo real se conecta reemplazando una única estrategia (ver [docs/despliegue.md](docs/despliegue.md#conectar-el-algoritmo-real)).

## Capturas

| Landing | Resultado del análisis |
| --- | --- |
| ![Landing](docs/screenshots/01-landing.png) | ![Resultado](docs/screenshots/06-resultado.png) |
| **Tablero del médico** | **Asistente de estudio** |
| ![Tablero](docs/screenshots/03-medico-dashboard.png) | ![Asistente](docs/screenshots/07-wizard.png) |
| **Ficha del paciente** | **Portal del paciente** |
| ![Ficha](docs/screenshots/05-paciente-detalle.png) | ![Paciente](docs/screenshots/08-paciente-home.png) |
| **Modo oscuro** | **Móvil** |
| ![Oscuro](docs/screenshots/10-resultado-dark.png) | ![Móvil](docs/screenshots/11-mobile-dashboard.png) |

## Funcionalidades

**Médico/a**
- Tablero con KPIs (pacientes, estudios del mes, alto riesgo, controles pendientes), últimos análisis y agenda.
- Registro de pacientes por su **correo (Gmail)**: verifica criterios de exclusión y consentimiento, crea la cuenta con contraseña temporal (se muestra una sola vez) y asigna el **código anónimo** (`DEMO-002`, `DEMO-005`, `DEMO-011`).
- Ficha clínica completa (DM, HbA1c con alerta >12 meses o imputada, tabaquismo «a consultar», neuropatía con puntaje y grado, vibratoria 0–50 / «>50», antecedentes, hallazgos, campos futuros) con gráfico de evolución.
- **Asistente de estudio en 4 pasos** que sigue el protocolo: paciente y consentimiento → condiciones ambientales (T 21–24 °C, HR 40–70 %, la humedad resaltada) y checklist de cámara → carga de **2 imágenes** (JPG/PNG/TIFF/IS2, arrastrar y soltar, vista previa) → análisis.
- Resultado: probabilidad a 6 semanas (gauge con cortes 50/70 %), temperaturas absolutas por ROI (6 por pie + general), ΔT, **grupo térmico P/C** con el umbral usado (1,0 °C por defecto; 2,2 °C de la literatura), **simetría**, mapa plantar SVG, factores contribuyentes y ficha del modelo de referencia.
- Notas, publicación del resultado al paciente, control a 6 semanas, **desenlace real** (¿generó lesión?, pie, ROI), informe imprimible («Guardar como PDF») y **exportación CSV** anonimizada con las columnas de la planilla del equipo.
- Gestión del **consentimiento informado** (historial, revocación).

**Paciente**: último resultado en lenguaje simple (sin métricas del modelo), estudios con imágenes (lightbox), próximo control, recomendaciones de autocuidado, sus datos y su consentimiento.

**Administrador/a**: alta de médicos, activación/desactivación, restablecimiento de contraseñas, estadísticas del sistema y **auditoría**. Por diseño no accede a datos clínicos.

## Inicio rápido

```bash
npm install
npm run dev          # http://localhost:3000 (driver memory con datos demo)
```

### Cuentas demo (contraseña `Demo1234!`)

| Rol | Usuario |
| --- | --- |
| Médico/a | `medico@demo.com` (también `medico2@demo.com`) |
| Paciente | `paciente@demo.com` (y 11 pacientes `*.demo@gmail.com`, p. ej. `maria.gomez.demo@gmail.com`) |
| Administrador/a | `admin@demo.com` |

Todos los datos e imágenes de demostración son **ficticios y sintéticos** (las termografías se generan con `npm run generate:images`).

## Scripts

| Script | Descripción |
| --- | --- |
| `npm run dev` | Servidor con recarga (`node --watch`). |
| `npm start` | Servidor en modo normal. |
| `npm test` | Pruebas unitarias e integración (Jest + supertest). |
| `SUPABASE_E2E=1 npm test -- tests/supabase` | Pruebas de extremo a extremo contra un proyecto Supabase real. |
| `npm run lint` | ESLint. |
| `npm run format` / `format:check` | Prettier. |
| `npm run generate:images` | Regenera las termografías sintéticas de `public/demo`. |
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
