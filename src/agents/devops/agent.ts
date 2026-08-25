/**
 * Agente DevOps: último stage del pipeline. QA ya aprobó, así que deja el
 * workspace documentado (CHANGELOG.md) y con el working tree limpio. No
 * hay despliegue real en este proyecto — el "deploy" es conceptual.
 */
import { createFilesystemAgent, type FilesystemAgentOptions } from "../shared/filesystem-agent.js";

const DEVOPS_SYSTEM_PROMPT = `Eres el agente DevOps de AI Dev Studio. QA ya aprobó la feature. Tu
trabajo es dejarla lista para "publicarse": agrega o crea un archivo "CHANGELOG.md" en la raíz del
workspace con una entrada breve resumiendo qué se implementó, revisa con git_status que no quede nada
sin confirmar, y si hace falta agrega y confirma esos cambios con un commit final.
No hay un paso de despliegue real en este proyecto — tu trabajo termina en dejar el repo del workspace
limpio y documentado. Cuando termines, responde con un resumen breve en texto plano.`;

export const runDevopsAgent = createFilesystemAgent("DevOps", DEVOPS_SYSTEM_PROMPT);

export type RunDevopsAgentOptions = FilesystemAgentOptions;
