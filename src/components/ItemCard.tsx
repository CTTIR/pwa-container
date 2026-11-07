import type { AnswerValue, Answers, Item, SurveyDefinition } from '../../shared/schema.ts';
import { DEFAULT_TEXT_MAX } from '../../shared/schema.ts';
import type { Strings } from '../i18n.ts';
import { Inline, stripMarkers } from './RichText.tsx';
import { radioKeyDown, ScaleButtons } from './ScaleButtons.tsx';

interface Props {
  def: SurveyDefinition;
  item: Item;
  answers: Answers;
  missing: Set<string>;
  onAnswer: (key: string, value: AnswerValue | undefined) => void;
  t: Strings;
}

const errorId = (key: string) => `err-${key}`;

/** Space-separated ids for aria-describedby, or undefined when there are none. */
function ids(...list: (string | false | undefined)[]): string | undefined {
  const out = list.filter(Boolean).join(' ');
  return out || undefined;
}

function FieldError({ fieldKey, t }: { fieldKey: string; t: Strings }) {
  return <p className="item-error" id={errorId(fieldKey)}>{t.fieldRequired}</p>;
}

export function ItemCard({ def, item, answers, missing, onAnswer, t }: Props) {
  const keys = item.type === 'matrix' ? item.columns.map((c) => `${item.id}_${c.id}`) : [item.id];
  const invalid = keys.some((k) => missing.has(k));
  const headingId = `q-${item.id}`;
  const hintId = item.hint ? `hint-${item.id}` : undefined;
  const label = stripMarkers(item.text);
  const required = item.required === true;
  const isMissing = missing.has(item.id);
  return (
    <section className={`item-card${invalid ? ' is-invalid' : ''}`} aria-labelledby={headingId} id={`item-${item.id}`}>
      <h3 className="item-text" id={headingId}>
        <Inline text={item.text} />
        {!item.required && <span className="item-optional"> ({t.optional})</span>}
      </h3>
      {item.hint && <p className="item-hint" id={hintId}>{item.hint}</p>}
      {item.type === 'scale' && (
        <>
          <ScaleButtons
            scale={def.scales[item.scale]}
            value={answers[item.id] as number | string | undefined}
            onChange={(v) => onAnswer(item.id, v)}
            label={label}
            invalid={isMissing}
            required={required}
            describedBy={ids(hintId, isMissing && errorId(item.id))}
          />
          {isMissing && <FieldError fieldKey={item.id} t={t} />}
        </>
      )}
      {item.type === 'matrix' &&
        item.columns.map((c) => {
          const key = `${item.id}_${c.id}`;
          const rowMissing = missing.has(key);
          return (
            <div key={c.id} className={`matrix-row${rowMissing ? ' is-invalid' : ''}`}>
              <div className="matrix-label">{c.label}</div>
              <ScaleButtons
                scale={def.scales[item.scale]}
                value={answers[key] as number | string | undefined}
                onChange={(v) => onAnswer(key, v)}
                label={`${label} – ${c.label}`}
                invalid={rowMissing}
                required={required}
                describedBy={ids(hintId, rowMissing && errorId(key))}
              />
              {rowMissing && <FieldError fieldKey={key} t={t} />}
            </div>
          );
        })}
      {item.type === 'text' && (
        <>
          <TextField
            item={item}
            value={answers[item.id]}
            onChange={(v) => onAnswer(item.id, v)}
            t={t}
            label={label}
            invalid={isMissing}
            describedBy={ids(hintId, isMissing && errorId(item.id))}
          />
          {isMissing && <FieldError fieldKey={item.id} t={t} />}
        </>
      )}
      {item.type === 'choice' && (
        <>
          <ChoiceButtons
            item={item}
            value={answers[item.id]}
            onChange={(v) => onAnswer(item.id, v)}
            headingId={headingId}
            invalid={isMissing}
            describedBy={ids(hintId, isMissing && errorId(item.id))}
          />
          {isMissing && <FieldError fieldKey={item.id} t={t} />}
        </>
      )}
    </section>
  );
}

function ChoiceButtons({
  item,
  value,
  onChange,
  headingId,
  invalid,
  describedBy,
}: {
  item: Extract<Item, { type: 'choice' }>;
  value: AnswerValue | undefined;
  onChange: (v: AnswerValue | undefined) => void;
  headingId: string;
  invalid: boolean;
  describedBy: string | undefined;
}) {
  const multiple = item.multiple === true;
  const selectedIndex = multiple ? -1 : item.options.findIndex((o) => o === value);
  // Single choice is a radiogroup with one tab stop; multiple choice is a group of checkboxes.
  const tabStop = selectedIndex >= 0 ? selectedIndex : 0;
  return (
    <div
      className="choices"
      role={multiple ? 'group' : 'radiogroup'}
      aria-labelledby={headingId}
      aria-required={!multiple && item.required ? true : undefined}
      aria-invalid={!multiple && invalid ? true : undefined}
      aria-describedby={describedBy}
    >
      {item.options.map((o, i) => {
        const selected = multiple ? Array.isArray(value) && value.includes(o) : value === o;
        return (
          <button
            key={o}
            type="button"
            role={multiple ? 'checkbox' : 'radio'}
            aria-checked={selected}
            tabIndex={multiple || i === tabStop ? 0 : -1}
            className={`choice-btn${selected ? ' is-selected' : ''}`}
            onClick={() => {
              if (!multiple) {
                onChange(o);
                return;
              }
              const list = Array.isArray(value) ? value : [];
              const next = selected ? list.filter((x) => x !== o) : [...list, o];
              onChange(next.length ? next : undefined);
            }}
            onKeyDown={multiple ? undefined : (e) => radioKeyDown(e, i, item.options.length, (j) => onChange(item.options[j]))}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

function TextField({
  item,
  value,
  onChange,
  t,
  label,
  invalid,
  describedBy,
}: {
  item: Extract<Item, { type: 'text' }>;
  value: AnswerValue | undefined;
  onChange: (v: string | undefined) => void;
  t: Strings;
  label: string;
  invalid: boolean;
  describedBy: string | undefined;
}) {
  const max = item.maxLength ?? DEFAULT_TEXT_MAX;
  const text = typeof value === 'string' ? value : '';
  const common = {
    className: 'text-input',
    value: text,
    maxLength: max,
    placeholder: item.placeholder,
    'aria-label': label,
    'aria-required': item.required ? true : undefined,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value === '' ? undefined : e.target.value),
  };
  return (
    <div className="text-field">
      {item.multiline ? <textarea rows={5} {...common} /> : <input type="text" {...common} />}
      <div className="text-count">{t.chars(text.length, max)}</div>
    </div>
  );
}
