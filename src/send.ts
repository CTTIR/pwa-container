import type { Answers } from '../shared/schema.ts';
import { submitAnswers, uploadPhoto, type SubmitResult } from './api.ts';
import { photoDb, photoIdsIn } from './photos.ts';
import type { Outbox } from './storage.ts';

/** The answers without one photo id (an emptied photo field is dropped). */
function withoutPhoto(answers: Answers, id: string): Answers {
  const out: Answers = {};
  for (const [k, v] of Object.entries(answers)) {
    if (Array.isArray(v) && v.includes(id)) {
      const rest = v.filter((x) => x !== id);
      if (rest.length) out[k] = rest;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Sends one pending submission: first its photos (each one once the server lacks it), then the
 * answers. A photo that is gone from the device or that the server refuses is left out of the
 * answers rather than holding them back. `save` keeps such a change in the outbox. On success the
 * photos are removed from the device.
 */
export async function sendSubmission(surveyId: string, outbox: Outbox, save: (o: Outbox) => void): Promise<SubmitResult> {
  let missing: string[] | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let answers = outbox.answers;
    const ids = photoIdsIn(answers);
    for (const id of ids) {
      if (missing && !missing.includes(id)) continue;
      const blob = await photoDb.get(id);
      const up = blob ? await uploadPhoto(surveyId, id, blob, outbox.code) : { kind: 'invalid' as const };
      if (up.kind === 'offline') return { kind: 'offline' };
      if (up.kind === 'closed' || up.kind === 'not_yet_open' || up.kind === 'full') return { kind: up.kind };
      if (up.kind === 'code_unknown' || up.kind === 'code_required' || up.kind === 'course_closed') return { kind: up.kind };
      if (up.kind === 'invalid') answers = withoutPhoto(answers, id);
    }
    if (answers !== outbox.answers) {
      outbox = { ...outbox, answers };
      save(outbox);
    }
    const r = await submitAnswers(surveyId, outbox.submissionId, outbox.surveyVersion, outbox.answers, outbox.code, outbox.noticeConfirmed);
    if (r.kind === 'stored') {
      await photoDb.remove(ids);
      return r;
    }
    if (r.kind !== 'photo_missing') return r;
    missing = r.photos;
  }
  return { kind: 'offline' };
}
