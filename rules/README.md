# Reglas de redacción

Estas son las instrucciones que recibe el modelo, separadas del código para poder leerlas, discutirlas y versionarlas.

| Archivo | Qué contiene | Cuándo se envía |
| --- | --- | --- |
| `assessment.md` | Reglas para todo el assessment: para qué sirve, quién lo lee, cómo se escribe, "nada inventado", formato para pegar en ABA Matrix. | En cada llamada, como prefijo en caché. |
| `payers/florida-medicaid-molina.md` | Hechos de la política de Florida Medicaid (dic. 2024) y la guía de Molina (jul. 2026) que pesan en la autorización. | En cada llamada, como prefijo en caché. |
| `sections/medical-necessity.md` | Para qué sirve la sección Medical Necessity, la estructura que exige la BCBA y cómo se ve una buena. | Solo al generar esa sección, después del prefijo en caché. |

Cada archivo empieza con `id` y `version`. Al cambiar el contenido se sube la versión; cada salida guarda las versiones que la produjeron (`rulesVersions` en el JSON de cada corrida).

Las reglas están en inglés porque el assessment se escribe en inglés.

El orden importa para el costo: las dos primeras son iguales para todas las secciones y todos los casos, y las fuentes del caso son iguales para todas las secciones de un caso. Ese prefijo se escribe una vez en la caché del proveedor y las demás secciones lo leen a una fracción del precio. Las reglas de cada sección van al final para no romper ese prefijo.
