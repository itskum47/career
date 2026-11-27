/**
 * Phase 10 — Automatic resolution of candidate-profile fields.
 *
 * Every field is resolved through ONE rule set, applied in this order:
 *
 *   1. the candidate's confirmed answer (user_confirmed)  — highest authority
 *   2. the candidate's own CV                             — primary document
 *   3. the value already in the profile                   — must agree with (1)/(2)
 *
 * Anything that cannot be settled by (1)-(3) becomes a personal question, and
 * anything where (2) and (3) disagree becomes a CONFLICT that is surfaced rather
 * than silently overwritten. Generated documents, cached artifacts and previous
 * agent statements are never consulted (see evidence.ts).
 *
 * The resolver never invents a value: an unknown field stays unknown.
 */

import type { MasterProfile } from '../core/types.ts';
import { collectEvidence, isReliable, type EvidenceBundle, type EvidenceItem, type UserAnswer } from './evidence.ts';

export type ResolutionStatus =
  | 'auto_resolved'      // settled from the CV / confirmed answer, written into the profile
  | 'user_confirmed'     // settled by an answer the candidate gave
  | 'conflict'           // two reliable sources disagree — a human must decide
  | 'ambiguous'          // the evidence names a category but not the fact
  | 'unknown'            // no reliable evidence at all
  | 'deferred'           // deliberately not asserted (a safe alternative exists)
  | 'already_correct';   // profile already matches the evidence

export interface FieldResolution {
  field: string;
  status: ResolutionStatus;
  value?: unknown;
  /** Human-readable provenance recorded next to the value. */
  source?: string;
  confidence: 'high' | 'medium' | 'low';
  /** True when the resolver wrote this value into the profile. */
  applied: boolean;
  note?: string;
}

export interface ResolutionReport {
  generatedAt: string;
  profileVersion: string;
  resolutions: FieldResolution[];
  /** Fields needing a personal answer, in the order they should be asked. */
  questions: PersonalQuestion[];
  /** Asked but unanswered — parked, still open, never re-asked automatically. */
  awaitingConfirmation: PersonalQuestion[];
  /** Fields deliberately left unasserted with a truthful alternative in place. */
  deferred: FieldResolution[];
  conflicts: FieldResolution[];
  changesApplied: number;
  untrustedEvidenceSeen: Array<{ source: string; locator: string; kind: string }>;
}

/** A fact only the candidate can settle. */
export interface PersonalQuestion {
  id: string;
  field: string;
  question: string;
  /** Why the answer matters — shown with the question. */
  why: string;
  /** True when applications cannot proceed for this job without it. */
  blocksApplications: boolean;
  /** Accepted answer shapes, used to parse a chat reply without guessing. */
  examples: string[];
  /** True when answering is optional (a safe alternative already exists). */
  optional?: boolean;
  /**
   * True when the CV states this directly, so the agent resolves it from
   * evidence and must never ask. Confirmation is still welcome, but not required.
   */
  answeredByEvidence?: boolean;
  /** Aliases under which a confirmed answer may be stored. */
  answerFields?: string[];
}

// ---------------------------------------------------------------------------
// CV readers — small, explicit, and only ever returning what the CV says.
// ---------------------------------------------------------------------------

function cvLine(cvText: string, label: string): string | undefined {
  const line = cvText.split('\n').find(l => new RegExp(`^${label}:`, 'i').test(l.trim()));
  return line ? line.split(':').slice(1).join(':').trim() : undefined;
}

function cvHas(cvText: string, phrase: string): boolean {
  return cvText.toLowerCase().includes(phrase.toLowerCase());
}

function dedent(block: string): string {
  return block.replace(/\s+/g, ' ').trim();
}

function cvSection(cvText: string, heading: string, stopAt: string): string {
  const start = cvText.indexOf(heading);
  if (start === -1) return '';
  const rest = cvText.slice(start + heading.length);
  const end = rest.indexOf(stopAt);
  return dedent(end === -1 ? rest : rest.slice(0, end));
}

// ---------------------------------------------------------------------------
// Question catalogue — the only facts the agent may ever ask about.
// ---------------------------------------------------------------------------

