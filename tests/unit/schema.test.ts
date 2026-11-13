import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { compactAnswers, fieldsOf, surveyStatus, validateAnswers, validateDefinition, type SurveyDefinition } from '../../shared/schema.ts';

const example = JSON.parse(
  fs.readFileSync(new URL('../../examples/surveys/example-course-feedback/survey.json', import.meta.url), 'utf8'),
) as SurveyDefinition;

describe('survey definitions', () => {
  it('accepts the shipped example', () => {
    expect(validateDefinition(example)).toEqual([]);
  });

  it('expands matrix rows into one field per column', () => {
    expect(fieldsOf(example).map((f) => f.key)).toEqual(['C01', 'C02', 'C03_PRE', 'C03_POST', 'C04', 'O01']);
  });

  it('rejects unknown scales, duplicate keys and bad ids', () => {
    const broken = structuredClone(example) as unknown as Record<string, unknown>;
    const sections = broken.sections as { items: Record<string, unknown>[] }[];
    sections[0].items[0].scale = 'missing';
    sections[0].items[1].id = 'C01';
    broken.id = 'Not Valid';
    const errors = validateDefinition(broken);
    expect(errors.some((e) => e.includes('unknown scale'))).toBe(true);
    expect(errors.some((e) => e.includes('duplicated'))).toBe(true);
    expect(errors.some((e) => e.startsWith('id must match'))).toBe(true);
  });
});

describe('answers', () => {
  const complete = { C01: 4, C02: 'NA', C03_PRE: 2, C03_POST: 5, C04: ['Lectures'], O01: 'More breaks.' };

  it('accepts a complete answer set', () => {
    expect(validateAnswers(example, complete)).toEqual({});
  });

  it('reports missing required answers, unknown keys and invalid values', () => {
    const problems = validateAnswers(example, { C01: 9, C03_PRE: 2, X: 1, C04: ['Nope'] });
    expect(problems).toMatchObject({ C01: 'invalid', C02: 'required', C03_POST: 'required', X: 'unknown', C04: 'invalid' });
  });

  it('rejects over-long text', () => {
    expect(validateAnswers(example, { ...complete, O01: 'x'.repeat(1001) })).toEqual({ O01: 'too_long' });
  });

  it('drops empty values and trims text', () => {
    expect(compactAnswers(example, { ...complete, O01: '  ok  ', C04: [] })).toEqual({ C01: 4, C02: 'NA', C03_PRE: 2, C03_POST: 5, O01: 'ok' });
  });

  it('derives the open state from the dates', () => {
    const def = { ...example, opensAt: '2030-01-01T00:00:00Z', closesAt: '2030-02-01T00:00:00Z' };
    expect(surveyStatus(def, new Date('2029-12-31T00:00:00Z'))).toBe('not_yet_open');
    expect(surveyStatus(def, new Date('2030-01-15T00:00:00Z'))).toBe('open');
    expect(surveyStatus(def, new Date('2030-02-02T00:00:00Z'))).toBe('closed');
  });
});

