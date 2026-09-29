import { AlertTriangleIcon, Loader2Icon } from "lucide-react";
import type { FactRiskReviewResult } from "@/lib/meeting/types";

export function FactRiskNotice({ result }: { result?: FactRiskReviewResult }) {
  if (!result) return null;
  const label = result.status === "pending" ? "核实中" : result.status === "failed" ? "核实未完成"
    : result.status === "skipped" ? "未核实" : result.flags.length ? "待核实" : "本次未检出需核实内容";
  return <div className="mt-2 min-w-0 border-t border-border/60 pt-2 text-xs" data-fact-risk-review>
    <div role="status" className="flex items-center gap-1 text-muted-foreground" title={result.reason}>
      {result.status === "pending" ? <Loader2Icon className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
        : result.flags.length ? <AlertTriangleIcon className="h-3 w-3 shrink-0 text-amber-600" aria-hidden="true" /> : null}
      <span>{label}</span>
    </div>
    {result.flags.length ? <ul className="mt-1 space-y-2">
      {result.flags.map((flag, index) => <li key={index} className="min-w-0 break-words">
        <q className="font-medium">{flag.quote}</q>
        <p className="mt-0.5 text-muted-foreground">{flag.reason}</p>
      </li>)}
    </ul> : null}
  </div>;
}
