# How to use the Agent Loop

Ahora mismo (Fase 2) se usa por línea de comandos, un feature a la vez — todavía no hay chat ni nada con lo que "hablarle" directamente. El flujo real, una vez que hagas npm install y pongas tu API key, es este:

```bash
npm run agent:dev -- feat_export-csv "Crea un endpoint que exporte los reportes a CSV"
```

Ahí el agente Dev arranca, lanza el MCP filesystem-git apuntando a workspaces/feat_export-csv/ (una carpeta nueva y aislada, con su propio repo de git — no toca ningún proyecto real tuyo todavía), y empieza a llamar herramientas (leer, escribir, listar, git status/commit) hasta que termina la tarea y hace commit. Al terminar tienes tres cosas para revisar: el código en workspaces/feat_export-csv/ con su historial de git, la traza completa en logs/feat_export-csv.jsonl (quién hizo qué, paso a paso), y el resumen que el agente imprime en consola.

Eso es "usarlo" hoy: una tarea, un agente, una corrida de terminal. Todavía no es el producto final — es la pieza mínima para probar que el loop agente↔MCP↔Claude funciona de verdad.

## Roadmap y experiencia final

La forma de uso que vale la pena tener en mente, según el roadmap:

- Fase 3 (Director + pipeline): en vez de invocar al Dev directo, le hablas al Director con un solo comando — algo como npm run studio -- "quiero exportar reportes a CSV" — y él solo va corriendo PM → Arquitecto → Dev → QA → DevOps, consultando el Feature State MCP para saber en qué va cada uno. Ahí ya no eliges tú qué agente correr.
- Fase 5 (chat con streaming): esa misma interacción, pero por un chat web o un bot de Telegram/Slack — escribes el pedido en lenguaje natural y ves en tiempo real "PM: ✅ specs listas", "Dev: escribiendo código...", etc. Esa es la experiencia final pensada para el proyecto: tú nunca corres agentes a mano, solo conversas con el Director.
- Para retomar algo a medias (lo que pediste desde el principio), sería npm run studio -- --resume feat_export-csv: el Director lee el state.json de esa feature y sigue donde se quedó, sin repetir PM/Arquitecto si ya estaban listos.

Y una aclaración importante sobre el alcance real: por ahora esto está pensado como entorno de práctica aislado (cada feature en su propia carpeta desechable bajo workspaces/), no para que apunte a tus repos de verdad. El día que quieras usarlo sobre un proyecto real, cambiarías WORKSPACE_ROOT para que apunte a ese repo — pero yo esperaría a tener el pipeline completo y probado antes de darle esa confianza.