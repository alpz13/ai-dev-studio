/**
 * Generates a readable, stable featureId from the user's natural-language
 * request, without needing to call Claude for it — it's deterministic
 * logic, so the Director resolves it itself.
 */

const COMBINING_DIACRITICAL_MARKS = /[̀-ͯ]/g;

// A regex trailing-dash trim (`/-+$/`) has no start anchor, so an engine
// using backtracking retries the match at every position in the string —
// quadratic time on an adversarial input (e.g. a long run of dashes not
// already at the very end). A plain backward scan is linear and avoids the
// pattern entirely rather than just making it harder to trigger.
function trimTrailingDashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "-") end--;
  return s.slice(0, end);
}

export function slugify(text: string): string {
  return trimTrailingDashes(
    text
      .normalize("NFD")
      .replace(COMBINING_DIACRITICAL_MARKS, "") // strips accents/diaereses via NFD (á -> a, ñ -> n, mañana -> manana)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 60),
  );
}

/** `now` is injectable so this is deterministic in tests. */
export function generateFeatureId(task: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const slug = slugify(task) || "feature";
  return `feat_${date}_${slug}`;
}

const FEATURE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/**
 * Guards against path traversal: featureId is used to build filesystem
 * paths in FeatureStateStore and TraceLogger, so anything outside this
 * slug shape must be rejected before it reaches a path.join() call.
 */
export function isValidFeatureId(featureId: string): boolean {
  return FEATURE_ID_PATTERN.test(featureId);
}
