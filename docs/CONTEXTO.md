# Contexto del proyecto Quorum

Resumen técnico para retomar el desarrollo desde otra computadora o desde ChatGPT Work.

## Producto

Quorum es una demo de compras en grupo para el PayPal AI Hackathon de Devpost. Agrupa intenciones de compra, autoriza el precio inicial con PayPal y captura el precio negociado al formarse el grupo. Incluye anulaciones, reembolsos por bajadas de precio, agentes y una consola de comercio.

La interfaz ofrece inglés y español. El proyecto requiere Node.js 22.18 o posterior y utiliza SQLite integrado en Node.

## Cambios incorporados

- `src/ai/openai.ts` añade soporte de OpenAI Responses API a las respuestas estructuradas y al ciclo de herramientas de los agentes.
- El adaptador conserva el contexto de razonamiento entre llamadas y procesa respuestas incompletas o rechazadas mediante el fallback existente.
- Los agentes aceptan `OPENAI_API_KEY` o `GPT_API_KEY`. Los modelos se configuran con `OPENAI_MODEL` y `OPENAI_FAST_MODEL`, ambos con valor predeterminado `gpt-6-luna`.
- Anthropic mantiene prioridad cuando ambos proveedores están configurados.
- `OPENAI_API_KEY` también permite usar embeddings de OpenAI. Con `GPT_API_KEY` se conservan los embeddings locales.
- La interfaz identifica al proveedor activo y utiliza etiquetas genéricas de IA en las pantallas de intención, precios y negociación.
- El sembrado desactiva temporalmente ambos proveedores para conservar datos de ejemplo deterministas.

Las variables admitidas están documentadas en `.env.example`. Los límites deterministas sobre precios, autorizaciones, capturas y reembolsos se aplican en el código.

## Comprobaciones realizadas

- 40 pruebas unitarias aprobadas, incluidas las regresiones del adaptador OpenAI.
- `npm run typecheck` y `npm run i18n:check` aprobados.
- `npm run e2e:mock`, `npm run e2e:paypal-stub` y `npm run e2e:browser` aprobados.
- `npm run e2e:sandbox` completó autorización, anulación, captura parcial y reembolso usando PayPal Sandbox.
- Se verificaron respuestas estructuradas y llamadas a herramientas con OpenAI, además de consultas de productos con Channel3.

Para las pruebas de navegador, `CHROME_PATH` permite seleccionar el ejecutable de Chrome o Chromium instalado.

## Retomar el trabajo

Clona este fork y pide al agente que lea este archivo, el README y `.env.example`, y revise `git status` antes de modificar el código. Las instrucciones de ejecución y los flujos de demo están en el README y en `docs/DEMO_VIDEO.md`.

Para llevar también la conversación completa desde Codex CLI, al terminar el turno usa `/export sesion-quorum.md` y adjunta ese archivo al nuevo chat.
