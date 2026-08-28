import { describe, expect, it } from "vitest";
import { generateFeatureId, isValidFeatureId, slugify } from "../../../agents/director/slugify.js";

describe("agents/director/slugify: slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("I want to export reports to CSV")).toBe("i-want-to-export-reports-to-csv");
  });

  it("strips accents and diaereses", () => {
    expect(slugify("Añadir soporte para mañana y niño")).toBe("anadir-soporte-para-manana-y-nino");
  });

  it("collapses symbols and punctuation into a single hyphen", () => {
    expect(slugify("¡Export to CSV!! (urgent)")).toBe("export-to-csv-urgent");
  });

  it("leaves no leading or trailing hyphens", () => {
    expect(slugify("   ---hello---   ")).toBe("hello");
  });

  it("text with nothing alphanumeric gives an empty string", () => {
    expect(slugify("¡¡¡ !!!")).toBe("");
  });

  it("trims to 60 characters", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });
});

describe("agents/director/slugify: generateFeatureId", () => {
  it("builds feat_<date>_<slug> with the given date", () => {
    const id = generateFeatureId("Export to CSV", new Date("2026-08-24T10:00:00Z"));
    expect(id).toBe("feat_2026-08-24_export-to-csv");
  });

  it("uses 'feature' as the slug if the task leaves nothing alphanumeric", () => {
    const id = generateFeatureId("¡¡¡ !!!", new Date("2026-08-24T10:00:00Z"));
    expect(id).toBe("feat_2026-08-24_feature");
  });

  it("two different tasks on the same day give different featureIds", () => {
    const now = new Date("2026-08-24T10:00:00Z");
    const a = generateFeatureId("Export to CSV", now);
    const b = generateFeatureId("Import from CSV", now);
    expect(a).not.toBe(b);
  });
});

describe("agents/director/slugify: isValidFeatureId", () => {
  it("accepts a normally generated featureId", () => {
    expect(isValidFeatureId("feat_2026-08-24_export-to-csv")).toBe(true);
  });

  it("rejects path traversal attempts", () => {
    expect(isValidFeatureId("../../etc/passwd")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidFeatureId("")).toBe(false);
  });

  it("rejects a value starting with a hyphen or underscore", () => {
    expect(isValidFeatureId("-feat_x")).toBe(false);
    expect(isValidFeatureId("_feat_x")).toBe(false);
  });

  it("rejects uppercase letters", () => {
    expect(isValidFeatureId("Feat_X")).toBe(false);
  });

  it("rejects a slash", () => {
    expect(isValidFeatureId("feat/x")).toBe(false);
  });
});
