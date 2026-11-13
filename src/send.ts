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
 * Sends one pending submission. The answers go first: the server then names exactly the photos it
 * still lacks, and only those are uploaded before the answers are sent again. So a retry over a
 * weak link never repeats photos that already arrived. A photo that is gone from the device or that
 * the server refuses is left out of the answers rather than holding them back; `save` keeps such a
 * change in the outbox. A storage failure on the device only postpones sending. On success the
 * photos are removed from the device.
 */
export async function sendSubmission(surveyId: string, outbox: Outbox, save: (o: Outbox) => void): Promise<SubmitResult> {
  const allIds = photoIdsIn(outbox.answers);
  for (let round = 0; round < 3; round++) {
    const r = await submitAnswers(surveyId, outbox.submissionId, outbox.surveyVersion, outbox.answers, outbox.code, outbox.noticeConfirmed);
    if (r.kind === 'stored') {
      await photoDb.remove(allIds);
      return r;
    }
    if (r.kind !== 'photo_missing') return r;
    let answers = outbox.answers;
    for (const id of r.photos) {
      if (!photoIdsIn(answers).includes(id)) continue;
      const blob = await photoDb.load(id);
      if (blob === 'error') return { kind: 'offline' };
      const up = blob === 'missing' ? { kind: 'invalid' as const } : await uploadPhoto(surveyId, id, blob, outbox.code);
      if (up.kind === 'offline') return { kind: 'offline' };
      if (up.kind === 'closed' || up.kind === 'not_yet_open' || up.kind === 'full') return { kind: up.kind };
      if (up.kind === 'code_unknown' || up.kind === 'code_required' || up.kind === 'course_closed') return { kind: up.kind };
      if (up.kind === 'invalid') answers = withoutPhoto(answers, id);
    }
    if (answers !== outbox.answers) {
      outbox = { ...outbox, answers };
      save(outbox);
    }
  }
  return { kind: 'offline' };
}
