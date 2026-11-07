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
