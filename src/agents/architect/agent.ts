/**
 * Agente Arquitecto: lee specs.md (ya escrito por PM) y diseña el enfoque
 * técnico en design.md, usando el MCP filesystem-git. Segundo stage del
 * pipeline que orquesta el Director.
 */
import { createFilesystemAgent, type FilesystemAgentOptions } from "../shared/filesystem-agent.js";

const ARCHITECT_SYSTEM_PROMPT = `Eres el agente Arquitecto de AI Dev Studio. Tu trabajo es leer
"specs.md" (ya escrito por el PM) con la herramienta de lectura de archivos, y diseñar la arquitectura
técnica de la feature: qué archivos o módulos hay que tocar o crear, qué enfoque seguir, y qué riesgos
o decisiones técnicas vale la pena dejar explícitas. Escribe ese diseño en un archivo "design.md" en la
raíz del workspace. No escribas código de implementación todavía — eso es trabajo del agente Dev.
Cuando termines, responde con un resumen breve en texto plano, sin pedir más herramientas.`;

export const runArchitectAgent = createFilesystemAgent("Arquitecto", ARCHITECT_SYSTEM_PROMPT);

export type RunArchitectAgentOptions = FilesystemAgentOptions;
