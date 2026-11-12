# Requerimientos

## Requerimientos funcionales

| ID | Requerimiento | Prioridad | Estado |
| --- | --- | --- | --- |
| RF-01 | Autenticación por correo y contraseña; el correo (Gmail) identifica al usuario. | Alta | Hecho |
| RF-02 | Tres roles (administrador, médico, paciente) con permisos diferenciados. | Alta | Hecho |
| RF-03 | Registro de pacientes con verificación de criterios de exclusión y consentimiento informado. | Alta | Hecho |
| RF-04 | Ficha clínica con todas las variables del protocolo (DM, HbA1c, tabaquismo, neuropatía, vibratoria, antecedentes, hallazgos) y campos futuros. | Alta | Hecho |
| RF-05 | Asistente de toma con condiciones ambientales, checklist de cámara y carga de 2 imágenes (JPG, PNG, TIFF, IS2). | Alta | Hecho |
| RF-06 | Análisis por ROI (6 por pie + general) con temperaturas absolutas, ΔT, grupo P/C con umbral configurable, simetría y probabilidad a 6 semanas. | Alta | Hecho (simulado) |
| RF-07 | Publicación del resultado al paciente. | Alta | Hecho |
| RF-08 | Programación de controles y registro del desenlace (¿generó lesión?). | Alta | Hecho |
| RF-09 | Informe imprimible y exportación CSV anonimizada con las columnas de la planilla. | Media | Hecho |
| RF-10 | Portal del paciente: estudios, imágenes, resultado simplificado, próximo control, autocuidado, datos y consentimiento. | Alta | Hecho |
| RF-11 | Administración de usuarios y auditoría. | Media | Hecho |
| RF-12 | Ingreso con Google (OAuth). | Baja | Previsto (interfaz `AuthProvider`) |
| RF-13 | Procesamiento real de imágenes (segmentación, ROIs, modelo). | Alta | En desarrollo (punto de extensión `UlcerPredictor`) |
| RF-14 | Invitación por correo al paciente. | Baja | Previsto |

## Requerimientos no funcionales

| ID | Categoría | Requerimiento |
| --- | --- | --- |
| RNF-01 | Seguridad | Contraseñas con hash (bcrypt / Supabase Auth); sesión en cookie firmada `httpOnly`; CSRF; CSP; limitación de intentos de ingreso. |
| RNF-02 | Seguridad | Autorización a nivel de objeto en servicios + RLS en Postgres; imágenes en bucket privado con URLs firmadas de 120 s. |
| RNF-03 | Privacidad | Seudonimización de la ficha clínica por código; datos personales separados; exportaciones anonimizadas. |
| RNF-04 | Trazabilidad | Registro de auditoría de accesos y acciones relevantes. |
| RNF-05 | Usabilidad | Interfaz en español rioplatense, lenguaje simple para pacientes, estados vacíos con acción sugerida. |
| RNF-06 | Accesibilidad | Etiquetas en todos los campos, foco visible, contraste AA, navegación por teclado, `prefers-reduced-motion`, textos alternativos y tabla accesible para el gráfico. |
| RNF-07 | Adaptabilidad | Diseño responsive (desde 360 px) y modo oscuro automático. |
| RNF-08 | Portabilidad | Despliegue serverless en Vercel sin disco persistente; persistencia intercambiable por configuración. |
| RNF-09 | Mantenibilidad | Arquitectura en capas, patrones documentados, ESLint + Prettier, pruebas automatizadas. |
| RNF-10 | Rendimiento | Páginas renderizadas en servidor; JS mínimo; Chart.js sólo donde se usa. |
| RNF-11 | Extensibilidad | Nuevo algoritmo = nueva estrategia `UlcerPredictor`; nuevo proveedor de identidad = nueva estrategia `AuthProvider`. |

## Marco legal (Argentina)

### Ley 25.326 – Protección de los Datos Personales

Los datos de salud son **datos sensibles** (art. 2 y 7): sólo pueden tratarse con consentimiento del titular o por razones de interés general, y con medidas de seguridad reforzadas (art. 9 y 10).

| Exigencia | Implementación |
| --- | --- |
| Consentimiento libre, expreso e informado (art. 5) | Registro obligatorio de consentimiento al alta; historial y revocación (`consents`). Sin consentimiento vigente no se cargan estudios. |
| Calidad y minimización de datos (art. 4) | Sólo las variables del protocolo; DNI opcional; ficha clínica seudonimizada por código. |
| Seguridad (art. 9) | Cifrado en tránsito (HTTPS), hash de contraseñas, RLS, bucket privado, URLs firmadas, auditoría, cabeceras de seguridad. |
| Confidencialidad (art. 10) | Acceso restringido al médico tratante y al titular; el administrador no ve datos clínicos. |
| Derechos de acceso, rectificación y supresión (art. 14 a 16) | El paciente ve sus datos y su consentimiento; la rectificación/supresión se solicita al médico (pendiente: autogestión y supresión lógica). |
| Cesión con datos disociados (art. 11 y 28) | Exportación CSV anonimizada para el análisis del equipo. |
| Registro de bases (art. 21) | A cargo de la institución responsable antes del uso con pacientes reales (AAIP). |

### Ley 26.529 – Derechos del Paciente, Historia Clínica y Consentimiento Informado

| Exigencia | Implementación |
| --- | --- |
| Autonomía de la voluntad y consentimiento informado (art. 2 inc. e, art. 5 y 6) | Consentimiento por versión del documento; revocable en cualquier momento sin afectar la atención (art. 10). |
| Información sanitaria (art. 2 inc. f, art. 4) | El paciente accede a sus estudios y resultados en lenguaje comprensible. |
| Confidencialidad e intimidad (art. 2 inc. c y d) | Control de acceso por rol y por objeto; seudonimización. |
| Historia clínica: integridad, inviolabilidad, registro de modificaciones (art. 15 a 18) | Imágenes no modificables desde el cliente; auditoría de altas, ediciones y publicaciones con fecha y autor. El portal es **complementario** a la historia clínica institucional; no la reemplaza. |
| Titularidad de la historia clínica (art. 14) | El paciente puede consultar su información; la exportación completa para el titular queda como mejora. |

### Otras consideraciones

- **Uso de investigación**: el uso con pacientes reales requiere aprobación de un comité de ética (CIEIS) y del protocolo; el portal ya separa el consentimiento por versión del documento.
- **No es un producto médico aprobado**: el resultado es exploratorio y simulado; la interfaz lo indica en todas las pantallas de resultado e informes (ANMAT, Disposición 2318/02 para software médico, fuera del alcance de esta etapa).
- **Retención**: definir con la institución el plazo de conservación (la Ley 26.529 establece 10 años para la historia clínica).
