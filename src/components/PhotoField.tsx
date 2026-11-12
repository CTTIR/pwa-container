import { useEffect, useRef, useState } from 'react';
import type { AnswerValue } from '../../shared/schema.ts';
import { DEFAULT_PHOTO_MAX } from '../../shared/schema.ts';
import type { Strings } from '../i18n.ts';
import { newPhotoId, photoDb, photosAvailable, preparePhoto } from '../photos.ts';

interface Props {
  surveyId: string;
  fieldKey: string;
  max?: number;
  /** Accessible name of the question the photos belong to. */
  label: string;
  value: AnswerValue | undefined;
  onChange: (v: AnswerValue | undefined) => void;
  t: Strings;
  /** Show only the add button until a photo exists (under a scale item). */
  compact?: boolean;
}

/** Photos of one question: previews with a remove button, and a button to take or pick more. */
export function PhotoField({ surveyId, fieldKey, max = DEFAULT_PHOTO_MAX, label, value, onChange, t, compact }: Props) {
  const ids = Array.isArray(value) ? value : [];
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(ids);
  latest.current = ids;

  // Previews from the device store; object URLs are released when no longer shown.
  useEffect(() => {
    let cancelled = false;
    const made: string[] = [];
    void (async () => {
      const next: Record<string, string> = {};
      for (const id of ids) {
        const blob = await photoDb.get(id);
        if (blob) {
          const u = URL.createObjectURL(blob);
          made.push(u);
          next[id] = u;
        }
      }
      if (!cancelled) setUrls(next);
    })();
    return () => {
      cancelled = true;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [ids.join(',')]);

  const add = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    if (!(await photosAvailable())) {
      setError(t.photoUnavailable);
      return;
    }
    setBusy(true);
    let list = [...latest.current];
    try {
      for (const file of Array.from(files)) {
        if (list.length >= max) {
          setError(t.photoLimit(max));
          break;
        }
        let blob: Blob;
        try {
          blob = await preparePhoto(file);
        } catch {
          setError(t.photoFailed);
          continue;
        }
        const id = newPhotoId();
        if (!(await photoDb.save(surveyId, id, blob))) {
          setError(t.photoUnavailable);
          break;
        }
        list = [...list, id];
        onChange(list);
      }
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const remove = (id: string) => {
    const rest = latest.current.filter((x) => x !== id);
    onChange(rest.length ? rest : undefined);
    void photoDb.remove([id]);
  };

  const canAdd = ids.length < max;
  const inputId = `photo-${fieldKey}`;
  return (
    <div className={`photo-field${compact && ids.length === 0 ? ' is-compact' : ''}`}>
      {ids.length > 0 && (
        <ul className="photo-list" aria-label={`${t.photos}: ${label}`}>
          {ids.map((id, i) => (
            <li key={id} className="photo-thumb">
              {urls[id] ? <img src={urls[id]} alt={t.photoN(i + 1)} /> : <span className="photo-missing">{t.photoN(i + 1)}</span>}
              <button type="button" className="photo-remove" onClick={() => remove(id)} aria-label={t.photoRemove(i + 1)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <>
          <input
            ref={input}
            id={inputId}
            className="photo-input"
            type="file"
            accept="image/*"
            multiple={max - ids.length > 1}
            onChange={(e) => void add(e.target.files)}
            disabled={busy}
          />
          <label htmlFor={inputId} className={`btn btn-link photo-add${busy ? ' is-busy' : ''}`} aria-disabled={busy || undefined}>
            {busy ? t.photoBusy : ids.length ? t.photoMore : t.photoAdd}
          </label>
        </>
      )}
      {!canAdd && !error && <span className="photo-note">{t.photoLimit(max)}</span>}
      {error && (
        <p className="item-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
