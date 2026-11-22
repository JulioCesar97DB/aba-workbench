# Fase 0: informe

Fecha: 21 de noviembre de 2026. Rama `JulioCesar97DB/phase-0`, sin push ni pull request (se hace después de la revisión).

## Lo principal

- **No hay textos generados todavía, porque no hay llaves de API.** No existe `.env.local` en este worktree, y ni `ANTHROPIC_API_KEY` ni `OPENAI_API_KEY` están en el entorno. Hay que poner **las dos** en `.env.local` (hay un `.env.example`) y correr `pnpm phase0`. Esa corrida es el segundo paso de esta fase.
- **Todo lo demás está construido y probado sin llaves.** La ruta propia que habla con Claude y OpenAI, la lista de modelos, el envío de PDFs, la caché, el manejo de rechazos (con el *fallback* de Anthropic encendido), las reglas de redacción, los dos casos inventados y el script `pnpm phase0`. `pnpm install && pnpm build` pasa, `pnpm lint` y `pnpm typecheck` también, y el script corre de punta a punta contra un proveedor simulado.
- **Las dos salidas para que la BCBA juzgue la calidad: pendientes.** Se eligen en cuanto existan las salidas reales.
- **Gasto real: 0,00 USD** (Anthropic 0, OpenAI 0). La corrida completa del segundo paso se estima en unos 2,5 USD para los dos casos y los cuatro modelos (ver "Costo"). El script se detiene antes de pasar de 5 USD.
- **Vercel corta cualquier función a los 300 segundos en el plan Hobby, y el streaming no alarga ese tiempo.** Una sección que tarde unos minutos cabe, pero queda cerca del límite con los modelos más lentos; en Pro el techo sube a 800 s. Hay que medirlo en el segundo paso.
- **El límite de 4,5 MB por petición en Vercel está implementado como tope.** Los casos de prueba mandan 0,28 MB cada uno, pero los PDF reales pueden pesar mucho más (ver "Vercel").

## Qué funciona y qué no, por proveedor

"Probado" quiere decir que lo ejecuté. "Construido" quiere decir que el código existe, compila contra los tipos del SDK oficial y sigue la documentación actual, pero no habló con el proveedor de verdad porque falta la llave.

| Pieza | Claude (`@anthropic-ai/sdk` 1.12) | OpenAI (`openai` 7.62, Responses API) |
| --- | --- | --- |
| Generación con streaming por `POST /api/generate` | Construido. La tubería (ruta, eventos, guardado) está probada con el proveedor simulado. | Igual |
| Lista de modelos en vivo (`GET /api/models`) | Construido. Probado con llave falsa: responde 401 con mensaje claro. | Igual. Probado con llave falsa: 401 sin repetir el pedazo de llave que OpenAI incluye en su error. |
| PDFs (Vineland-3, BASC-3) | Construido: se mandan dentro de la petición en base64 y no quedan guardados en el proveedor. Probado que llegan íntegros a la capa del proveedor. | Igual (`input_file` con `file_data`) |
| Caché del prefijo (reglas + fuentes del caso) | Construido: dos puntos de corte, uno tras las reglas y otro tras las fuentes, con caché de 5 minutos. El script la precalienta antes de cada generación. | Construido: reglas en un mensaje `developer` (GPT-6.2 nunca cachea `instructions`) y puntos de corte explícitos, con caché de 30 minutos. |
| Rechazos | Construido: se revisa `stop_reason: "refusal"` y se descarta el texto parcial. El *fallback* del servidor está encendido en su forma `"default"`. | Construido: se detecta la salida de tipo `refusal`. |
| La llave nunca se guarda ni se registra | Revisado en el código: va en el encabezado `x-provider-key`, nada escribe el cuerpo ni la llave en logs, y el servidor de prueba arranca sin las llaves en su entorno. | Igual |
| Peticiones de más de 4,5 MB | Probado: la ruta responde 413 con el mensaje "pega el texto en vez del PDF", y el script falla antes de enviar. | Igual |

Lo que falta comprobar con llaves: que los modelos lean bien los PDF, que la caché realmente se use (que aparezcan tokens leídos de caché), los tiempos reales, los costos reales y, sobre todo, la calidad del texto.

