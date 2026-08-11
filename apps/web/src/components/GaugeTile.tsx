/**
 * Reusable "instrument dial" stat tile — part of the design system
 * established in the design pass (see docs, App shell). Feature slices
 * should feed real data into this rather than building their own stat
 * visuals, so dashboard/meter-overview tiles stay visually consistent.
 */
const TONE_VAR: Record<NonNullable<GaugeTileProps["tone"]>, string> = {
  accent: "var(--color-accent)",
  good: "var(--color-good)",
  warn: "var(--color-warn)",
  danger: "var(--color-danger)",
};

export interface GaugeTileProps {
  label: string;
  value: number;
  max: number;
  unit?: string;
  tone?: "accent" | "good" | "warn" | "danger";
}

export default function GaugeTile({ label, value, max, unit, tone = "accent" }: GaugeTileProps) {
  const size = 96;
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const dash = circumference * pct;
  const tickCount = 12;

  return (
    <div className="border border-border bg-surface p-4 flex flex-col items-center gap-3">
      <div className="label-plate">{label}</div>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          {Array.from({ length: tickCount }).map((_, i) => {
            const angle = (i / tickCount) * 2 * Math.PI;
            const rInner = r + stroke / 2 + 2;
            const rOuter = r + stroke / 2 + 5;
            return (
              <line
                key={i}
                x1={size / 2 + rInner * Math.cos(angle)}
                y1={size / 2 + rInner * Math.sin(angle)}
                x2={size / 2 + rOuter * Math.cos(angle)}
                y2={size / 2 + rOuter * Math.sin(angle)}
                stroke="var(--color-border)"
                strokeWidth={1}
              />
            );
          })}
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-border)" strokeWidth={stroke} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={TONE_VAR[tone]}
            strokeWidth={stroke}
            strokeDasharray={`${dash} ${circumference - dash}`}
            strokeLinecap="butt"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center font-mono">
          <span className="text-xl leading-none">{value}</span>
          {unit && <span className="text-muted text-xs ml-1">{unit}</span>}
        </div>
      </div>
    </div>
  );
}
