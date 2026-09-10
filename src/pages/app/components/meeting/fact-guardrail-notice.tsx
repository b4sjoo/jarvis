import type { MeetingFocusSnapshot } from "@/lib/meeting/focus-window";

export function FactGuardrailNotice({ notice }: { notice: MeetingFocusSnapshot["factGuardrailNotice"] }) {
  return notice ? (
    <div role="note" className="mb-2 rounded-sm border border-amber-500/50 bg-amber-500/10 px-2 py-1.5 text-[10px] font-semibold leading-4 text-amber-900 dark:text-amber-200">
      {notice.message}
    </div>
  ) : null;
}