**Fallback de Anthropic (beta).** Es una función en beta (`server-side-fallback-2026-07-01`). Si el modelo pedido se niega por política, Anthropic repite la petición en el modelo que recomienda para ese tipo de rechazo, dentro de la misma llamada. Cada salida guarda qué modelo escribió el texto (`servedModel`), si hubo fallback y el costo de cada intento a su propio precio. Algunos rechazos no tienen fallback y siguen llegando como rechazo. El interruptor único es la constante `SERVER_SIDE_FALLBACKS` en `src/lib/providers/anthropic.ts`: con `null` queda apagado.

## Costo

**Gastado: 0 USD.**

**Tamaño medido de cada petición** (casos inventados, PDFs generados desde HTML):

| Caso | PDFs (sin codificar) | Cuerpo completo de la petición |
| --- | --- | --- |
| Mateo | 200.169 bytes (Vineland-3 de 2 páginas + PRQ de 1) | 283.842 bytes (0,28 MB) |
| Sofía | 202.851 bytes | 288.398 bytes (0,29 MB) |

**Estimación por sección (no medida).** Supuestos:
- Unos 14.500 tokens de entrada. De ellos, unos 13.000 son prefijo cacheable (2.800 de reglas, 4.300 de notas del caso y unos 6.000 de los tres PDF, que cuentan texto e imagen por página) y unos 1.400 son la instrucción de la sección.
- Unos 8.000 tokens de salida: unos 2.000 de texto (900 a 1.500 palabras) más unos 6.000 de razonamiento. **Este es el número más incierto**: el razonamiento puede ir de 3.000 a 15.000 tokens.

| Modelo | Precio por millón (entrada / escritura en caché / lectura de caché / salida) | Primera sección (escribe la caché) | Secciones siguientes (leen la caché) |
| --- | --- | --- | --- |
| claude-opus-5-5 | 4 / 5 / 0,20 / 20 | ~0,23 USD | ~0,17 USD |
| claude-fable-5-2 | 8 / 10 / 0,20 / 40 | ~0,46 USD | ~0,33 USD |
| gpt-6.2-sol | 2 / 2,50 / 0,10 / 10 | ~0,12 USD | ~0,09 USD |
| gpt-6.2-astra | 8 / 10 / 0,40 / 40 | ~0,46 USD | ~0,34 USD |

La salida domina el costo; la caché ahorra poco en comparación porque el prefijo es corto (unos 13.000 tokens).

**Estimación por assessment completo (no medida).** Supuestos: 9 secciones narrativas del largo de Medical Necessity, y los 12 comportamientos, 15 habilidades de reemplazo y 20 intervenciones en grupos de unos 5 por llamada (unas 10 llamadas de salida parecida). En total, unas 19 llamadas que comparten el mismo prefijo en caché.
- claude-opus-5-5: ~3,3 USD
- claude-fable-5-2: ~6,4 USD
- gpt-6.2-sol: ~1,7 USD
- gpt-6.2-astra: ~6,6 USD

Con el margen de incertidumbre del razonamiento, cualquiera de estas cifras puede ser la mitad o el doble. Si ella deja pasar más de 5 minutos entre secciones, la caché de Claude vence y se vuelve a escribir. Eso cuesta unos 0,07 USD más por vez en Opus y 0,13 USD en Fable.

**Corrida del segundo paso:** unos 1,27 USD por caso con los cuatro modelos, unos 2,5 USD en total. El script calcula el costo real después de cada llamada y no empieza una que pueda pasar el tope (`--budget`, 5 USD por defecto).

Los precios están en `src/lib/pricing.ts`, fechados el 21/11/2026, con su fuente.

## Vercel: límites para respuestas largas

Según la documentación actual de Vercel (actualizada en agosto de 2026), con *Fluid compute*, que viene activado por defecto:

| Plan | Duración por defecto | Máxima |
| --- | --- | --- |
| Hobby | 300 s | 300 s |
| Pro / Enterprise | 300 s | 800 s (1.800 s en beta, configurando cada función) |

