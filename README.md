# AI Dev Studio

Ver [ARCHITECTURE.md](./ARCHITECTURE.md) para el diseño completo. Este README es solo "cómo correr lo que ya existe".

## Estado actual: Fase 0 + Fase 1 + Fase 2 del roadmap

- **Fase 0** — `src/core/client.ts`: wrapper mínimo sobre `@anthropic-ai/sdk` (Messages API), con `sendMessage` y `streamMessage`.
- **Fase 1** — `src/feature-state/store.ts` + `src/mcp-servers/feature-state/server.ts`: el primer servidor MCP ("Feature State MCP" de la sección 4 de ARCHITECTURE.md), que guarda en disco en qué stage va cada feature.
- **Fase 2** — el primer agente real, corriendo solo (sin Director todavía):
  - `src/filesystem-git/` (`fs-ops.ts` + `git-ops.ts`) y `src/mcp-servers/filesystem-git/server.ts`: un segundo servidor MCP que le da al agente Dev un workspace de archivos acotado (sin salirse de su carpeta) con git de verdad por debajo (vía el CLI del sistema, sin dependencias extra).
  - `src/observability/trace-logger.ts`: el logger de trazas por feature/agente (JSONL en `logs/<featureId>.jsonl`) — arrancado ya en esta fase en vez de dejarlo para el final, para que todo agente que se agregue de aquí en adelante loguee desde el día uno.
  - `src/agents/shared/`: el adaptador de tools MCP→Anthropic y los helpers del loop agentic (extraer texto/tool_use, armar tool_result).
  - `src/agents/dev/agent.ts`: el agente Dev — recibe una tarea, corre un loop manual de tool use contra el MCP filesystem-git hasta terminar, logueando cada paso.

Todavía no hay Director ni pipeline multi-agente, ni subagentes — eso es Fase 3 en adelante.

## Pruebas unitarias (Vitest)

Cada archivo de `src/` tiene su suite en `__test__/`, con la misma ruta relativa (ej. `src/feature-state/store.ts` → `__test__/feature-state/store.test.tsx`):

```bash
npm run test           # corre todo una vez
npm run test:watch     # modo watch
npm run test:coverage  # con reporte de cobertura
```

Qué mockea cada suite y qué corre de verdad:

- `core/client.test.tsx`, `agents/dev/agent.test.tsx`, `mcp-servers/*/server.test.tsx`: mockean `@anthropic-ai/sdk` y/o `@modelcontextprotocol/sdk` con `vi.mock` — prueban el wiring (qué le pasamos al SDK, cómo se rutean las tools, qué queda logueado) sin llamar a la API ni levantar un proceso MCP real.
- `feature-state/store.test.tsx`, `filesystem-git/*.test.tsx`, `observability/trace-logger.test.tsx`, `agents/shared/*.test.tsx`: no mockean nada — corren contra el filesystem y git reales en directorios temporales.
- Los dos `mcp-servers/*/server.test.tsx` sí mockean el SDK de MCP (para no levantar stdio de verdad) pero dejan correr la lógica real de abajo (`FeatureStateStore`, `fs-ops`, `git-ops`) — capturan los handlers que el server registra y los invocan directo.

No se testean los scripts de `scripts/` (son wrappers de CLI que ejecutan `main()` al importarse y no exportan nada) — su lógica real vive en `src/` y ya está cubierta ahí.

## Nota sobre cómo se construyó esto

Este scaffold se arma en un sandbox en la nube sin acceso a `registry.npmjs.org` (política de red del entorno), así que no se puede correr `npm install` real ahí — ni para probar `@anthropic-ai/sdk` y `@modelcontextprotocol/sdk` contra las librerías reales, ni para correr Vitest de verdad. Lo que sí se hace ahí, cada vez:

- Las suites sin mocks (`store`, `fs-ops`, `git-ops` con git real, `trace-logger`, `mcp-tool-adapter`, `agent-loop-helpers`) se corren de verdad contra un shim mínimo compatible con la API de Vitest armado solo para esto en el sandbox — no es Vitest real, pero ejecuta describe/it/expect tal cual están escritos. Encontró y ayudó a corregir dos bugs reales antes de entregar el código: el `Omit` roto en `trace-logger.ts` (Fase 2) y una regex de aserción (`/git commit/` no matcheaba el mensaje real de git) en dos suites de esta entrega.
- Las suites con `vi.mock` (`client`, `agent`, los dos `server`) no se pueden ejecutar así — se revisaron a mano contra el shape documentado de ambos SDKs. Corre `npm run test` en tu máquina la primera vez y avisa si algo truena.
- Typecheck (`npm run typecheck`) corre siempre, filtrando los errores esperados por dependencias no instaladas (`Cannot find module '@anthropic-ai/sdk'`, etc.) para que cualquier error de tipos real en la lógica misma no se pierda entre el ruido.

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

3. El agente Dev completo (requiere `ANTHROPIC_API_KEY`):

   ```bash
   npm run agent:dev
   # o con una tarea propia:
   npm run agent:dev -- feat_mi-feature "Crea un archivo README.md que explique este workspace"
   ```

   Revisa el resultado en `workspaces/<featureId>/` (con su propio historial de git) y la traza completa en `logs/<featureId>.jsonl`.

4. Wrapper de Messages API suelto (requiere `ANTHROPIC_API_KEY`):

   ```bash
   npm run test:core
   ```

5. Typecheck general:

   ```bash
   npm run typecheck
   ```

6. Toda la suite de Vitest:

   ```bash
   npm run test
   ```

## Siguiente paso (Fase 3)

Pipeline multi-agente: agregar PM → Arquitecto → Dev → QA → DevOps orquestados por el Director, en secuencia — y ahí sí conectar el Feature State MCP para que el Director sepa en qué stage va cada feature y pueda retomarla si quedó a medias.
