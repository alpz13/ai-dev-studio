/**
 * Genera un featureId legible y estable a partir del pedido en lenguaje
 * natural del usuario, sin necesidad de llamar a Claude para eso — es
 * lógica determinista, así que el Director la resuelve él mismo.
 */

const COMBINING_DIACRITICAL_MARKS = /[̀-ͯ]/g;

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(COMBINING_DIACRITICAL_MARKS, "") // quita acentos y diéresis vía NFD (á -> a, ñ -> n, mañana -> manana)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** `now` es inyectable para que esto sea determinista en pruebas. */
export function generateFeatureId(task: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const slug = slugify(task) || "feature";
  return `feat_${date}_${slug}`;
}
