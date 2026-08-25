# AI Dev Studio

Ver [ARCHITECTURE.md](./ARCHITECTURE.md) para el diseño completo. Este README es solo "cómo correr lo que ya existe".

## Estado actual: Fase 0 + Fase 1 + Fase 2 + Fase 3 del roadmap

- **Fase 0** — `src/core/client.ts`: wrapper mínimo sobre `@anthropic-ai/sdk` (Messages API), con `sendMessage` y `streamMessage`.
- **Fase 1** — `src/feature-state/store.ts` + `src/mcp-servers/feature-state/server.ts`: el primer servidor MCP ("Feature State MCP" de la sección 4 de ARCHITECTURE.md), que guarda en disco en qué stage va cada feature.
- **Fase 2** — el primer agente real, corriendo solo (sin Director todavía):
  - `src/filesystem-git/` (`fs-ops.ts` + `git-ops.ts`) y `src/mcp-servers/filesystem-git/server.ts`: un segundo servidor MCP que le da al agente Dev un workspace de archivos acotado (sin salirse de su carpeta) con git de verdad por debajo (vía el CLI del sistema, sin dependencias extra).
  - `src/observability/trace-logger.ts`: el logger de trazas por feature/agente (JSONL en `logs/<featureId>.jsonl`) — arrancado ya en esta fase en vez de dejarlo para el final, para que todo agente que se agregue de aquí en adelante loguee desde el día uno.
  - `src/agents/shared/`: el adaptador de tools MCP→Anthropic y los helpers del loop agentic (extraer texto/tool_use, armar tool_result).
  - `src/agents/dev/agent.ts`: el agente Dev — recibe una tarea, corre un loop manual de tool use contra el MCP filesystem-git hasta terminar, logueando cada paso.
- **Fase 3** — el pipeline multi-agente completo, orquestado por el Director:
  - `src/agents/shared/run-agent-loop.ts` + `src/agents/shared/filesystem-agent.ts`: el loop agentic de Fase 2 se extrajo a un motor genérico y reutilizable (`createFilesystemAgent`), para no repetirlo 5 veces.
  - `src/agents/{pm,architect,dev,qa,devops}/agent.ts`: los 5 agentes del equipo, cada uno con su propio system prompt y su propio rol en la traza. El agente Dev quedó re-escrito sobre el motor genérico (mismo comportamiento que en Fase 2).
  - `src/agents/shared/feature-state-client.ts`: el cliente MCP hacia el Feature State MCP de Fase 1, ahora usado por el Director (no solo por scripts de prueba).
  - `src/agents/director/director.ts`: el Director — orquestación **determinista** (no un agente que llama a Claude) que corre PM → Arquitecto → Dev → QA → DevOps en orden, consulta y actualiza el estado de la feature en cada paso (para poder retomarla si quedó a medias — ver ARCHITECTURE.md sección 4), y si QA no aprueba manda la feature de vuelta a Dev hasta `MAX_QA_RETRIES` (2) veces antes de marcarla `blocked`.
  - `src/agents/director/slugify.ts`: genera el `featureId` (`feat_<fecha>_<slug-del-pedido>`) cuando arrancás una feature nueva sin darle un id vos mismo.
  - `scripts/run-studio.ts` (`npm run studio`): el CLI para arrancar o retomar una feature.

Todavía no hay subagentes anidados ni la experiencia de "hablarle" al Director por chat — eso queda para más adelante (ver el comentario en `director.ts` y el campo `parentSpanId` ya preparado en `trace-logger.ts`).

## Pruebas unitarias (Vitest)

Cada archivo de `src/` tiene su suite junto a él, en una subcarpeta `__tests__/` (ej. `src/feature-state/store.ts` → `src/feature-state/__tests__/store.test.tsx`):

```bash
npm run test           # corre todo una vez
npm run test:watch     # modo watch
npm run test:coverage  # con reporte de cobertura
```

Qué mockea cada suite y qué corre de verdad:

- `core/client.test.tsx`, `mcp-servers/*/server.test.tsx`, `agents/{pm,architect,dev,qa,devops}/agent.test.tsx`, `agents/shared/filesystem-agent.test.tsx`, `agents/shared/filesystem-git-client.test.tsx`: mockean `@anthropic-ai/sdk` y/o `@modelcontextprotocol/sdk` con `vi.mock` — prueban el wiring (qué le pasamos al SDK, cómo se rutean las tools, qué queda logueado) sin llamar a la API ni levantar un proceso MCP real.
- `feature-state/store.test.tsx`, `filesystem-git/*.test.tsx`, `observability/trace-logger.test.tsx`, `agents/shared/run-agent-loop.test.tsx`, `agents/shared/mcp-tool-adapter.test.tsx`, `agents/shared/agent-loop-helpers.test.tsx`, `agents/director/slugify.test.tsx`: no mockean nada — corren contra el filesystem y git reales en directorios temporales (o son puramente funciones puras, como `slugify`).
- Los dos `mcp-servers/*/server.test.tsx` sí mockean el SDK de MCP (para no levantar stdio de verdad) pero dejan correr la lógica real de abajo (`FeatureStateStore`, `fs-ops`, `git-ops`) — capturan los handlers que el server registra y los invocan directo.
- `agents/shared/feature-state-client.test.tsx`: las tres funciones puras (`getFeatureState`/`updateFeatureState`/`listPendingFeatures`) se prueban sin mocks, con un cliente MCP falso simple; solo `connectFeatureStateClient` (que sí construye el SDK real) usa `vi.doMock` en un test aislado.
- `agents/director/director.test.tsx`: el Director es orquestación determinista (no llama a la Messages API él mismo), así que sus pruebas mockean los 5 módulos de agentes y el cliente del Feature State MCP (con un `Map` en memoria que replica el merge superficial real de `FeatureStateStore.upsertState`) — sin tocar ningún SDK de Anthropic/MCP.