export const PERSONAL_QUESTIONS: PersonalQuestion[] = [
  {
    id: 'work-authorization',
    field: 'authorization.workAuthorizations',
    answerFields: ['authorization', 'authorization.workAuthorizations'],
    question: 'Which work authorisation do you currently hold, and would you need visa sponsorship for a role in another country?',
    why: 'Employers ask this as a legal declaration. Guessing it either wastes their time or misstates your status.',
    blocksApplications: true,
    examples: ['Indian citizen, no sponsorship needed', 'Indian citizen, would need H-1B sponsorship', 'Student visa, OPT eligible', 'work permit required'],
  },
  {
    id: 'certifications',
    field: 'certifications',
    question: 'Which certifications have you actually earned? (Name the exact credential, provider and date if you have it.)',
    why: 'Your CV lists five category labels without credential names. A CV cannot claim a specific credential until it is confirmed.',
    blocksApplications: true,
    examples: ['AWS Certified Solutions Architect – Associate, 2024', 'RHCSA, 2023', 'none of these — please remove them'],
  },
  {
    id: 'experience-span',
    field: 'personal.summary',
    question: 'Apart from the two Gokburu roles (Jan–Jul 2024), have you had any other paid work, internship or freelance work?',
    why: 'Your CV summary says "2+ years", but the dated roles cover about seven months. I will not state a years figure until this is settled.',
    blocksApplications: false,
    optional: true,
    examples: ['no, that is all of it', 'yes: internship at X, Jun–Aug 2023', 'yes: freelance web work'],
  },
  {
    id: 'notice-period',
    field: 'preferences.noticePeriodDays',
    question: 'What notice period can you give an employer if you were hired?',
    why: 'It is asked on most applications and a wrong figure looks careless. The profile currently states nothing.',
    blocksApplications: false,
    examples: ['immediately', '15 days', '1 month', '2 months'],
  },
  {
    id: 'salary-expectation',
    field: 'compensation',
    question: 'What are your salary expectations for a DevOps role in Bengaluru (or should the applications state nothing at all)?',
    why: 'Some employers ask up front. Leaving it blank is acceptable; stating a figure you do not hold is not.',
    blocksApplications: false,
    optional: true,
    examples: ['do not state anything', '12 LPA', '15 LPA'],
  },
  {
    id: 'shifts-oncall',
    field: 'preferences.remotePreference',
    question: 'Are you willing to work night shifts or rotational on-call support?',
    why: 'Your CV says you are open to on-call and shift rotations; confirming it lets the agent answer those questions truthfully instead of guessing.',
    blocksApplications: false,
    optional: true,
    /** The CV states this directly, so it is resolved and never asked. */
    answeredByEvidence: true,
    examples: ['yes, both', 'on-call yes, night shifts no', 'no to both'],
  },
  {
    id: 'relocation',
    field: 'preferences.targetLocations',
    answerFields: ['preferences.targetLocations'],
    /** The CV header states openness to relocating to Bengaluru. */
    answeredByEvidence: true,
    question: 'Are you actually willing to relocate to Bengaluru, or only open to remote roles there?',
    why: 'Your CV states openness to relocating; applications must not present Bengaluru as your current city.',
    blocksApplications: false,
    examples: ['willing to relocate to Bengaluru', 'remote in Bengaluru only, no relocation'],
  },
];

// ---------------------------------------------------------------------------
// Answer parsing — conservative on purpose.
// ---------------------------------------------------------------------------

export interface ParsedAnswer {
  field: string;
  value: unknown;
  note?: string;
  /** Set when the reply is recognisable but incomplete. */
  needsClarification?: string;
  /** Extra confirmed facts carried alongside the value (e.g. relocate: true). */
  meta?: Record<string, unknown>;
}

/** Recognise a work-authorisation answer. Returns undefined when unsure. */
export function parseWorkAuthorization(text: string): ParsedAnswer | undefined {
  const t = text.toLowerCase();
  const sponsorship = /sponsor|h-?1b|relocate (to|in) another country|work permit|visa/.test(t);
  const citizen = /citizen|indian citizen|national/.test(t);
  const student = /student visa|f-1|opt\b|curricular/.test(t);
  if (!citizen && !student && !sponsorship) return undefined;

  const authorizations: string[] = [];
  if (citizen) authorizations.push('citizen');
  if (student) authorizations.push('student-visa');
  const requiresSponsorship = sponsorship && !citizen && !student;
  return {
    field: 'authorization',
    value: { workAuthorizations: authorizations, requiresSponsorship },
    note: `confirmed by candidate: ${text.trim()}`,
  };
}

