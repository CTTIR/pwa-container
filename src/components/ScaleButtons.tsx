import type { Scale } from '../../shared/schema.ts';

interface Props {
  scale: Scale;
  value: number | string | undefined;
  onChange: (value: number | string) => void;
  label: string;
  invalid?: boolean;
}

/** One row of scale buttons (1 … n) plus an optional "not applicable" button. */
export function ScaleButtons({ scale, value, onChange, label, invalid }: Props) {
  const first = scale.options[0];
  const last = scale.options[scale.options.length - 1];
  return (
    <div className="scale">
      <div className="scale-row" role="radiogroup" aria-label={label} aria-invalid={invalid || undefined}>
        {scale.options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            aria-label={`${o.value} – ${o.label}`}
            title={o.label}
            className={`scale-btn${value === o.value ? ' is-selected' : ''}`}
            onClick={() => onChange(o.value)}
          >
            {o.value}
          </button>
        ))}
        {scale.notApplicable && (
          <button
            type="button"
            role="radio"
            aria-checked={value === scale.notApplicable.value}
            aria-label={scale.notApplicable.label}
            title={scale.notApplicable.label}
            className={`scale-btn scale-na${value === scale.notApplicable.value ? ' is-selected' : ''}`}
            onClick={() => onChange(scale.notApplicable!.value)}
          >
            {scale.notApplicable.value}
          </button>
        )}
      </div>
      <div className="scale-ends" aria-hidden="true">
        <span>{first.label}</span>
        <span>{last.label}</span>
      </div>
    </div>
  );
}
