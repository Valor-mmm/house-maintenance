const DOT_VAR: Record<NonNullable<StatusRowProps["tone"]>, string> = {
  accent: "var(--color-accent)",
  good: "var(--color-good)",
  warn: "var(--color-warn)",
  danger: "var(--color-danger)",
  muted: "var(--color-text-muted)",
};

export interface StatusRowProps {
  title: string;
  meta?: string;
  tone?: "accent" | "good" | "warn" | "danger" | "muted";
  trailing?: string;
}

/** A single "readout" line — used by Dashboard's needs-attention list and task/reading history lists. */
export default function StatusRow({ title, meta, tone = "muted", trailing }: StatusRowProps) {
  return (
    <div className="flex items-center gap-3 py-3">
      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: DOT_VAR[tone] }} />
      <div className="flex-1 min-w-0">
        <div className="truncate">{title}</div>
        {meta && <div className="label-plate mt-0.5">{meta}</div>}
      </div>
      {trailing && <div className="font-mono text-sm text-muted shrink-0">{trailing}</div>}
    </div>
  );
}
