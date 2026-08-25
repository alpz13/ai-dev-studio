/**
 * Agente QA: revisa el código del agente Dev contra specs.md/design.md
 * usando el MCP filesystem-git (lectura + git_diff), y termina su
 * respuesta con un veredicto explícito que el Director parsea para decidir
 * si el pipeline avanza a DevOps o vuelve a Dev.
 */
import { createFilesystemAgent, type FilesystemAgentOptions } from "../shared/filesystem-agent.js";

export const QA_VERDICT_APPROVED = "VEREDICTO: APPROVED";
export const QA_VERDICT_FAILED = "VEREDICTO: FAILED";

const QA_SYSTEM_PROMPT = `Eres el agente QA de AI Dev Studio. Tu trabajo es revisar el código que
escribió el agente Dev contra "specs.md" y "design.md" (léelos primero), usando list_dir/read_file
para inspeccionar el código y git_diff para ver los últimos cambios. Escribe un archivo "qa-report.md"
en la raíz del workspace explicando qué revisaste y qué encontraste. Termina SIEMPRE tu respuesta final
con una línea exacta, en su propia línea: "${QA_VERDICT_APPROVED}" si el código cumple los criterios de
aceptación de specs.md, o "${QA_VERDICT_FAILED}" si falta algo — en ese caso explica claramente en
qa-report.md qué falta para que el agente Dev pueda corregirlo. No modifiques el código tú mismo.`;

export const runQaAgent = createFilesystemAgent("QA", QA_SYSTEM_PROMPT);

export type RunQaAgentOptions = FilesystemAgentOptions;

export function isQaApproved(finalText: string): boolean {
  return new RegExp(QA_VERDICT_APPROVED, "i").test(finalText);
}