- **El streaming no alarga el límite.** La duración incluye el tiempo de mandar la respuesta, también cuando va por streaming. Al pasarse, Vercel corta y devuelve `504 FUNCTION_INVOCATION_TIMEOUT`. El streaming solo sirve para que ella vea el texto mientras se escribe.
- **Qué significa para una sección que tarda unos minutos.** En Hobby, todo tiene que terminar en 5 minutos. Un modelo grande con mucho razonamiento puede pasar uno o dos minutos pensando antes de escribir la primera palabra. Medical Necessity debería caber, pero sin margen holgado. Si se corta, se pierde el final del texto. En la fase 1 la interfaz debería conservar lo recibido y ofrecer reintentar. En Pro el techo sube a 800 s. La ruta declara `maxDuration = 300` (`src/app/api/generate/route.ts`), un número fácil de cambiar.
- **Conexiones que parecen inactivas.** Mientras el modelo piensa no sale texto. La ruta manda una línea de "sigo vivo" cada 15 segundos para que ningún intermediario cierre la conexión. Vercel lo recomienda para clientes HTTP/1.1.
- **Tamaño de la petición: 4,5 MB.** Existe un modo de hasta 20 MiB, pero está en beta y exige Pro con 4 GB de memoria. Por decisión del dueño no se usa. Antes de mandar se mide el tamaño, y si pasa de 4,5 MB se pide pegar el texto en lugar del PDF (`src/lib/limits.ts`, que también usará el navegador). Los PDF de prueba son pequeños porque son HTML impreso. Un informe real de Q-global puede pesar más, y el base64 añade un 33 %: dos PDF de 1,5 MB ya suman unos 4 MB.
- **Costo en Pro.** El tiempo esperando al modelo no cuenta como CPU activa, pero la memoria se cobra mientras la función está abierta.

No se desplegó nada.

## Qué modelo dejaría por defecto en cada proveedor

Sin salidas reales no puedo recomendar con datos. Por ahora:

- **Claude:** `claude-fable-5-2`, que es lo decidido ("el más capaz"). Opus 5.5 cuesta la mitad. Si en el segundo paso escribe Medical Necessity igual de bien, propondría Opus 5.5 como predeterminado.
- **OpenAI:** `gpt-6.2-astra`, el más capaz según su documentación. `gpt-6.2-sol` cuesta un cuarto y OpenAI lo presenta como el equilibrio entre calidad y costo; aplica la misma regla que con Claude.

El orden "más capaz primero" vive en `src/lib/providers/index.ts` (`MOST_CAPABLE_FIRST`), porque los proveedores no ordenan sus listas por capacidad.

## Revisión de las salidas contra su estructura

Pendiente: no hay salidas. Con las salidas reales voy a revisar cada una contra la estructura de ella:

1. Primer párrafo: nombra todas las fuentes (CDE, Vineland-3, BASC-3 PRQ, cuestionarios FBA, entrevista, observaciones con fechas, IEP si existe) y las áreas con déficit.
2. Segundo párrafo: puntajes del Vineland-3 con percentiles y niveles, tal como vienen en el informe.
3. Un párrafo por área, con evidencia del CDE, los padres y la observación directa, y qué hará ABA para esa área.
4. Cierre: por qué todo esto sostiene la necesidad médica y cómo ABA mejorará esos déficits.

Además revisaré "nada inventado" contra las dos lagunas que dejé a propósito en cada caso (también están en cada `case.json`):

| Caso | Laguna sembrada | Qué debería hacer una buena salida |
| --- | --- | --- |
| Mateo, 4 años | El Vineland-3 no trae el percentil de Socialización (puntaje 64). | Marcar `[MISSING: ...]` y no calcular el percentil. |
| Mateo | No hay nada escrito del VPK: solo lo que la maestra le dijo a la mamá, y la observación en la escuela nunca se hizo. | Presentar la escuela como relato de la mamá, sin describir una observación escolar. |
| Sofía, 9 años | El CDE da los diagnósticos pero no el nivel de severidad del autismo. | Marcarlo como faltante y no escribir "Level 1". |
| Sofía | La escuela no dejó observar a la BCBA. | Usar el IEP y a la mamá, atribuidos, sin inventar una observación escolar. |

Otras pruebas que traen los casos: la entrevista de Mateo está en español (la salida debe salir en inglés) y Sofía tiene IEP, medicación y otros servicios.

## Decisiones pequeñas que tomé (todas fáciles de cambiar)

- **Proyecto.** Valores por defecto de `create-next-app` 16.4.6: carpeta `src/`, ESLint, Cache Components y el `AGENTS.md` que Next escribe para agentes. Añadí `"type": "module"`. Los scripts corren con el TypeScript nativo de Node (hace falta Node 24 o más), sin dependencia extra.
- **Contrato de la ruta.**
  - `POST /api/generate` con la llave en el encabezado `x-provider-key`. Responde con eventos de servidor (`meta`, `status`, `text`, `fallback`, `refusal`, `done`, `error`).
  - `GET /api/models?provider=...` devuelve la lista y el modelo por defecto.
  - Hay un `mode: "prewarm"` que escribe la caché sin generar texto.
