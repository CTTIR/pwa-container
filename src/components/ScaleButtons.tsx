import type { KeyboardEvent } from 'react';
import type { Scale } from '../../shared/schema.ts';
import { Inline, stripMarkers } from './RichText.tsx';

interface Props {
  scale: Scale;
  value: number | string | undefined;
  onChange: (value: number | string) => void;
  label: string;
  invalid?: boolean;
  required?: boolean;
  /** Ids of the hint and error texts that describe this group. */
  describedBy?: string;
}

/**
 * Arrow-key handling for a radiogroup of buttons (roving tabindex): Left/Up and Right/Down move
 * to the previous / next option and select it, Home/End jump to the first / last one.
 */
export function radioKeyDown(e: KeyboardEvent<HTMLElement>, index: number, count: number, select: (index: number) => void): void {
  let target: number;
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      target = (index + 1) % count;
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      target = (index - 1 + count) % count;
      break;
    case 'Home':
      target = 0;
      break;
    case 'End':
      target = count - 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  const radios = e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]');
  radios?.[target]?.focus();
  select(target);
}

/** One row of scale buttons (1 … n) plus an optional "not applicable" button. */
export function ScaleButtons({ scale, value, onChange, label, invalid, required, describedBy }: Props) {
  const first = scale.options[0];
  const last = scale.options[scale.options.length - 1];
  const na = scale.notApplicable;
  const values: (number | string)[] = [...scale.options.map((o) => o.value), ...(na ? [na.value] : [])];
  const selected = values.findIndex((v) => v === value);
  // Only one button of the group is in the tab order: the selected one, else the first.
  const tabStop = selected >= 0 ? selected : 0;
  const onKeyDown = (index: number) => (e: KeyboardEvent<HTMLButtonElement>) =>
    radioKeyDown(e, index, values.length, (i) => onChange(values[i]));
  return (
    <div className="scale">
      <div
        className="scale-row"
        role="radiogroup"
        aria-label={stripMarkers(label)}
        aria-required={required || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy || undefined}
      >
        {scale.options.map((o, i) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            aria-label={`${o.value} – ${stripMarkers(o.label)}`}
            title={stripMarkers(o.label)}
            tabIndex={i === tabStop ? 0 : -1}
            className={`scale-btn${value === o.value ? ' is-selected' : ''}`}
            onClick={() => onChange(o.value)}
            onKeyDown={onKeyDown(i)}
          >
            {o.value}
          </button>
        ))}
        {na && (
          <button
            type="button"
            role="radio"
            aria-checked={value === na.value}
            // The accessible name starts with the visible text ("NB – nicht beurteilbar").
            aria-label={`${na.value} – ${stripMarkers(na.label)}`}
            title={stripMarkers(na.label)}
            tabIndex={values.length - 1 === tabStop ? 0 : -1}
            className={`scale-btn scale-na${value === na.value ? ' is-selected' : ''}`}
            onClick={() => onChange(na.value)}
            onKeyDown={onKeyDown(values.length - 1)}
          >
            {na.value}
          </button>
        )}
      </div>
      <div className="scale-ends" aria-hidden="true">
        <span><Inline text={first.label} /></span>
        <span><Inline text={last.label} /></span>
      </div>
    </div>
  );
}
