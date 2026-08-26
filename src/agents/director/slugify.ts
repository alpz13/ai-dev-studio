/**
 * Generates a readable, stable featureId from the user's natural-language
 * request, without needing to call Claude for it — it's deterministic
 * logic, so the Director resolves it itself.
 */

const COMBINING_DIACRITICAL_MARKS = /[̀-ͯ]/g;

export function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(COMBINING_DIACRITICAL_MARKS, "") // strips accents/diaereses via NFD (á -> a, ñ -> n, mañana -> manana)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

/** `now` is injectable so this is deterministic in tests. */
export function generateFeatureId(task: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const slug = slugify(task) || "feature";
  return `feat_${date}_${slug}`;
}