- **Prompts.** Las reglas generales y de pagadores van primero, después las fuentes del caso y al final las reglas de la sección. Así la caché sirve para todas las secciones de un caso. Las fuentes de texto van entre etiquetas `<source>` y cada PDF va precedido de su etiqueta.
- **Esfuerzo de razonamiento.** `high` en Claude (Anthropic lo recomienda para trabajo donde importa la calidad; Opus 5.5 trae `medium` por defecto) y `medium` en OpenAI (su punto de partida documentado para GPT-6.2). Tope de 32.000 tokens de salida.
- **OpenAI.** Responses API con `store: false`, para que el caso no quede guardado en OpenAI.
- **PDFs dentro de la petición** y no subidos a la Files API del proveedor, para que no queden guardados allá.
- **Proveedor simulado** solo con `ABA_ENABLE_MOCK_PROVIDER=1` (`pnpm phase0 --mock`). Sirve para probar sin llaves; en producción no existe.
- **Salidas.** Cada corrida escribe `docs/phase0/outputs/<caso>/<modelo>.md` (el texto, con un comentario arriba que dice qué modelo lo pidió y cuál lo escribió) y un `.json` con tokens, costo, tiempos, versión de las reglas y fallback, más un `runs.json` de resumen. Lo del simulador va a `tmp/`, que está en `.gitignore`.
- **Casos inventados.** Los apellidos son "Ficticio" e "Inventada", la BCBA es "Daniela Muestra" y la escuela "Ejemplo Elementary". Los PDF salen de HTML impreso con Chrome (`scripts/render-fixture-pdfs.mts`) y llevan al pie que son inventados.
- **Idioma.** Las reglas están en inglés porque el assessment se escribe en inglés; `rules/README.md` está en español.

## Preguntas abiertas para el dueño

1. **Duración de la caché de Claude.** La de 5 minutos cuesta 1,25 veces la entrada al escribirse; la de 1 hora, 2 veces. Si ella deja pasar más de 5 minutos entre secciones, la de 5 minutos vence y la siguiente sección paga la entrada completa otra vez. ¿(a) 5 minutos (lo actual), (b) 1 hora, o (c) decidirlo en la fase 1 midiendo su ritmo real? Los tokens escritos y leídos de caché de cada llamada quedarán en los `.json` del segundo paso.
2. **Plan de Vercel.** ¿(a) Hobby, con techo de 300 s (lo actual), o (b) Pro, hasta 800 s? Los tiempos reales por modelo saldrán en el segundo paso, junto a ese techo.
3. **Marcas de datos faltantes.** ¿(a) Solo `[MISSING: ...]` y `[CHECK: ...]` dentro del texto (lo actual), (b) una lista aparte de lagunas debajo del texto, o (c) las dos?
4. **Modelo por defecto si la calidad empata.** Si Opus 5.5 o Sol escriben tan bien como Fable 5.2 o Astra, ¿(a) dejamos por defecto el más capaz como se decidió, o (b) el que cuesta la mitad o la cuarta parte?
5. **Peso de los PDF reales.** ¿Puede ella mirar cuánto pesan (solo el tamaño en MB, sin abrirlos aquí) un Vineland-3 y un BASC-3 típicos exportados de Q-global? (a) Sí, y sabremos ya si el tope de 4,5 MB le va a afectar; (b) no, lo vemos en la fase 6 con un caso real.

## Cómo reproducirlo

```sh
pnpm install && pnpm build
pnpm phase0 --mock                          # sin llaves ni costo: prueba la tubería
cp .env.example .env.local                  # y poner ANTHROPIC_API_KEY y OPENAI_API_KEY
pnpm phase0                                 # corridas reales, tope de 5 USD
pnpm phase0 --only=claude-opus-5-5 --case=case-a-mateo   # una sola combinación
```

## Lo que falta

El segundo paso, cuando estén las llaves:

1. Correr `pnpm phase0`.
2. Guardar los textos y sus `.json` en `docs/phase0/outputs/`.
3. Revisar cada salida contra su estructura y contra las lagunas.
4. Elegir las dos mejores.
5. Reemplazar las estimaciones de este informe por lo medido: costo por sección, tiempos frente a los 300 s y tokens de caché.