describe('slider scales, item remarks and section labels', () => {
  const def = {
    id: 'slider-test',
    version: 1,
    locale: 'de',
    title: 'Slider',
    sectionNav: true,
    intro: { paragraphs: [] },
    thanks: { paragraphs: [] },
    scales: {
      s: {
        display: 'slider',
        options: [0, 1, 2, 3, 4, 5].map((v) => ({ value: v, label: `L${v}` })),
        notApplicable: { value: '-9', label: 'nicht beobachtet' },
      },
    },
    sections: [
      {
        id: 'B1',
        label: 'I',
        title: 'Block',
        items: [
          { id: 'q1', type: 'scale', scale: 's', text: 'Frage **eins**', anchors: { min: 'schlecht', max: 'gut' }, comment: { label: 'Anmerkung', maxLength: 10 } },
          { id: 'q2', type: 'scale', scale: 's', text: 'Frage zwei', comment: { id: 'q2_note', label: 'Anmerkung' } },
        ],
      },
    ],
  } as unknown as SurveyDefinition;

  it('accepts the definition and adds one remark field after each commented item', () => {
    expect(validateDefinition(def)).toEqual([]);
    const fields = fieldsOf(def);
    expect(fields.map((f) => f.key)).toEqual(['q1', 'q1_txt', 'q2', 'q2_note']);
    expect(fields[1]).toMatchObject({ parent: 'q1', item: { type: 'text', text: 'Frage eins – Anmerkung', maxLength: 10 } });
  });

  it('validates values, the not-observed code and remark length', () => {
    expect(validateAnswers(def, { q1: 0, q1_txt: 'kurz', q2: '-9' })).toEqual({});
    expect(validateAnswers(def, { q1: 6, q1_txt: 'viel zu lang', q2: 2.5 })).toMatchObject({ q1: 'invalid', q1_txt: 'too_long', q2: 'invalid' });
  });

  it('rejects gaps in slider values, bad anchors, clashing remark ids and long labels', () => {
    const broken = structuredClone(def) as unknown as Record<string, any>;
    broken.scales.s.options[2].value = 7;
    broken.sections[0].items[0].anchors = { min: 'x' };
    broken.sections[0].items[1].comment.id = 'q1';
    broken.sections[0].label = 'VIIIIIIII';
    const errors = validateDefinition(broken);
    expect(errors.some((e) => e.includes('consecutive'))).toBe(true);
    expect(errors.some((e) => e.includes('anchors'))).toBe(true);
    expect(errors.some((e) => e.includes('duplicated'))).toBe(true);
    expect(errors.some((e) => e.includes('label must be'))).toBe(true);
  });

});

