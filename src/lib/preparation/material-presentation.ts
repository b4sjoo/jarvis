import type { PreparationMaterial } from "./types.js";

export function materialsForActiveRound(
  materials: PreparationMaterial[],
  activeRoundId: string | undefined
) {
  return materials.filter(
    (material) =>
      material.scope.kind === "workspace" ||
      material.scope.roundId === activeRoundId
  );
}

export function formatPreparationMaterialType(material: PreparationMaterial) {
  switch (material.extension?.toLowerCase()) {
    case "md":
    case "markdown":
      return "Markdown";
    case "txt":
      return "Text";
    case "jpg":
    case "jpeg":
      return "JPEG";
    default:
      return material.extension?.toUpperCase() ?? material.mimeType;
  }
}
