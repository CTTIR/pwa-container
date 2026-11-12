import { useRef } from 'react';
import type { Scale, ScaleAnchors } from '../../shared/schema.ts';
import type { Strings } from '../i18n.ts';
import { Inline, stripMarkers } from './RichText.tsx';

interface Props {
  scale: Scale;
  anchors: ScaleAnchors;
  value: number | string | undefined;
  onChange: (value: number | string | undefined) => void;
  label: string;
  t: Strings;
  invalid?: boolean;
  required?: boolean;
  describedBy?: string;
}

/**
 * A slider over the integer options of a scale (e.g. 0 … 5), every value marked and tappable
 * under the track, with a word at each end. Until it is touched the slider has no value: the
 * thumb is hidden, so a resting thumb in the middle is never mistaken for an answer.
 */
export function ScaleSlider({ scale, anchors, value, onChange, label, t, invalid, required, describedBy }: Props) {
  const min = scale.options[0].value;
  const max = scale.options[scale.options.length - 1].value;
  const na = scale.notApplicable;
  const rated = typeof value === 'number';
  const isNa = na !== undefined && value === na.value;
  const input = useRef<HTMLInputElement>(null);
  const step = scale.step ?? 1;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  const position = rated ? (value as number) : Math.round((min + max) / 2);
  const optionLabel = (v: number) => scale.options.find((o) => o.value === v)?.label ?? '';
  const snap = (v: number) => Number((Math.round((v - min) / step) * step + min).toFixed(decimals));
  const pick = (v: number) => onChange(snap(Math.min(max, Math.max(min, v))));
  const show = (v: number) => v.toLocaleString(document.documentElement.lang || 'de', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  // The words of the nearest marked value describe a continuous rating.
  const describe = (v: number) => `${show(v)} – ${stripMarkers(optionLabel(Math.round(v)))}`;
  // Take the value under the finger on release: a tap on the resting thumb of an unrated slider
  // fires no input event, and iOS Safari does not move the thumb on a tap on the track at all.
  const settle = (clientX: number) => {
    const el = input.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const thumb = parseFloat(getComputedStyle(el).getPropertyValue('--thumb')) || 30;
    const span = r.width - thumb;
    if (span <= 0) return;
    const frac = Math.min(1, Math.max(0, (clientX - r.left - thumb / 2) / span));
    pick(min + frac * (max - min));
  };
  const name = stripMarkers(label);
  return (
    <div className={`slider${rated ? ' is-rated' : ' is-unrated'}${isNa ? ' is-na' : ''}`}>
      <div className="slider-ends" aria-hidden="true">
        <span className="slider-end slider-end-min"><b>{min}</b> <Inline text={anchors.min} /></span>
        <span className="slider-end slider-end-max"><Inline text={anchors.max} /> <b>{max}</b></span>
      </div>
      <input
        ref={input}
        type="range"
        className="slider-input"
        min={min}
        max={max}
        step={step}
        value={position}
        aria-label={`${name} (${min} = ${stripMarkers(anchors.min)}, ${max} = ${stripMarkers(anchors.max)})`}
        aria-valuetext={rated ? describe(value as number) : isNa ? stripMarkers(na!.label) : t.notRated}
        aria-required={required || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => pick(Number(e.target.value))}
        onPointerUp={(e) => settle(e.clientX)}
        onKeyUp={(e) => {
          if (!rated && (e.key === 'Enter' || e.key === ' ')) pick(position);
        }}
      />
      <div className="slider-ticks" aria-hidden="true">
        {scale.options.map((o) => (
          <button
            key={o.value}
            type="button"
            tabIndex={-1}
            className={`slider-tick${rated && value === o.value ? ' is-selected' : ''}`}
            title={stripMarkers(o.label)}
            onClick={() => pick(o.value)}
          >
            {o.value}
          </button>
        ))}
      </div>
      <div className="slider-foot">
        <span className="slider-value" aria-live="polite">
          {rated ? t.ratedAs(show(value as number)) : isNa ? stripMarkers(na!.label) : t.notRated}
        </span>
        <span className="slider-actions">
          {na && (
            <button
              type="button"
              className={`btn slider-na${isNa ? ' is-selected' : ''}`}
              aria-pressed={isNa}
              onClick={() => onChange(isNa ? undefined : na.value)}
            >
              {na.label}
            </button>
          )}
          {(rated || isNa) && (
            <button type="button" className="btn btn-link slider-clear" onClick={() => onChange(undefined)}>
              {t.clearRating}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
