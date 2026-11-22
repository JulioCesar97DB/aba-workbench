# Fase 0: informe

Fecha: 22 de noviembre de 2026. Rama `JulioCesar97DB/phase-0`, sin push ni pull request (se hace después de la revisión).

## Lo principal

- **La fase 0 cierra como base técnica, sin generaciones reales, por decisión del dueño (22/11/2026).** Él prefiere construir primero la infraestructura y la app, y probar la salida de la IA después. Las corridas reales, los costos medidos y la elección de las dos mejores salidas quedan para un paso posterior: están aplazadas, no bloqueadas. Todo está listo para hacerlas con un solo comando (ver "Cómo reproducirlo").
- **Lo construido y probado sin llaves:**
  - la ruta propia que habla con Claude y OpenAI;
  - la lista de modelos;
  - el envío de PDFs y la caché;
  - el manejo de rechazos, con el *fallback* de Anthropic encendido;
  - el tope de tamaño;
  - las reglas de redacción y los dos casos inventados;
  - el script `pnpm phase0` con su tope de gasto.

  `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (23 pruebas) y `pnpm phase0 --mock` pasan.
- **Las dos salidas para que la BCBA juzgue la calidad:** se eligen cuando se hagan las corridas reales.
- **Gasto real: 0,00 USD** (Anthropic 0, OpenAI 0). La corrida completa se estima en unos 2,6 USD para los dos casos y los cuatro modelos. El script nunca empieza una llamada que, en el peor caso, pueda pasar el tope (5 USD por defecto), y se detiene si no puede saber cuánto costó algo.
- **El producto será una app local, no una web en Vercel** (decisión del dueño, 22/11/2026). Por eso los límites de Vercel (300 s, plan, 4,5 MB) ya no restringen el producto. El análisis queda abajo como referencia y el tope de tamaño sigue en el código.

## Qué funciona y qué no, por proveedor

"Probado" quiere decir que lo ejecuté o que hay una prueba automática que lo cubre. Las pruebas usan un `fetch` falso, así que revisan la petición exacta que cada SDK mandaría, sin red ni llaves. Lo que necesita la API real está en la última fila.

| Pieza | Claude (`@anthropic-ai/sdk` 1.12) | OpenAI (`openai` 7.62, Responses API) |
| --- | --- | --- |
| Generación con streaming por `POST /api/generate` | Probado: forma de la petición por modelo (pruebas) y tubería completa (simulador). | Igual |
| Lista de modelos (`GET /api/models`) | Construido. Con llave falsa responde 401 con un mensaje propio. | Igual. El mensaje de error de OpenAI nunca se reenvía. |
| PDFs | Probado: los bytes del PDF llegan sin cambios a la petición hacia Anthropic (bloque `document` en base64, nada queda guardado en el proveedor). | Probado igual (`input_file` con `file_data`). |
| Caché del prefijo (reglas + fuentes del caso) | Probado que la petición lleva exactamente dos puntos de corte (tras las reglas y tras las fuentes) y que la instrucción de la sección no se cachea. Caché de 5 minutos. El precalentamiento manda `max_tokens: 0` sin la instrucción. | Probado: reglas en un mensaje `developer` (nunca en `instructions`), dos puntos de corte explícitos, caché de 30 minutos y precalentamiento con `prewarm: true`. |
| Rechazos | Probado: el evento `refusal` lleva `discard: true`, lo que obliga a quien lo reciba a descartar todo el texto de esa generación. Además `done` trae `complete: false`. | Igual |
| Texto cortado por límite de salida | Probado: `max_tokens` da `complete: false`. | Probado: `incomplete` da `complete: false`. |
| La llave no se guarda ni se registra | Va en el encabezado `x-provider-key`. Nada en el código escribe la llave ni el cuerpo en logs. El registro del SDK está apagado (`logLevel: "off"`), así que ni `ANTHROPIC_LOG` ni `OPENAI_LOG` pueden activarlo. El servidor que arranca el script corre sin llaves (ver "Decisiones"). | Igual |
| Peticiones de más de 4,5 MB | Probado: la ruta responde 413 con el mensaje "pega el texto en vez del PDF", también cuando el cuerpo llega en trozos sin `Content-Length`. El script falla antes de enviar. | Igual |
| Lo que solo se ve con la API real | Que el modelo lea bien los PDF, que la caché realmente se use, que el fallback responda como dice la documentación, los tiempos, los costos y la calidad del texto. | Lo mismo, más el comportamiento de los puntos de corte explícitos. |

**Fallback de Anthropic (beta).** Es una función en beta (`server-side-fallback-2026-07-01`) que el dueño decidió encender. Si el modelo pedido se niega por política, Anthropic repite la petición en el modelo que recomienda para ese tipo de rechazo, dentro de la misma llamada. Cada salida guarda qué modelo escribió el texto (`servedModel`), si hubo fallback y cuántos tokens usó cada intento.

Cada intento se cobra a su precio. Están tabulados los dos modelos a los que el fallback puede pasar (`claude-opus-5` y `claude-opus-4-8`). Si Anthropic respondiera con otro modelo, el script se detiene en vez de contarlo como cero. Algunos rechazos no tienen fallback y siguen llegando como rechazo.

El interruptor único es la constante `SERVER_SIDE_FALLBACKS` en `src/lib/providers/anthropic.ts`.

## Costo

**Gastado: 0 USD.**

**Tamaño medido de cada petición** (casos inventados, PDFs generados desde HTML):

| Caso | PDFs (sin codificar) | Cuerpo completo de la petición |
| --- | --- | --- |
| Mateo | 200.160 bytes (2 PDF: Vineland-3 de 2 páginas y PRQ de 1) | 283.830 bytes (0,28 MB) |
| Sofía | 202.851 bytes (2 PDF, 3 páginas) | 288.398 bytes (0,29 MB) |

**Estimación por sección (no medida).** Supuestos:
- Unos 14.500 tokens de entrada. De ellos, unos 13.000 son prefijo cacheable: 3.100 de reglas, 4.300 de notas del caso y unos 6.000 de los dos PDF, que suman tres páginas y cuentan texto e imagen. Los otros 1.200 son la instrucción de la sección.
- Unos 8.000 tokens de salida: unos 2.000 de texto (900 a 1.500 palabras) más unos 6.000 de razonamiento. **Este es el número más incierto**: el razonamiento puede ir de 3.000 a 15.000 tokens.

| Modelo | Precio por millón (entrada / escritura en caché / lectura de caché / salida) | Primera sección (escribe la caché) | Secciones siguientes (leen la caché) |
| --- | --- | --- | --- |
| claude-opus-5-5 | 4 / 5 / 0,20 / 20 | ~0,23 USD | ~0,17 USD |
| claude-fable-5-2 | 8 / 10 / 0,20 / 40 | ~0,46 USD | ~0,33 USD |
| gpt-6.2-sol | 2 / 2,50 / 0,10 / 10 | ~0,12 USD | ~0,08 USD |
| gpt-6.2-astra | 8 / 10 / 0,40 / 40 | ~0,46 USD | ~0,34 USD |

La salida domina el costo; la caché ahorra poco en comparación porque el prefijo es corto.

**Estimación por assessment completo (no medida).** Supuestos: 9 secciones narrativas del largo de Medical Necessity, y los 12 comportamientos, 15 habilidades de reemplazo y 20 intervenciones en grupos de unos 5 por llamada (unas 10 llamadas de salida parecida). En total, unas 19 llamadas que comparten el mismo prefijo en caché.
- claude-opus-5-5: ~3,2 USD
- claude-fable-5-2: ~6,4 USD
- gpt-6.2-sol: ~1,6 USD
- gpt-6.2-astra: ~6,5 USD

Con el margen de incertidumbre del razonamiento, cualquiera de estas cifras puede ser la mitad o el doble. Si ella deja pasar más de 5 minutos entre secciones, la caché de Claude vence y se vuelve a escribir. Eso cuesta unos 0,07 USD más por vez en Opus y 0,13 USD en Fable.

**La corrida pendiente y su tope.** Antes de cada llamada, el script calcula su peor caso:
- toda la entrada al precio de escritura en caché, dos veces porque hay precalentamiento;
- los 32.000 tokens de salida permitidos;
- en Claude, un intento completo más en el modelo de fallback.

Solo empieza la llamada si ese peor caso cabe en lo que queda del tope. Para estos casos, el peor caso es de 1,79 USD en Opus, 2,64 en Fable, 0,43 en Sol y 1,70 en Astra. Si una llamada termina sin decir cuánto costó, o la respondió un modelo sin precio, se le carga su peor caso y la corrida se detiene. Un `--budget` que no sea un número positivo detiene el script antes de empezar.

Con los costos estimados caben las 8 llamadas, en unos 2,6 USD. Si las llamadas reales costaran el doble de lo estimado, la de Fable en el caso de Sofía se saltaría para no arriesgar el tope. Se puede correr sola después con `--only claude-fable-5-2 --case case-b-sofia`.

Los precios están en `src/lib/pricing.ts`, fechados el 21/11/2026, con su fuente.

## Vercel: límites para respuestas largas (referencia)

> **Nota (22/11/2026):** el dueño decidió que aba-workbench será una app local, que corre en la computadora de quien la usa, y no una web alojada en Vercel. Con esa decisión, el límite de 4,5 MB por petición, la elección de plan y el corte a los 300 s ya no restringen el producto. El código no cambia: la app Next.js y sus rutas siguen igual, y el tope de 4,5 MB sigue en el código (ver la pregunta 4).

Según la documentación de Vercel (actualizada en agosto de 2026), con *Fluid compute*, que viene activado por defecto:

| Plan | Duración por defecto | Máxima |
| --- | --- | --- |
| Hobby | 300 s | 300 s |
| Pro / Enterprise | 300 s | 800 s (1.800 s en beta, configurando cada función) |

- **El streaming no alarga el límite.** La duración incluye el tiempo de mandar la respuesta, también por streaming. Al pasarse, Vercel corta y devuelve `504 FUNCTION_INVOCATION_TIMEOUT`.
- **Para una sección que tarda unos minutos.** En Hobby todo tendría que terminar en 5 minutos. Un modelo grande puede pasar uno o dos minutos pensando antes de escribir. La ruta declara `maxDuration = 300` (`src/app/api/generate/route.ts`).
- **Conexiones que parecen inactivas.** Mientras el modelo piensa no sale texto. La ruta manda una línea de "sigo vivo" cada 15 segundos. Sirve igual en local.
- **Tamaño de la petición: 4,5 MB.** Antes de mandar se mide el tamaño, y si pasa de 4,5 MB se pide pegar el texto en lugar del PDF (`src/lib/limits.ts`). Un informe real de Q-global puede pesar más que los de prueba, y el base64 añade un 33 %.

No se desplegó nada.

## Qué modelo dejaría por defecto en cada proveedor

Sin salidas reales no puedo recomendar con datos. Por ahora:

- **Claude:** `claude-fable-5-2`, que es lo decidido ("el más capaz"). Opus 5.5 cuesta la mitad. Si escribe Medical Necessity igual de bien, propondría Opus 5.5 como predeterminado.
- **OpenAI:** `gpt-6.2-astra`, el más capaz según su documentación. `gpt-6.2-sol` cuesta un cuarto y OpenAI lo presenta como el equilibrio entre calidad y costo; aplica la misma regla que con Claude.

El orden "más capaz primero" vive en `src/lib/providers/index.ts` (`MOST_CAPABLE_FIRST`), porque los proveedores no ordenan sus listas por capacidad.

## Revisión de las salidas contra su estructura

Pendiente, junto con las corridas reales. Con las salidas en la mano voy a revisar cada una contra la estructura de ella:

1. Primer párrafo: nombra todas las fuentes (CDE, Vineland-3, BASC-3 PRQ, cuestionarios FBA, entrevista, observaciones con fechas, IEP si existe) y las áreas con déficit.
2. Segundo párrafo: puntajes del Vineland-3 con percentiles y niveles, tal como vienen en el informe.
3. Un párrafo por área, con evidencia del CDE, los padres y la observación directa, y qué hará ABA para esa área.
4. Cierre: por qué todo esto sostiene la necesidad médica y cómo ABA mejorará esos déficits.

Además revisaré "nada inventado" contra las lagunas dejadas a propósito en cada caso (también están en cada `case.json`, que no se manda al modelo):

| Caso | Laguna sembrada | Qué debería hacer una buena salida | ¿La anticipa alguna regla? |
| --- | --- | --- | --- |
| Mateo, 4 años | El Vineland-3 no trae el percentil de Socialización (puntaje 64). | Marcar `[MISSING: ...]` y no calcular el percentil. | Sí, una regla general ("no calcular puntajes faltantes"). Prueba si la cumple. |
| Mateo | No hay nada escrito del VPK: solo lo que la maestra le dijo a la mamá, y la observación en la escuela nunca se hizo. | Presentar la escuela como relato de la mamá, sin describir una observación escolar. | Sí, la regla general sobre lo que solo se sabe de segunda mano. |
| Mateo (nueva) | El BASC-3 PRQ no trae fecha de aplicación; los demás instrumentos son del 10/02/2026. | No ponerle fecha al PRQ; marcarla como faltante. | No: ninguna regla la menciona. |
| Sofía, 9 años | El CDE da los diagnósticos pero no el nivel de severidad del autismo. | Marcarlo como faltante y no escribir "Level 1". | Indirectamente: los hechos de Molina dicen que un CDE sin severidad es un problema. |
| Sofía | La escuela no dejó observar a la BCBA. | Usar el IEP y a la mamá, atribuidos, sin inventar una observación escolar. | Sí, la regla general sobre lo que solo se sabe de segunda mano. |

Otras pruebas que traen los casos: la entrevista de Mateo está en español (la salida debe salir en inglés) y Sofía tiene IEP, medicación y otros servicios.

## Cambios tras la revisión (ronda 1)

- **Tope de gasto.** Ahora falla cerrado:
  - los modelos de fallback tienen precio;
  - un costo desconocido detiene la corrida;
  - `--budget` mal escrito es un error;
  - se aceptan `--opcion=valor` y `--opcion valor`;
  - el peor caso usa toda la salida permitida.
- **Reglas.** Ya no regalan una laguna: el ejemplo de marca faltante usa un instrumento que no está en ningún caso. Se quitaron otros dos ejemplos que se parecían a los casos, y Mateo ganó una laguna que ninguna regla anticipa.
- **Hechos de pagadores.** El archivo de pagadores dice solo lo que dicen los dos textos, y las quejas de Molina están separadas como Molina las agrupa (CDE y solicitud). La lectura de puntajes del Vineland-3 y del PRQ pasó a `rules/instruments.md`, que declara su fuente y está marcado como pendiente de confirmar por la BCBA.
- **Salidas incompletas.** Una salida cortada, fallida o rechazada ya no se guarda como borrador: el `.md` dice "INCOMPLETE" y el texto parcial, si lo hay, va aparte (`.partial.md`). En un rechazo no se guarda nada. Descartar el texto ante un rechazo ahora es parte del contrato del proveedor (`discard: true`), no solo del script.
- **Llaves del script.** Van en `.env.phase0`, no en `.env.local`. Next carga `.env.local` en el servidor, y el script ahora se niega a arrancar el servidor si encuentra llaves en los archivos que Next lee.
- **Pruebas.** 23 pruebas con `node:test` (`pnpm test`), sin llaves ni red.
- **Ruta.** El tope de tamaño se cuenta al leer el cuerpo, también si llega en trozos. Un error al cargar las reglas responde con un JSON de error en vez de un 500 sin forma. El registro de los SDK está apagado.

## Decisiones pequeñas que tomé (todas fáciles de cambiar)

- **Proyecto.** Valores por defecto de `create-next-app` 16.4.6: carpeta `src/`, ESLint, Cache Components y el `AGENTS.md` que Next escribe para agentes. Añadí `"type": "module"`. Los scripts y las pruebas corren con el TypeScript nativo de Node (Node 24 o más), sin dependencias extra. Para eso, los imports relativos dentro de `src/lib` llevan la extensión `.ts`.
- **Contrato de la ruta.**
  - `POST /api/generate` con la llave en el encabezado `x-provider-key`. Responde con eventos de servidor (`meta`, `status`, `text`, `fallback`, `refusal`, `done`, `error`).
  - `done.complete` dice si el texto es usable.
  - `GET /api/models?provider=...` devuelve la lista y el modelo por defecto.
  - `mode: "prewarm"` escribe la caché sin generar texto.
- **Prompts.** Las reglas generales, las de pagadores y las de instrumentos van primero, después las fuentes del caso y al final las reglas de la sección. Así la caché sirve para todas las secciones de un caso.
- **Esfuerzo de razonamiento.** `high` en Claude (Opus 5.5 trae `medium` por defecto) y `medium` en OpenAI (su punto de partida documentado para GPT-6.2). Tope de 32.000 tokens de salida.
- **OpenAI.** Responses API con `store: false`.
- **PDFs dentro de la petición**, no subidos al proveedor.
- **Proveedor simulado** solo con `ABA_ENABLE_MOCK_PROVIDER=1` (`pnpm phase0 --mock`).
- **Salidas.** Cada corrida escribe `docs/phase0/outputs/<caso>/<modelo>.md` y `.json` (tokens, costo, tiempos, versión de las reglas, fallback, estado), más un `runs.json`. Lo del simulador va a `tmp/`, que está en `.gitignore`.
- **Casos inventados.** Los apellidos son "Ficticio" e "Inventada" y la BCBA es "Daniela Muestra". Los PDF salen de HTML impreso con Chrome (`scripts/render-fixture-pdfs.mts`).
- **Idioma.** Las reglas están en inglés porque el assessment se escribe en inglés; `rules/README.md` está en español.
- **Licencia.** Apache 2.0 en su propio commit (`LICENSE` sin modificar, `package.json` y README), por decisión del dueño. `.impeccable/`, una configuración local de una herramienta de diseño, queda fuera del repositorio.

## Preguntas abiertas para el dueño

1. **Duración de la caché de Claude.** La de 5 minutos cuesta 1,25 veces la entrada al escribirse; la de 1 hora, 2 veces. Si ella deja pasar más de 5 minutos entre secciones, la de 5 minutos vence y la siguiente sección paga la entrada completa otra vez. ¿(a) 5 minutos (lo actual), (b) 1 hora, o (c) decidirlo en la fase 1 midiendo su ritmo real? Cuando se hagan las corridas, los tokens escritos y leídos de caché de cada llamada quedarán en los `.json`.
2. **Marcas de datos faltantes.** ¿(a) Solo `[MISSING: ...]` y `[CHECK: ...]` dentro del texto (lo actual), (b) una lista aparte de lagunas debajo del texto, o (c) las dos?
3. **Modelo por defecto si la calidad empata.** Si Opus 5.5 o Sol escriben tan bien como Fable 5.2 o Astra, ¿(a) dejamos por defecto el más capaz como se decidió, o (b) el que cuesta la mitad o la cuarta parte?
4. **Tope de 4,5 MB con la app local.** Ya no lo impone Vercel. ¿(a) Lo dejamos como está, (b) lo subimos a un valor que cubra sus PDF reales (si ella nos dice cuánto pesan un Vineland-3 y un BASC-3 típicos, solo el tamaño), o (c) lo quitamos?
5. **Lectura de los instrumentos.** `rules/instruments.md` explica cómo leer el Vineland-3 y el BASC-3 PRQ (medias, desviaciones, sentido de cada escala). No viene de los pagadores. ¿(a) La BCBA lo revisa ahora, o (b) en la fase 1?

## Cómo reproducirlo

```sh
pnpm install && pnpm build
pnpm test                                   # 23 pruebas, sin llaves ni red
pnpm phase0 --mock                          # tubería completa con el proveedor simulado, sin costo
cp .env.phase0.example .env.phase0          # y poner ANTHROPIC_API_KEY y OPENAI_API_KEY (no en .env.local)
pnpm phase0                                 # corridas reales, tope de 5 USD
pnpm phase0 --only claude-opus-5-5 --case case-a-mateo   # una sola combinación
```

## Lo que falta (aplazado por el dueño)

Cuando se decida hacer las corridas reales:

1. Correr `pnpm phase0`.
2. Guardar los textos y sus `.json` en `docs/phase0/outputs/`.
3. Revisar cada salida contra su estructura y contra las lagunas.
4. Elegir las dos mejores.
5. Reemplazar las estimaciones de este informe por lo medido: costo por sección, tiempos y tokens de caché.
