import type { AnswerValue, Answers, Item, SurveyDefinition } from '../../shared/schema.ts';
import { DEFAULT_TEXT_MAX } from '../../shared/schema.ts';
import type { Strings } from '../i18n.ts';
import { Inline } from './RichText.tsx';
import { ScaleButtons } from './ScaleButtons.tsx';

interface Props {
  def: SurveyDefinition;
  item: Item;
  answers: Answers;
  missing: Set<string>;
  onAnswer: (key: string, value: AnswerValue | undefined) => void;
  t: Strings;
}

export function ItemCard({ def, item, answers, missing, onAnswer, t }: Props) {
  const keys = item.type === 'matrix' ? item.columns.map((c) => `${item.id}_${c.id}`) : [item.id];
  const invalid = keys.some((k) => missing.has(k));
  const headingId = `q-${item.id}`;
  return (
    <section className={`item-card${invalid ? ' is-invalid' : ''}`} aria-labelledby={headingId} id={`item-${item.id}`}>
      <h3 className="item-text" id={headingId}>
        <Inline text={item.text} />
        {!item.required && <span className="item-optional"> ({t.optional})</span>}
      </h3>
      {item.hint && <p className="item-hint">{item.hint}</p>}
      {item.type === 'scale' && (
        <ScaleButtons
          scale={def.scales[item.scale]}
          value={answers[item.id] as number | string | undefined}
          onChange={(v) => onAnswer(item.id, v)}
          label={item.text}
          invalid={invalid}
        />
      )}
      {item.type === 'matrix' &&
        item.columns.map((c) => {
          const key = `${item.id}_${c.id}`;
          return (
            <div key={c.id} className={`matrix-row${missing.has(key) ? ' is-invalid' : ''}`}>
              <div className="matrix-label">{c.label}</div>
              <ScaleButtons
                scale={def.scales[item.scale]}
                value={answers[key] as number | string | undefined}
                onChange={(v) => onAnswer(key, v)}
                label={`${item.text} – ${c.label}`}
                invalid={missing.has(key)}
              />
            </div>
          );
        })}
      {item.type === 'text' && <TextField item={item} value={answers[item.id]} onChange={(v) => onAnswer(item.id, v)} t={t} />}
      {item.type === 'choice' && (
        <div className="choices" role={item.multiple ? 'group' : 'radiogroup'} aria-labelledby={headingId}>
          {item.options.map((o) => {
            const current = answers[item.id];
            const selected = item.multiple ? Array.isArray(current) && current.includes(o) : current === o;
            return (
              <button
                key={o}
                type="button"
                role={item.multiple ? 'checkbox' : 'radio'}
                aria-checked={selected}
                className={`choice-btn${selected ? ' is-selected' : ''}`}
                onClick={() => {
                  if (!item.multiple) {
                    onAnswer(item.id, o);
                    return;
                  }
                  const list = Array.isArray(current) ? current : [];
                  const next = selected ? list.filter((x) => x !== o) : [...list, o];
                  onAnswer(item.id, next.length ? next : undefined);
                }}
              >
                {o}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TextField({
  item,
  value,
  onChange,
  t,
}: {
  item: Extract<Item, { type: 'text' }>;
  value: AnswerValue | undefined;
  onChange: (v: string | undefined) => void;
  t: Strings;
}) {
  const max = item.maxLength ?? DEFAULT_TEXT_MAX;
  const text = typeof value === 'string' ? value : '';
  const common = {
    className: 'text-input',
    value: text,
    maxLength: max,
    placeholder: item.placeholder,
    'aria-label': item.text,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value === '' ? undefined : e.target.value),
  };
  return (
    <div className="text-field">
      {item.multiline ? <textarea rows={5} {...common} /> : <input type="text" {...common} />}
      <div className="text-count">{t.chars(text.length, max)}</div>
    </div>
  );
}