No se testean los scripts de `scripts/` (son wrappers de CLI que ejecutan `main()` al importarse y no exportan nada) — su lógica real vive en `src/` y ya está cubierta ahí.

## Nota sobre cómo se construyó esto

Este scaffold se arma en un sandbox en la nube sin acceso a `registry.npmjs.org` (política de red del entorno), así que no se puede correr `npm install` real ahí — ni para probar `@anthropic-ai/sdk` y `@modelcontextprotocol/sdk` contra las librerías reales, ni para correr Vitest de verdad. Lo que sí se hace ahí, cada vez:

- Las suites sin mocks de módulos ESM (`store`, `fs-ops`, `git-ops` con git real, `trace-logger`, `mcp-tool-adapter`, `agent-loop-helpers`, `slugify`, `run-agent-loop`, la mitad pura de `feature-state-client`) se corren de verdad contra un shim mínimo compatible con la API de Vitest armado solo para esto en el sandbox — no es Vitest real, pero ejecuta describe/it/expect tal cual están escritos, y se borra antes de cada entrega. Encontró y ayudó a corregir bugs reales antes de entregar el código: el `Omit` roto en `trace-logger.ts` (Fase 2), una regex de aserción (`/git commit/` no matcheaba el mensaje real de git) en dos suites de Fase 2, y en esta entrega (Fase 3) un test de `run-agent-loop.test.tsx` que capturaba el array de `messages` por referencia en vez de copiarlo, así que "veía" un `push` posterior del loop y comparaba mal (fix: `[...params.messages]` al capturar).
- El fix del bug de reintento de QA en `director.ts` (Fase 3) se verificó también por ejecución real y no solo por revisión: se corrió `runDirector` de verdad (sin mocks, con los 5 módulos de agentes y el cliente del Feature State MCP reemplazados temporalmente por implementaciones fake in-memory) contra 7 escenarios — incluyendo revertir el fix a propósito una vez para confirmar que el escenario de reintento efectivamente fallaba sin él, y volverlo a aplicar. Los archivos originales quedaron restaurados byte a byte (diff vacío) antes de esta entrega.
- Las suites con `vi.mock` de los SDKs (`client`, los 5 `agent.test.tsx`, `filesystem-agent`, `filesystem-git-client`, los dos `server.test.tsx`, `director.test.tsx` con sus propios 5 agentes + feature-state-client mockeados) no se pueden ejecutar contra el shim — se revisaron a mano contra el shape documentado de los SDKs. Corre `npm run test` en tu máquina la primera vez y avisa si algo truena.
- Typecheck (`npm run typecheck`) corre siempre, filtrando los errores esperados por dependencias no instaladas (`Cannot find module '@anthropic-ai/sdk'`, etc.) para que cualquier error de tipos real en la lógica misma no se pierda entre el ruido. Fase 3 pasa este typecheck filtrado limpio.

## Cómo correrlo

```bash
npm install
cp .env.example .env   # y pon tu ANTHROPIC_API_KEY
```

1. Pruebas sin red, sin API key (deberían pasar igual que en el sandbox):

   ```bash
   npm run test:store
   npm run test:fs-git
   npm run test:trace-logger
   npm run test:agent-helpers
   ```

2. Feature State MCP de punta a punta (lanza el server como subproceso y le habla como cliente MCP):

   ```bash
   npm run test:mcp-client
   ```

3. El agente Dev solo, sin el resto del pipeline (requiere `ANTHROPIC_API_KEY`):

   ```bash
   npm run agent:dev
   # o con una tarea propia:
   npm run agent:dev -- feat_mi-feature "Crea un archivo README.md que explique este workspace"
   ```

   Revisa el resultado en `workspaces/<featureId>/` (con su propio historial de git) y la traza completa en `logs/<featureId>.jsonl`.

4. El pipeline completo — PM → Arquitecto → Dev → QA → DevOps, vía el Director (requiere `ANTHROPIC_API_KEY`):

   ```bash
   # arranca una feature nueva (genera el featureId a partir del pedido)
   w

   # si quedó en 'blocked' o se cortó a la mitad, retómala por su featureId
   npm run studio -- --resume feat_2026-08-24_quiero-exportar-reportes-a-csv
   ```

   Cada stage corre contra `workspaces/<featureId>/` con su propio historial de git; el estado (`currentStage`, qué stage está `done`/`failed`, cuántos reintentos de QA lleva) vive en `features/<featureId>/state.json` vía el Feature State MCP; y la traza completa de quién hizo qué — Director incluido — queda en `logs/<featureId>.jsonl`.

5. Wrapper de Messages API suelto (requiere `ANTHROPIC_API_KEY`):

   ```bash
   npm run test:core
   ```

6. Typecheck general:

   ```bash
   npm run typecheck
   ```

7. Toda la suite de Vitest:

   ```bash
   npm run test
   ```

## Siguiente paso (Fase 4+)

Con el pipeline multi-agente ya orquestado de forma determinista, lo que queda del stack original por cubrir es SubAgents de verdad (por ejemplo, que QA dispare un subagente anidado para revisar un archivo puntual, con `parentSpanId` — ya preparado en `trace-logger.ts` — apuntando al span del agente que lo lanzó) y, más adelante, la experiencia de "hablarle" al Director por chat en vez de solo por CLI (mencionada como pendiente en el comentario de `director.ts`).
