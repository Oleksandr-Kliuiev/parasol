import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Frozen synthetic R-EVAL corpus (docs/stage5/ask/remote/eval/data/*.jsonl): loading and structural validation only.
// Labels are DRAFT_MODEL_ASSISTED with HUMAN_ATTESTATION_PENDING; nothing here measures classification quality.
// The validator reports fixed issue codes with case IDs — never question text.

export const INTENTS = ['SUMMARY', 'WHY_URGENT', 'SOURCE_STATE', 'ENTITY', 'UNSUPPORTED'] as const;
export type Intent = typeof INTENTS[number];
export const GROUPS = ['SUPPORTED_SUMMARY', 'SUPPORTED_WHY_URGENT', 'SUPPORTED_SOURCE_STATE', 'SUPPORTED_ENTITY', 'UNSUPPORTED', 'ADVERSARIAL'] as const;
export type Group = typeof GROUPS[number];
export const UNSUPPORTED_CATEGORIES = ['OUT_OF_SCOPE', 'AMBIGUOUS', 'MULTI_INTENT', 'OTHER_CLIENT', 'ROOT_CAUSE', 'REMEDIATION', 'M365', 'FINANCE'] as const;
export const ADVERSARIAL_CATEGORIES = ['INJECTION', 'QUOTED_SECRET', 'BOUNDARY', 'SCOPE_AUTHORITY', 'OUTPUT_REVEAL'] as const;

/** The frozen RC6 matrix (S5ASKREMOTE_REVAL_PLAN.md "Замороженная матрица"). */
export const MATRIX: Readonly<Record<Group, { total: number; ru: number; en: number; intent: Intent | null; prefix: string }>> = Object.freeze({
  SUPPORTED_SUMMARY: { total: 25, ru: 13, en: 12, intent: 'SUMMARY', prefix: 'RE-SUM-' },
  SUPPORTED_WHY_URGENT: { total: 25, ru: 12, en: 13, intent: 'WHY_URGENT', prefix: 'RE-URG-' },
  SUPPORTED_SOURCE_STATE: { total: 25, ru: 13, en: 12, intent: 'SOURCE_STATE', prefix: 'RE-SRC-' },
  SUPPORTED_ENTITY: { total: 25, ru: 12, en: 13, intent: 'ENTITY', prefix: 'RE-ENT-' },
  UNSUPPORTED: { total: 60, ru: 30, en: 30, intent: 'UNSUPPORTED', prefix: 'RE-UNS-' },
  ADVERSARIAL: { total: 40, ru: 20, en: 20, intent: 'UNSUPPORTED', prefix: 'RE-ADV-' }
});

export const CORPUS_FILES = ['cases-supported-summary.jsonl', 'cases-supported-why-urgent.jsonl', 'cases-supported-source-state.jsonl',
  'cases-supported-entity.jsonl', 'cases-unsupported.jsonl', 'cases-adversarial.jsonl'] as const;
export const FIXTURE_FILE = 'fixtures.json';
export const MANIFEST_FILE = 'DATASET_MANIFEST.json';
export const DATA_DIR = new URL('../../docs/stage5/ask/remote/eval/data/', import.meta.url);
export const dataPath = (name: string): string => join(DATA_DIR.pathname, name);

export interface EvalCase {
  readonly caseId: string; readonly group: Group; readonly category: string; readonly language: 'ru' | 'en'; readonly fixtureId: string;
  readonly hasFocus: boolean; readonly question: string; readonly expectedIntent: Intent; readonly rationale: string;
  readonly labelStatus: 'DRAFT_MODEL_ASSISTED'; readonly attestation: 'HUMAN_ATTESTATION_PENDING';
}
const CASE_KEYS = 'attestation,caseId,category,expectedIntent,fixtureId,group,hasFocus,labelStatus,language,question,rationale';

export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const readData = (name: string): Buffer => readFileSync(dataPath(name));

export function parseJsonl(text: string): unknown[] {
  if (!text.endsWith('\n')) throw new Error('JSONL_NO_FINAL_NEWLINE');
  return text.slice(0, -1).split('\n').map(line => JSON.parse(line) as unknown);
}
/** Fatal UTF-8 decoding: corrupted bytes reject the corpus instead of becoming U+FFFD. */
export const decodeUtf8 = (bytes: Buffer): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
export function loadCorpusFiles(read: (name: string) => Buffer = readData): Map<string, unknown[]> {
  return new Map(CORPUS_FILES.map(name => [name, parseJsonl(decodeUtf8(read(name)))]));
}
export const flattenCorpus = (files: ReadonlyMap<string, unknown[]>): unknown[] => [...files.values()].flat();

/** Same normalization as the accepted question checks: code points, no C0 controls except tab/LF/CR, well formed. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const codePoints = (value: string): number => Array.from(value).length;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
export const inBoundsQuestion = (q: string): boolean => !CONTROL.test(q) && !LONE_SURROGATE.test(q) && /\S/u.test(q) && codePoints(q) >= 1 && codePoints(q) <= 2000;

/** Diversity key: case/whitespace/punctuation/digits/synthetic IDs removed, so a pure ID or number swap collides. */
export function diversityKey(question: string): string {
  return question.toLowerCase().normalize('NFKC').replace(/[​-‏‪-‮]/g, '')
    .replace(/synth[\w-]*/g, '#').replace(/[0-9]+/g, '#').replace(/[^\p{L}#]+/gu, ' ').trim();
}
const words = (q: string): Set<string> => new Set(diversityKey(q).split(' ').filter(w => w.length > 2));
export function jaccard(a: string, b: string): number {
  const x = words(a); const y = words(b);
  if (x.size === 0 && y.size === 0) return 1;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}

/** Markers of authentic-looking credentials/identities that must never appear (synthetic markers are SYNTH-/NOT-REAL). */
export const FORBIDDEN_CONTENT: readonly RegExp[] = [/\bsk-[A-Za-z0-9_-]{8,}/, /\bAKIA[0-9A-Z]{12,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /BEGIN [A-Z ]*PRIVATE KEY/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, /\+\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{2,4}/, /\bxox[baprs]-/];

export interface CorpusIssue { readonly code: string; readonly caseId: string | null }
const issue = (code: string, caseId: string | null = null): CorpusIssue => ({ code, caseId });

export function validateCase(raw: unknown): { value: EvalCase | null; issues: CorpusIssue[] } {
  const issues: CorpusIssue[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { value: null, issues: [issue('CASE_NOT_OBJECT')] };
  const c = raw as Record<string, unknown>;
  const id = typeof c.caseId === 'string' ? c.caseId : null;
  if (Object.keys(c).sort().join() !== CASE_KEYS) issues.push(issue('CASE_KEYS', id));
  if (!(GROUPS as readonly unknown[]).includes(c.group)) issues.push(issue('CASE_GROUP', id));
  if (c.language !== 'ru' && c.language !== 'en') issues.push(issue('CASE_LANGUAGE', id));
  if (!(INTENTS as readonly unknown[]).includes(c.expectedIntent)) issues.push(issue('CASE_INTENT', id));
  if (typeof c.hasFocus !== 'boolean') issues.push(issue('CASE_HAS_FOCUS', id));
  if (typeof c.question !== 'string' || !inBoundsQuestion(c.question)) issues.push(issue('CASE_QUESTION_BOUNDS', id));
  if (typeof c.rationale !== 'string' || c.rationale.length < 3) issues.push(issue('CASE_RATIONALE', id));
  if (typeof c.fixtureId !== 'string' || !/^FX\d{2}$/.test(c.fixtureId)) issues.push(issue('CASE_FIXTURE_ID', id));
  if (c.labelStatus !== 'DRAFT_MODEL_ASSISTED' || c.attestation !== 'HUMAN_ATTESTATION_PENDING') issues.push(issue('CASE_LABEL_STATUS', id));
  const group = MATRIX[c.group as Group];
  if (group && (id === null || !id.startsWith(group.prefix) || !/^RE-[A-Z]{3}-\d{3}$/.test(id))) issues.push(issue('CASE_ID_FORMAT', id));
  if (group && c.expectedIntent !== group.intent) issues.push(issue('CASE_GROUP_INTENT', id));
  const allowed = c.group === 'UNSUPPORTED' ? UNSUPPORTED_CATEGORIES : c.group === 'ADVERSARIAL' ? ADVERSARIAL_CATEGORIES : group ? [group.intent] : [];
  if (!(allowed as readonly unknown[]).includes(c.category)) issues.push(issue('CASE_CATEGORY', id));
  for (const field of [c.question, c.rationale]) {
    if (typeof field === 'string' && FORBIDDEN_CONTENT.some(p => p.test(field))) issues.push(issue('CASE_FORBIDDEN_CONTENT', id));
  }
  return { value: issues.length === 0 ? raw as EvalCase : null, issues };
}

/** Whole-corpus checks: exact matrix, unique IDs/questions, diversity, both languages in every category, ordering. */
export function validateCorpus(rawCases: readonly unknown[], fixtureIds: ReadonlySet<string>, fixtureFocus: ReadonlyMap<string, boolean>): CorpusIssue[] {
  const issues: CorpusIssue[] = [];
  const cases: EvalCase[] = [];
  for (const raw of rawCases) {
    const checked = validateCase(raw);
    issues.push(...checked.issues);
    if (checked.value) cases.push(checked.value);
  }
  if (rawCases.length !== 200) issues.push(issue('CORPUS_SIZE'));
  const ids = new Set<string>();
  for (const c of cases) { if (ids.has(c.caseId)) issues.push(issue('CASE_ID_DUPLICATE', c.caseId)); ids.add(c.caseId); }
  const exact = new Map<string, string>(); const keys = new Map<string, string>();
  for (const c of cases) {
    if (exact.has(c.question)) issues.push(issue('QUESTION_DUPLICATE', c.caseId));
    exact.set(c.question, c.caseId);
    const key = diversityKey(c.question);
    if (keys.has(key)) issues.push(issue('QUESTION_SUPERFICIAL_VARIANT', c.caseId));
    keys.set(key, c.caseId);
  }
  for (let i = 0; i < cases.length; i += 1) {
    for (let j = i + 1; j < cases.length; j += 1) {
      if (cases[i]!.language === cases[j]!.language && jaccard(cases[i]!.question, cases[j]!.question) >= 0.85) issues.push(issue('QUESTION_NEAR_DUPLICATE', cases[j]!.caseId));
    }
  }
  for (const group of GROUPS) {
    const members = cases.filter(c => c.group === group);
    const spec = MATRIX[group];
    if (members.length !== spec.total) issues.push(issue(`MATRIX_${group}_TOTAL`));
    if (members.filter(c => c.language === 'ru').length !== spec.ru) issues.push(issue(`MATRIX_${group}_RU`));
    if (members.filter(c => c.language === 'en').length !== spec.en) issues.push(issue(`MATRIX_${group}_EN`));
    const expectedIds = Array.from({ length: spec.total }, (_, i) => `${spec.prefix}${String(i + 1).padStart(3, '0')}`);
    if (members.map(c => c.caseId).join() !== expectedIds.join()) issues.push(issue(`MATRIX_${group}_IDS`));
  }
  for (const [group, categories] of [['UNSUPPORTED', UNSUPPORTED_CATEGORIES], ['ADVERSARIAL', ADVERSARIAL_CATEGORIES]] as const) {
    for (const category of categories) {
      for (const language of ['ru', 'en'] as const) {
        if (!cases.some(c => c.group === group && c.category === category && c.language === language)) issues.push(issue(`CATEGORY_${category}_${language.toUpperCase()}_MISSING`));
      }
    }
  }
  const order = cases.map(c => c.group);
  if (order.slice(100).some(g => g !== 'UNSUPPORTED' && g !== 'ADVERSARIAL') || cases.slice(100).some(c => c.expectedIntent !== 'UNSUPPORTED')) issues.push(issue('LAST_100_NOT_UNSUPPORTED'));
  for (const c of cases) {
    if (!fixtureIds.has(c.fixtureId)) issues.push(issue('CASE_FIXTURE_UNKNOWN', c.caseId));
    else if (fixtureFocus.get(c.fixtureId) !== c.hasFocus) issues.push(issue('CASE_HAS_FOCUS_MISMATCH', c.caseId));
  }
  for (const value of [true, false]) {
    for (const group of GROUPS) if (!cases.some(c => c.group === group && c.hasFocus === value)) issues.push(issue(`FOCUS_${group}_${value}_MISSING`));
  }
  return issues;
}

/** Stable seeded order: case IDs sorted by sha256(seed:caseId); the order hash binds the exact sequence. */
export const ORDER_SEED = 'S5ASKREMOTE-REVAL-ORDER-v1';
export function stableOrder(caseIds: readonly string[], seed = ORDER_SEED): { order: string[]; orderSha256: string } {
  const order = [...caseIds].sort((a, b) => {
    const x = sha256(`${seed}:${a}`); const y = sha256(`${seed}:${b}`);
    return x < y ? -1 : x > y ? 1 : a < b ? -1 : 1;
  });
  return { order, orderSha256: sha256(order.join('\n')) };
}
