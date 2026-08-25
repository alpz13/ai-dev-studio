/**
 * Agente Dev: implementa la feature (lee specs.md/design.md si existen,
 * escribe código, confirma con un commit de git) usando el MCP
 * filesystem-git. Desde Fase 3 es una instancia de createFilesystemAgent —
 * el loop agentic en sí vive en shared/run-agent-loop.ts, compartido con
 * PM, Arquitecto, QA y DevOps.
 */
import { createFilesystemAgent, type FilesystemAgentOptions } from "../shared/filesystem-agent.js";

const DEV_SYSTEM_PROMPT = `Eres el agente Dev de AI Dev Studio. Recibes una tarea de desarrollo puntual
y tienes acceso a un workspace de archivos con control de versiones a través de las
herramientas disponibles (leer/escribir archivos, listar el directorio, y git status/
add/commit/diff). Si existen specs.md y/o design.md en el workspace, léelos antes de
escribir código. Trabaja de forma incremental: revisa el estado actual antes de
escribir si hace falta, aplica los cambios, y termina siempre confirmándolos con un
commit de git que describa lo que hiciste. Cuando ya hayas terminado, responde con un
resumen breve en texto plano, sin pedir más herramientas.`;

export const runDevAgent = createFilesystemAgent("Dev", DEV_SYSTEM_PROMPT);

export type RunDevAgentOptions = FilesystemAgentOptions;
