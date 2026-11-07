import type { Scale } from '../../shared/schema.ts';
import { Inline } from './RichText.tsx';

export function Legend({ scale }: { scale: Scale }) {
  return (
    <dl className="legend">
      {scale.options.map((o) => (
        <div key={o.value} className="legend-entry">
          <dt>{o.value}</dt>
          <dd><Inline text={o.label} /></dd>
        </div>
      ))}
      {scale.notApplicable && (
        <div className="legend-entry">
          <dt>{scale.notApplicable.value}</dt>
          <dd><Inline text={scale.notApplicable.label} /></dd>
        </div>
      )}
    </dl>
  );
}
