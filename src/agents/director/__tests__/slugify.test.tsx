import { describe, expect, it } from "vitest";
import { generateFeatureId, slugify } from "../../../agents/director/slugify.js";

describe("agents/director/slugify: slugify", () => {
  it("pasa a minúsculas y reemplaza espacios por guiones", () => {
    expect(slugify("Quiero exportar reportes a CSV")).toBe("quiero-exportar-reportes-a-csv");
  });

  it("quita acentos y diéresis", () => {
    expect(slugify("Añadir soporte para mañana y niño")).toBe("anadir-soporte-para-manana-y-nino");
  });

  it("colapsa símbolos y puntuación en un solo guion", () => {
    expect(slugify("¡Exportar a CSV!! (urgente)")).toBe("exportar-a-csv-urgente");
  });

  it("no deja guiones al principio ni al final", () => {
    expect(slugify("   ---hola---   ")).toBe("hola");
  });

  it("un texto sin nada alfanumérico da string vacío", () => {
    expect(slugify("¡¡¡ !!!")).toBe("");
  });

  it("recorta a 60 caracteres", () => {
    const largo = "a".repeat(100);
    expect(slugify(largo).length).toBeLessThanOrEqual(60);
  });
});

describe("agents/director/slugify: generateFeatureId", () => {
  it("arma feat_<fecha>_<slug> con la fecha dada", () => {
    const id = generateFeatureId("Exportar a CSV", new Date("2026-08-24T10:00:00Z"));
    expect(id).toBe("feat_2026-08-24_exportar-a-csv");
  });

  it("usa 'feature' como slug si el task no deja nada alfanumérico", () => {
    const id = generateFeatureId("¡¡¡ !!!", new Date("2026-08-24T10:00:00Z"));
    expect(id).toBe("feat_2026-08-24_feature");
  });

  it("dos tasks distintos el mismo día dan featureIds distintos", () => {
    const now = new Date("2026-08-24T10:00:00Z");
    const a = generateFeatureId("Exportar a CSV", now);
    const b = generateFeatureId("Importar desde CSV", now);
    expect(a).not.toBe(b);
  });
});