describe('continuous sliders and photo fields', () => {
  const def = {
    id: 'photo-schema',
    version: 1,
    locale: 'de',
    title: 'x',
    intro: { paragraphs: [] },
    thanks: { paragraphs: [] },
    scales: { s: { display: 'slider', step: 0.1, options: [0, 1, 2, 3, 4, 5].map((v) => ({ value: v, label: `L${v}` })) } },
    sections: [{ id: 'B', title: 'B', items: [{ id: 'q1', type: 'scale', scale: 's', text: 'Q', photos: {} }, { id: 'p', type: 'photo', text: 'Bilder', max: 1 }] }],
  } as unknown as SurveyDefinition;

  it('adds a photo field and checks values', () => {
    expect(validateDefinition(def)).toEqual([]);
    expect(fieldsOf(def).map((f) => f.key)).toEqual(['q1', 'q1_foto', 'p']);
    const id = 'f'.repeat(32);
    expect(validateAnswers(def, { q1: 0.1, q1_foto: [id], p: [id.replace(/f/g, 'e')] })).toEqual({});
    expect(validateAnswers(def, { q1: 5.01, q1_foto: ['../x'], p: [id, id.replace(/f/g, '0')] })).toMatchObject({ q1: 'invalid', q1_foto: 'invalid', p: 'too_many' });
    expect(validateAnswers(def, { q1_foto: [id, id] })).toMatchObject({ q1_foto: 'invalid' });
  });

  it('rejects a step that does not divide the unit or a step on buttons', () => {
    const bad = structuredClone(def) as unknown as Record<string, any>;
    bad.scales.s.step = 0.3;
    expect(validateDefinition(bad).some((e) => e.includes('step must divide'))).toBe(true);
    bad.scales.s.step = 0.5;
    bad.scales.s.display = 'buttons';
    expect(validateDefinition(bad).some((e) => e.includes('needs display'))).toBe(true);
  });

  it('accepts exact grid values of a slider that starts at 1, but no float noise', () => {
    const one = structuredClone(def) as unknown as Record<string, any>;
    one.scales.s.options = [1, 2, 3, 4, 5].map((v) => ({ value: v, label: `L${v}` }));
    const d = one as unknown as SurveyDefinition;
    for (const v of [1, 1.3, 3.3, 4.7, 5]) expect(validateAnswers(d, { q1: v })).toEqual({});
    for (const v of [0.9, 4.75, 4.70000001, 3.3000000000000003, 5.1, Number.NaN]) {
      expect(validateAnswers(d, { q1: v })).toMatchObject({ q1: 'invalid' });
    }
  });

  it('rejects invalid slider settings', () => {
    for (const step of [0, -0.1, 1.5, '0.1']) {
      const bad = structuredClone(def) as unknown as Record<string, any>;
      bad.scales.s.step = step;
      expect(validateDefinition(bad).some((e) => e.includes('step must divide'))).toBe(true);
    }
    const desc = structuredClone(def) as unknown as Record<string, any>;
    desc.scales.s.options.reverse();
    expect(validateDefinition(desc).some((e) => e.includes('consecutive ascending'))).toBe(true);
    const wrong = structuredClone(def) as unknown as Record<string, any>;
    wrong.scales.s.display = 'dial';
    expect(validateDefinition(wrong).some((e) => e.includes('display must be'))).toBe(true);
  });

  it('checks matrix rows on a continuous slider like single scale items', () => {
    const m = structuredClone(def) as unknown as Record<string, any>;
    m.scales.s.notApplicable = { value: 'NB', label: 'nicht beurteilbar' };
    m.sections[0].items = [{ id: 'R', type: 'matrix', scale: 's', text: 'R', required: true, columns: [{ id: 'VOR', label: 'vor' }, { id: 'NACH', label: 'nach' }] }];
    const d = m as unknown as SurveyDefinition;
    expect(validateDefinition(d)).toEqual([]);
    expect(validateAnswers(d, { R_VOR: 2.5, R_NACH: 'NB' })).toEqual({});
    expect(validateAnswers(d, { R_VOR: 5.1, R_NACH: 2.55 })).toMatchObject({ R_VOR: 'invalid', R_NACH: 'invalid' });
    expect(validateAnswers(d, { R_VOR: 3 })).toMatchObject({ R_NACH: 'required' });
  });

  it('allows end words, remarks and photos only on scale items', () => {
    const m = structuredClone(def) as unknown as Record<string, any>;
    m.sections[0].items.push({ id: 'R', type: 'matrix', scale: 's', text: 'R', columns: [{ id: 'A', label: 'a' }], comment: { label: 'x' } });
    expect(validateDefinition(m).some((e) => e.includes('comment is only allowed on scale items'))).toBe(true);
  });

  it('checks remark, photo and section label settings', () => {
    const cases: [(d: Record<string, any>) => void, string][] = [
      [(d) => (d.sections[0].items[0].photos = { max: 11 }), 'photos.max'],
      [(d) => (d.sections[0].items[0].photos = { id: 'a b' }), 'photos.id'],
      [(d) => (d.sections[0].items[0].comment = { label: 'x', maxLength: 0 }), 'comment.maxLength'],
      [(d) => (d.sections[0].items[0].comment = {}), 'comment needs a label'],
      [(d) => d.sections[0].items.push({ id: 'q1_txt', type: 'text', text: 't' }, { id: 'q9', type: 'scale', scale: 's', text: 'Q', comment: { label: 'x', id: 'q1_txt' } }), 'duplicated'],
      [(d) => (d.sections[0].items[1].max = 0), 'max must be'],
      [(d) => (d.sections[0].label = ' '), 'label must be'],
      [(d) => (d.sections[0].label = 'NINECHARS'), 'label must be'],
      [(d) => (d.sectionNav = 'yes'), 'sectionNav must be'],
      [(d) => (d.personalDevices = true), 'personalDevices needs accessCodes'],
      [(d) => (d.gated = true), 'gated needs'],
    ];
    for (const [change, message] of cases) {
      const bad = structuredClone(def) as unknown as Record<string, any>;
      change(bad);
      expect(validateDefinition(bad).some((e) => e.includes(message)), message).toBe(true);
    }
  });

  it('names the photo field in the survey language', () => {
    const en = { ...structuredClone(def), locale: 'en' } as SurveyDefinition;
    expect(fieldsOf(en)[1].item.text).toBe('Q – Photos');
    expect(fieldsOf(def)[1].item.text).toBe('Q – Fotos');
  });
});
