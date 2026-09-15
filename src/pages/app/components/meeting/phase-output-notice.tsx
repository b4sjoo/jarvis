export function PhaseOutputNotice({ notice }: { notice?: string }) {
  return notice ? (
    <p role="status" className="mb-2 min-w-0 break-words border-l-2 border-amber-500/60 pl-2 text-xs leading-5 text-muted-foreground">
      {notice}
    </p>
  ) : null;
}
