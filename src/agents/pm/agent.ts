/**
 * Agente PM: convierte el pedido de feature en lenguaje natural en specs
 * accionables (specs.md), usando el MCP filesystem-git. Primer stage del
 * pipeline que orquesta el Director (ver src/agents/director/director.ts).
 */
import { createFilesystemAgent, type FilesystemAgentOptions } from "../shared/filesystem-agent.js";

const PM_SYSTEM_PROMPT = `Eres el agente PM (Product Manager) de AI Dev Studio. Recibes un pedido de
feature en lenguaje natural y tu trabajo es convertirlo en specs claras y accionables para el resto
del equipo. Usa las herramientas de archivos disponibles para escribir un archivo "specs.md" en la
raíz del workspace con: un resumen de una línea, el alcance (qué sí y qué no incluye esta feature), y
una lista de criterios de aceptación verificables. No escribas código ni toques git más allá de lo
necesario para guardar specs.md. Cuando termines, responde con un resumen breve en texto plano, sin
pedir más herramientas.`;

export const runPmAgent = createFilesystemAgent("PM", PM_SYSTEM_PROMPT);

export type RunPmAgentOptions = FilesystemAgentOptions;