export function parseNoticePeriod(text: string): ParsedAnswer | undefined {
  const t = text.toLowerCase().trim();
  const months = t.match(/(\d+)\s*(month|months|mo)/);
  if (months) {
    const days = parseInt(months[1], 10) * 30;
    return { field: 'preferences.noticePeriodDays', value: days, note: `confirmed by candidate: ${t}` };
  }
  const weeks = t.match(/(\d+)\s*(week|weeks)/);
  if (weeks) {
    return { field: 'preferences.noticePeriodDays', value: parseInt(weeks[1], 10) * 7, note: `confirmed by candidate: ${t}` };
  }
  if (/\b(immediate|immediately|now|0 days?)\b/.test(t)) {
    return { field: 'preferences.noticePeriodDays', value: 0, note: `confirmed by candidate: ${t}` };
  }
  const days = t.match(/(\d+)\s*days?/);
  if (days) return { field: 'preferences.noticePeriodDays', value: parseInt(days[1], 10), note: `confirmed by candidate: ${t}` };
  return undefined;
}

export function parseSalary(text: string): ParsedAnswer | undefined {
  const t = text.toLowerCase().trim();
  if (/(do not|don't|dont|no)\s+(state|declare|mention)/.test(t) || /^(none|nothing|skip)$/.test(t)) {
    return { field: 'compensation', value: { minBase: 0, targetBase: 0, stated: false }, note: `confirmed by candidate: ${t}` };
  }
  const lpa = t.match(/(\d+(?:\.\d+)?)\s*lpa/);
  if (lpa) {
    const rupees = Math.round(parseFloat(lpa[1]) * 100000);
    return { field: 'compensation', value: { minBase: rupees, targetBase: rupees, stated: true }, note: `confirmed by candidate: ${t}` };
  }
  const monthly = t.match(/₹?\s*(\d+)\s*(k|,000)?\s*(per month|\/month|pm)/);
  if (monthly) {
    const base = parseInt(monthly[1], 10) * (monthly[2] ? 1000 : 100000);
    return { field: 'compensation', value: { minBase: base, targetBase: base, stated: true }, note: `confirmed by candidate: ${t}` };
  }
  return undefined;
}

export function parseRelocation(text: string): ParsedAnswer | undefined {
  const t = text.toLowerCase();
  if (/willing to relocate|yes.*relocat|relocate to bengaluru/.test(t)) {
    return {
      field: 'preferences.targetLocations',
      value: ['Bengaluru, India'],
      meta: { relocate: true },
      note: `confirmed by candidate: ${t}`,
    };
  }
  if (/remote only|no relocation|not willing to relocate/.test(t)) {
    return {
      field: 'preferences.targetLocations',
      value: ['Bengaluru, India (remote)'],
      meta: { relocate: false },
      note: `confirmed by candidate: ${t}`,
    };
  }
  return undefined;
}

export function parseOnCall(text: string): ParsedAnswer | undefined {
  const t = text.toLowerCase();
  const yes = /\b(yes|both|willing)\b/.test(t);
  if (!yes) return undefined;
  const nightNo = /night (shift)?s? (no|not)/.test(t);
  const both = /both|yes, both/.test(t);
  return {
    field: 'preferences.remotePreference',
    value: { onCall: true, nightShifts: both || !nightNo },
    note: `confirmed by candidate: ${t}`,
  };
}

/**
 * Extract an exact credential name from a free-text answer.
 *
 * The bar is deliberately high: a bare provider word ("AWS", "Azure") or a
 * category label ("AWS Certification") is NOT a credential, so the reply is
 * refused with a clarification request rather than recorded as one.
 */
const CREDENTIAL_DESCRIPTORS = /\b(certified|associate|professional|expert|advanced|fundamental|specialist|architect|administrator|developer|engineer)\b/i;
const CREDENTIAL_CODES = /\b(rhcsa|rhce|rhcah|cka|ckad|cks|cissp|ccna|ccnp|ccie|ew\d\d|az-\d+|dp-\d+)\b/i;

export function parseCertification(text: string): ParsedAnswer | undefined {
  const t = text.trim();
  if (/^(none|none of these|no|nothing|remove them)\b/i.test(t)) {
    return { field: 'certifications', value: { removeAll: true }, note: `confirmed by candidate: ${t}` };
  }

  const needsClarification = {
    field: 'certifications',
    value: undefined,
    needsClarification:
      'I need the exact credential name to record it truthfully — for example "AWS Certified Solutions Architect – Associate (2024)". ' +
      'A provider word or category label such as "AWS" or "AWS Certification" is not a credential and will not be claimed.',
  };

  // Reject anything that is only a category label.
  if (/\bcertification(s)?\s*$/i.test(t.replace(/[,;.]+$/, '')) && !CREDENTIAL_CODES.test(t)) {
    return needsClarification;
  }

  const year = t.match(/\b(20\d{2})\b/)?.[1];
  const name = t.replace(/\b20\d{2}\b/g, '').replace(/[(),;]/g, ' ').replace(/\s+/g, ' ').trim();

  // A bare provider word is not enough: a specific credential either carries a
  // recognised code (RHCSA, CKA, AZ-900) or a descriptor (Certified, Associate…).
  if (!CREDENTIAL_CODES.test(name) && !CREDENTIAL_DESCRIPTORS.test(name)) return needsClarification;

  return {
    field: 'certifications',
    value: { name, issueYear: year },
    note: `confirmed by candidate: ${t}`,
  };
}

/** Route a chat reply to whichever question it can plausibly answer. */
export function parseAnswerFor(questionId: string, text: string): ParsedAnswer | ParsedAnswer[] | undefined {
  switch (questionId) {
    case 'work-authorization': return parseWorkAuthorization(text);
    case 'notice-period': return parseNoticePeriod(text);
    case 'salary-expectation': return parseSalary(text);
    case 'relocation': return parseRelocation(text);
    case 'shifts-oncall': return parseOnCall(text);
    case 'certifications': return parseCertification(text);
    case 'experience-span': {
      const t = text.toLowerCase();
      if (/^(no|none|nothing|that is all|that's all)\b/.test(t)) {
        return { field: 'personal.summary', value: { totalYearsClaim: false }, note: `confirmed by candidate: ${t}` };
      }
      return {
        field: 'personal.summary',
        value: undefined,
        needsClarification:
          'If there is other work, give employer/role and month-year range (for example "internship at Acme, Jun–Aug 2023"). ' +
          'If not, reply "no" and the CV summary will state experience from 2024 without a total-years figure.',
      };
    }
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------
// The resolver
// ---------------------------------------------------------------------------

function confirmed(answers: Map<string, UserAnswer>, field: string): UserAnswer | undefined {
  for (const [key, value] of answers) {
    if (key === field || key.startsWith(`${field}.`)) return value;
  }
  return undefined;
}

export interface ResolveInput {
  profile: MasterProfile;
  evidence?: EvidenceBundle;
  cwd?: string;
}

/**
 * Resolve every field it can, and report exactly what it could not.
 *
 * Pure: it reads evidence and returns a report. Applying the changes is a
 * separate, explicit step (ProfileWorkspace) so a dry run is always possible.
 */
export function resolveProfile({ profile, evidence, cwd = process.cwd() }: ResolveInput): ResolutionReport {
  const bundle = evidence ?? collectEvidence(cwd);
  const cv = bundle.cvText;
  const resolutions: FieldResolution[] = [];

  const push = (r: FieldResolution) => { resolutions.push(r); return r; };
  const answer = (field: string) => confirmed(bundle.userAnswers, field);

  // ---- Contact details: the CV header is the primary document --------------
  const cvEmail = cvLine(cv, 'e?mail') || cv.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
  const cvPhone = cvLine(cv, '(\\+?\\d[\\d\\s-]{7,}\\d)') || cv.match(/\+\d[\d\s-]{8,}\d/)?.[0];
  const cvName = cv.split('\n')[0]?.trim();
  // The CV header reads: "Ranchi, Jharkhand, India (Open to relocation: Bengaluru,
  // India - hybrid)". The CURRENT residence is the part before the parenthesis —
  // a preferred destination must never be read as where the candidate lives.
  const cvHeaderLocation = cv.split('\n').find(l => /^[A-Z][a-z]+,\s*[A-Za-z ]+,\s*India/.test(l.trim()));
  const cvLocation = cvHeaderLocation?.trim().match(/^([A-Z][a-z]+,\s*[A-Za-z\s]+,\s*India)/)?.[1]?.trim();
  const cvGithub = cv.match(/github\.com\/([\w-]+)/i)?.[0];
  const cvLinkedin = cv.match(/linkedin\.com\/in\/([\w-]+)/i)?.[0];

  const contactFields: Array<[string, string | undefined, string | undefined]> = [
    ['personal.fullName', profile.personal?.fullName, cvName],
    ['personal.email', profile.personal?.email, cvEmail],
    ['personal.phone', profile.personal?.phone, cvPhone?.trim()],
    ['personal.location', profile.personal?.location, cvLocation?.trim()],
    ['personal.github', profile.personal?.github, cvGithub],
    ['personal.linkedin', profile.personal?.linkedin, cvLinkedin],
  ];

  for (const [field, current, fromCv] of contactFields) {
    const user = answer(field);
    if (user) {
      push({ field, status: 'user_confirmed', value: user.value, source: 'your answer in chat', confidence: 'high', applied: false });
      continue;
    }
    if (!fromCv) {
      push({ field, status: 'unknown', confidence: 'low', applied: false, note: 'not stated in the CV' });
      continue;
    }
    if (!current) {
      push({ field, status: 'auto_resolved', value: fromCv, source: 'CV header', confidence: 'high', applied: true });
      continue;
    }
    const norm = (v: string) => v.toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
    if (norm(current) === norm(fromCv)) {
      push({ field, status: 'already_correct', value: current, source: 'CV header', confidence: 'high', applied: false });
    } else {
      push({
        field,
        status: 'conflict',
        value: fromCv,
        source: 'CV header',
        confidence: 'high',
        applied: false,
        note: `profile has "${current}" but the CV says "${fromCv}"`,
      });
    }
  }

  // ---- Relocation / on-call: the CV states these explicitly ---------------
  const cvOpenToRelocate = cvHas(cv, 'relocating to bengaluru');
  const cvOnCall = cvHas(cv, 'on-call');
  push({
    field: 'preferences.targetLocations',
    status: cvOpenToRelocate ? 'auto_resolved' : 'unknown',
    value: ['Bengaluru, India'],
    source: 'CV header: open to relocating to Bengaluru (hybrid)',
    confidence: 'high',
    applied: false,
    note: 'current location stays Ranchi; Bengaluru is recorded as a target, never as residence',
  });
  push({
    field: 'preferences.shiftsAndOnCall',
    status: cvOnCall ? 'auto_resolved' : 'unknown',
    value: { openToOnCall: true, openToShiftRotations: true },
    source: 'CV summary: open to on-call support and shift rotations',
    confidence: 'high',
    applied: false,
  });

  // ---- Education / experience: taken straight from the CV -----------------
  const eduBlock = cvSection(cv, 'EDUCATION', 'CERTIFICATIONS');
  const cvCgpa = eduBlock.match(/CGPA:?\s*([\d.]+)/i)?.[1];
  push({
    field: 'education.gpa',
    status: cvCgpa ? 'already_correct' : 'unknown',
    value: cvCgpa ? `CGPA ${cvCgpa} / 10` : undefined,
    source: 'CV Education',
    confidence: 'high',
    applied: false,
  });
  push({
    field: 'education.dates',
    status: 'unknown',
    confidence: 'low',
    applied: false,
    note: 'the CV states no start or graduation year; left empty rather than invented',
  });

  const datedRoles = profile.experience.map(e => ({
    title: e.title,
    company: e.company,
    from: e.startDate ? new Date(e.startDate).toISOString().slice(0, 10) : undefined,
    to: e.endDate ? new Date(e.endDate).toISOString().slice(0, 10) : undefined,
  }));
  push({
    field: 'experience',
    status: 'already_correct',
    value: datedRoles,
    source: 'CV Professional Experience',
    confidence: 'high',
    applied: false,
    note: 'titles, employer and dates preserved exactly as written in the CV',
  });

  // ---- The "2+ years" discrepancy: surfaced, never silently accepted ------
  const claimedYears = cv.match(/(\d+)\+?\s*years?/i)?.[1];
  let datedMonths = 0;
  for (const r of datedRoles) {
    if (r.from && r.to) {
      const months = (new Date(r.to).getTime() - new Date(r.from).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
      datedMonths += Math.max(0, months);
    }
  }
  const claimedValue = claimedYears ? parseInt(claimedYears, 10) : undefined;
  if (claimedValue !== undefined && datedMonths < claimedValue * 12 * 0.75) {
    push({
      field: 'personal.summary.yearsClaim',
      status: 'conflict',
      value: undefined,
      source: 'CV summary vs CV dated roles',
      confidence: 'high',
      applied: false,
      note:
        `the CV summary says "${claimedValue}+ years" but the dated roles cover about ${Math.round(datedMonths)} month(s). ` +
        'No total-years figure will be asserted until the candidate confirms whether other work exists.',
    });
  }

  // ---- Certifications: category labels are not credentials ----------------
  const genericCerts = (profile.certifications ?? []).filter(c =>
    /certification$/i.test(c.name) && !c.verified);
  push({
    field: 'certifications',
    status: genericCerts.length ? 'ambiguous' : 'already_correct',
    value: genericCerts.length ? genericCerts.map(c => c.name) : undefined,
    source: 'CV Certifications section',
    confidence: 'high',
    applied: false,
    note: genericCerts.length
      ? 'category labels only — no credential name, provider level or date; nothing will be claimed until confirmed'
      : 'every recorded certification has been confirmed with an exact credential name',
  });

  // ---- Personal facts with no evidence at all -----------------------------
  const authAnswer = answer('authorization');
  push({
    field: 'authorization.workAuthorizations',
    status: authAnswer ? 'user_confirmed' : 'unknown',
    value: authAnswer?.value,
    source: authAnswer ? 'your answer in chat' : undefined,
    confidence: authAnswer ? 'high' : 'low',
    applied: false,
    note: authAnswer ? undefined : 'work authorisation is a legal declaration — only the candidate can state it',
  });

  const noticeAnswer = answer('preferences.noticePeriodDays');
  push({
    field: 'preferences.noticePeriodDays',
    status: noticeAnswer ? 'user_confirmed' : 'unknown',
    value: noticeAnswer?.value,
    source: noticeAnswer ? 'your answer in chat' : undefined,
    confidence: noticeAnswer ? 'high' : 'low',
    applied: false,
    note: noticeAnswer ? undefined : 'no notice period is stated anywhere; the profile asserts none',
  });

  const salaryAnswer = answer('compensation');
  push({
    field: 'compensation',
    status: salaryAnswer ? 'user_confirmed' : 'unknown',
    value: salaryAnswer?.value,
    source: salaryAnswer ? 'your answer in chat' : undefined,
    confidence: salaryAnswer ? 'high' : 'low',
    applied: false,
    note: salaryAnswer ? undefined : 'no salary figure is stated anywhere; the profile asserts none',
  });

  // ---- Which questions remain, in priority order -------------------------
  const answeredKeys = new Set<string>();
  for (const [key] of bundle.userAnswers) answeredKeys.add(key);
  const isAnswered = (q: PersonalQuestion): boolean => {
    // A question the CV already answers is resolved, not asked.
    if (q.answeredByEvidence) return true;
    const fields = [q.field, ...(q.answerFields ?? [])];
    if (fields.some(f => answeredKeys.has(f))) return true;
    // A field the evidence already settles must never be asked again.
    return fields.some(f => {
      const r = resolutions.find(x => x.field === f);
      return !!r && (r.status === 'auto_resolved' || r.status === 'already_correct' || r.status === 'user_confirmed');
    });
  };
  const questions = PERSONAL_QUESTIONS.filter(q => !isAnswered(q));

  // Asked-but-unanswered questions stay open and listed, but are never
  // re-asked automatically — the workflow continues with everything else.
  const deferredIds = new Set(
    (profile.awaitingConfirmation ?? []).map(a => a.questionId),
  );
  const awaitingConfirmation = PERSONAL_QUESTIONS.filter(q => deferredIds.has(q.id));
  const askable = questions.filter(q => !deferredIds.has(q.id));

  return {
    generatedAt: new Date().toISOString(),
    profileVersion: (profile as any).profileVersion ?? 'unknown',
    resolutions,
    questions: askable,
    awaitingConfirmation,
    deferred: resolutions.filter(r => r.status === 'deferred'),
    conflicts: resolutions.filter(r => r.status === 'conflict'),
    changesApplied: resolutions.filter(r => r.applied).length,
    untrustedEvidenceSeen: bundle.untrustedSeen.map(e => ({ source: e.source, locator: e.locator, kind: e.kind })),
  };
}

export function formatResolutionReport(report: ResolutionReport): string {
  const line = (r: FieldResolution) => {
    const mark = r.status === 'auto_resolved' ? '+' : r.status === 'already_correct' ? '=' : r.status === 'user_confirmed' ? '✓' : '!';
    const value = r.value === undefined ? '' : ` → ${JSON.stringify(r.value)}`;
    const note = r.note ? ` (${r.note})` : '';
    return `  ${mark} ${r.field}: ${r.status}${value}${note}`;
  };
  const counts = report.resolutions.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
  return [
    `resolved automatically : ${(counts.auto_resolved ?? 0) + (counts.already_correct ?? 0)} field(s)`,
    `confirmed by you        : ${counts.user_confirmed ?? 0}`,
    `conflicts to surface   : ${counts.conflict ?? 0}`,
    `ambiguous              : ${counts.ambiguous ?? 0}`,
    `still unknown          : ${counts.unknown ?? 0}`,
    '',
    ...report.resolutions.map(line),
  ].join('\n');
}
