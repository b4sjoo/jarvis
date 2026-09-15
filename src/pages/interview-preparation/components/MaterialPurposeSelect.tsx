import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components";
import { interviewPreparationMaterialService } from "@/lib/preparation";
import type { PreparationMaterial, PreparationRetrievalPurpose } from "@/lib/preparation/types";
import { usePageOperation } from "../page-resource";

export function MaterialPurposeSelect({ material, readOnly, onChanged, onError }: {
  material: PreparationMaterial;
  readOnly: boolean;
  onChanged: (materialId?: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const operation = usePageOperation(JSON.stringify([material.workspaceId, material.id]));
  const change = async (value: string) => {
    const owns = operation.begin();
    setSaving(true);
    try {
      await interviewPreparationMaterialService.updatePurpose(material.workspaceId, material.id,
        value === "unlabelled" ? undefined : value as PreparationRetrievalPurpose);
      await onChanged(material.id);
    } catch (error) {
      if (owns()) onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (owns()) setSaving(false);
    }
  };
  return <Select value={material.purpose ?? "unlabelled"} disabled={readOnly || saving} onValueChange={(value) => void change(value)}>
    <SelectTrigger aria-label={`Purpose for ${material.displayName}`} className="mt-2 h-8 w-full min-w-0 text-xs [&>span]:truncate">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="unlabelled">Unlabelled</SelectItem>
      <SelectItem value="guidance">Guidance / interview info</SelectItem>
      <SelectItem value="personal-context">Personal profile / experience</SelectItem>
    </SelectContent>
  </Select>;
}
