/**
 * KSR PLUS Stable MCQ Parser
 * - Smart numbered/unnumbered question detection
 * - WhatsApp export cleanup without deleting message content
 * - Statement-question preservation
 * - Advanced answer marker detection
 * - Broken-line and inline-option recovery
 * - Matching / Assertion–Reason classification
 * - Near-duplicate diagnostics
 * - Import health summary + legacy parseBits compatibility
 */
const MARK_CHARS = '●⚫•⬤◉✅✓✔☑★☆✦✧❇❎❌⭕🔴🟢🟡🔵🟣🟤⚪▪▫■□◆◇▶➤➜➝➞➟➠➢➣➥➦➧➨➩➪➫➬➭➮➯➱*#@';
const MARK_RE = new RegExp(`[${MARK_CHARS}]`, 'u');
const MARKS_GLOBAL = new RegExp(`[${MARK_CHARS}]`, 'gu');
const LETTERS = '(?:[A-D]|ఎ|ఏ|బి|బీ|సి|సీ|డి|డీ)';
// Supports `(A) text`, `A) text`, `A. text`, and no-space forms such as
// `(C)(ii), (iii) మాత్రమే`. Missing this form caused the following question
// to be merged into the current one.
const LETTER_OPTION_RE = new RegExp(
  `^(?:\\((${LETTERS})\\)|(${LETTERS})\\s*[\\).:\-])\\s*(.*)$`,
  'iu'
);
const NUMBER_OPTION_RE = /^(?:\(([1-4])\)|([1-4])\s*[\).:\-])\s*(.*)$/u;
const Q_PREFIX_RE = /^(?:Q(?:uestion)?|ప్రశ్న)\s*[-:]?\s*(\d{1,4})\s*[\.:\-) ]*\s*(.*)$/iu;
const Q_NUMBER_RE = /^(\d{1,4})\s*(?:\.{1,3}|[:\)])\s*(.*)$/u;
const ROMAN_RE = /^(?:I|II|III|IV|V|VI|VII|VIII|IX|X|i|ii|iii|iv|v|vi|vii|viii|ix|x)\s*[\)\.:\-]\s*/u;
const LIST_HEADER_RE = /^(?:జాబితా|List)\s*[\-:]?\s*(?:I{1,3}|1|2)\b/iu;
const ANSWER_WORDS = '(?:సరి(?:యైన|అయిన)\\s*)?(?:జవాబు|సమాధానం)|Correct\\s*Answer|Right\\s*Answer|Answer|Ans';
const ANSWER_LINE_RE = new RegExp(`^[${MARK_CHARS}]?\\s*(?:${ANSWER_WORDS})\\s*[:.\\-]?\\s*([A-D1-4]|ఎ|ఏ|బి|బీ|సి|సీ|డి|డీ)(?:\\s*[\\).:\\-]?\\s*(.*))?$`, 'iu');
const WHATSAPP_PREFIX_RE = /^\s*\[?\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?[, ]+\d{1,2}:\d{2}(?:\s?[AP]M)?\]?\s*(?:-\s*)?[^:\n]{1,100}:\s*/iu;
const CHAT_LABEL_RE = /^(?:Sravanthi\s+Sister)\s*:?\s*$/iu;
const HEADING_RE = /^(?:grand\s*test|daily\s*test|dialy\s*test|psychology|telugu|english|articles?|maths?|mathematics|biology|science|method|methodology|social|social\s*studies|evs?|environmental\s*studies|డైలీ\s*టెస్ట్|గ్రాండ్\s*టెస్ట్|సైకాలజీ|తెలుగు|ఇంగ్లీష్|గణితం|జీవశాస్త్రం|సాంఘికం)$/iu;
const TEST_TITLE_RE = /^(?:grand\s*test|daily\s*test|dialy\s*test|డైలీ\s*టెస్ట్|గ్రాండ్\s*టెస్ట్)$/iu;
const SUBJECT_ALIASES = new Map([
  ['psychology','Psychology'], ['సైకాలజీ','Psychology'],
  ['telugu','Telugu'], ['తెలుగు','Telugu'],
  ['english','English'], ['article','English'], ['articles','English'], ['ఇంగ్లీష్','English'],
  ['math','Maths'], ['maths','Maths'], ['mathematics','Maths'], ['గణితం','Maths'],
  ['biology','Biology'], ['జీవశాస్త్రం','Biology'],
  ['science','Science'],
  ['ev','EVS'], ['evs','EVS'], ['environmental studies','EVS'],
  ['method','Method'], ['methodology','Method'],
  ['social','Social'], ['social studies','Social'], ['సాంఘికం','Social']
]);

export function parseQuestions(raw, defaultSubject = 'General') {
  return parseQuestionsDetailed(raw, defaultSubject).questions;
}

/** Legacy compatibility for older admin screens. */
export function parseBits(raw, defaultSubject = 'General') {
  return parseQuestions(raw, defaultSubject);
}

/** Backward-compatible detailed result for future import-health UI. */
export function parseQuestionsDetailed(raw, defaultSubject = 'General') {
  const lines = normalizeLines(raw);
  if (!lines.length) return { questions: [], diagnostics: emptyDiagnostics() };

  const rawBlocks = splitQuestionBlocks(lines, defaultSubject);
  const blocks = recoverOrphanQuestionBlocks(rawBlocks);
  const parsed = blocks
    .map((block, index) => parseBlock(block.lines || block, index, block.subject || defaultSubject))
    // Never silently delete a detected question. Incomplete questions are kept
    // and clearly reported by the health diagnostics for review.
    .filter(q => q.question);

  const duplicateReport = findDuplicateQuestions(parsed);
  const healthReport = analyzeQuestionHealth(parsed);
  const diagnostics = {
    inputLines: lines.length,
    detectedBlocks: blocks.length,
    subjects: summarizeSubjects(parsed),
    parsedQuestions: parsed.length,
    missingOptions: healthReport.counts.missingOptions,
    missingAnswers: healthReport.counts.missingAnswer,
    emptyQuestions: healthReport.counts.emptyQuestion,
    brokenQuestions: healthReport.counts.brokenQuestion,
    healthyQuestions: healthReport.healthyQuestions,
    warningQuestions: healthReport.warningQuestions,
    criticalQuestions: healthReport.criticalQuestions,
    matchingQuestions: parsed.filter(q => q.type === 'matching').length,
    assertionReasonQuestions: parsed.filter(q => q.type === 'assertion-reason').length,
    statementQuestions: parsed.filter(q => q.type === 'statement').length,
    standardQuestions: parsed.filter(q => q.type === 'standard').length,
    rawQuestions: blocks.length,
    duplicateQuestions: duplicateReport.duplicateIndexes.length,
    uniqueQuestions: Math.max(0, parsed.length - duplicateReport.duplicateIndexes.length),
    duplicateGroups: duplicateReport.groups.length,
    duplicateIndexes: duplicateReport.duplicateIndexes,
    confidence: healthReport.healthScore,
    healthScore: healthReport.healthScore,
    healthStatus: healthReport.status,
    questionHealth: healthReport.questions,
    subjectSummary: summarizeSubjects(parsed)
  };
  return { questions: parsed, diagnostics };
}

function emptyDiagnostics() {
  return { inputLines: 0, detectedBlocks: 0, rawQuestions: 0, parsedQuestions: 0, missingOptions: 0, missingAnswers: 0, emptyQuestions: 0, brokenQuestions: 0, healthyQuestions: 0, warningQuestions: 0, criticalQuestions: 0, matchingQuestions: 0, assertionReasonQuestions: 0, statementQuestions: 0, standardQuestions: 0, duplicateQuestions: 0, uniqueQuestions: 0, duplicateGroups: 0, duplicateIndexes: [], confidence: 0, healthScore: 0, healthStatus: 'EMPTY', questionHealth: [], subjects: [], subjectSummary: [] };
}

function normalizeLines(raw) {
  let text = String(raw || '')
    .normalize('NFKC')
    .replace(/\r/g, '')
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\u00A0/g, ' ')
    // Preserve Markdown emphasis when it marks the correct option.
    .replace(/\*\*\s*(\(?[A-D1-4ఎఏబిసిడీ]+\)?\s*[\).:\-]\s*[^*\n]+?)\s*\*\*/giu, '$1 ★')
    .replace(/\*\s*(\(?[A-D1-4ఎఏబిసిడీ]+\)?\s*[\).:\-]\s*[^*\n]+?)\s*\*/giu, '$1 ★')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^\s*(?:ప్రశ్న|Question|Q)\s*(\d{1,4})\s*\.\.+/gimu, 'ప్రశ్న $1. ');

  // Preserve WhatsApp message content; remove only timestamp + sender prefix.
  text = text.split('\n').map(line => line.replace(WHATSAPP_PREFIX_RE, '')).join('\n');

  // Recover pasted text where question starts/options were collapsed onto one line.
  text = text
    .replace(/\s+((?:ప్రశ్న|Question|Q)\s*\d{1,4}\s*(?:\.{1,3}|[:\)]))/giu, '\n$1')
    .replace(/([^\n])\s+(\d{1,4}\s*\.{1,3}\s*(?=[^0-9\s]))/gu, '$1\n$2')
    // Split collapsed inline options only at a real option boundary.
    // Do not search for Telugu aliases inside normal Telugu words: the old
    // rule split words ending in `డి:` and treated that fragment as option D.
    .replace(/([^\n])\s+(\([A-D]\)\s*|[A-D]\s*[\).:]\s*)/gu, '$1\n$2')
    .replace(/([^\n])\s+((?:Answer|Ans|Correct\s*Answer|Right\s*Answer|జవాబు|సమాధానం)\s*[:.\-])/giu, '$1\n$2')
    .replace(/((?:Answer|Ans|Correct\s*Answer|Right\s*Answer|జవాబు|సమాధానం)\s*[:.\-]?\s*[A-D1-4](?:\s*[).])?[^\n]*?)\s+(?=(?:ప్రశ్న|Question|Q)\s*\d{1,4}\s*[.):]|\d{1,4}\s*[.):]\s*[^0-9])/giu, '$1\n');

  const normalized = text.split('\n')
    .map(x => x.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

  const joined = [];
  for (let i = 0; i < normalized.length; i++) {
    const line = normalized[i];
    if (isStandaloneMarker(line) && i + 2 < normalized.length && /^(?:Answer|Ans|Correct\s*Answer|Right\s*Answer|జవాబు|సమాధానం)\s*[:.\-]?$/iu.test(normalized[i + 1]) && optionKeyFromLine(normalized[i + 2])) {
      joined.push(`${line} ${normalized[i + 1]} ${normalized[i + 2]}`);
      i += 2;
    } else if (/^(?:Answer|Ans|Correct\s*Answer|Right\s*Answer|జవాబు|సమాధానం)\s*[:.\-]?$/iu.test(line) && i + 1 < normalized.length && optionKeyFromLine(normalized[i + 1])) {
      joined.push(`${line} ${normalized[++i]}`);
    } else if (isStandaloneMarker(line) && i + 1 < normalized.length && optionKeyFromLine(normalized[i + 1])) {
      joined.push(`${line} ${normalized[++i]}`);
    } else {
      joined.push(line);
    }
  }

  return joined
    .map(cleanLeadingMarkerPlacement)
    .filter(Boolean)
    .filter(line => !isChatNoise(line));
}

function isStandaloneMarker(line) {
  return new RegExp(`^[${MARK_CHARS}]+$`, 'u').test(String(line || '').trim());
}

function cleanLeadingMarkerPlacement(line) {
  return String(line || '')
    .replace(new RegExp(`^([${MARK_CHARS}])\\s*(\\(?[A-D1-4ఎఏబిసిడీ]+\\)?\\s*[\\).:\\-]?)\\s*`, 'iu'), '$2 $1 ')
    .replace(new RegExp(`^(\\(?[A-D1-4ఎఏబిసిడీ]+\\)?\\s*[\\).:\\-]?)\\s*([${MARK_CHARS}])\\s*`, 'iu'), '$1 $2 ')
    .trim();
}

function isChatNoise(line) {
  const value = String(line || '').trim();
  return CHAT_LABEL_RE.test(value) || /^<Media omitted>$/iu.test(value);
}

function cleanHeading(line) {
  return String(line || '').replace(/^#+\s*/, '').replace(/^\*+|\*+$/g, '').replace(/[:：]$/, '').trim();
}

function isHeading(line) {
  return HEADING_RE.test(cleanHeading(line));
}

function subjectFromHeading(line) {
  const clean = cleanHeading(line);
  if (!isHeading(clean) || TEST_TITLE_RE.test(clean)) return '';
  return SUBJECT_ALIASES.get(clean.toLocaleLowerCase('en-IN')) || clean;
}

function summarizeSubjects(questions = []) {
  const map = new Map();
  questions.forEach(question => {
    const subject = String(question?.subject || 'General').trim() || 'General';
    map.set(subject, (map.get(subject) || 0) + 1);
  });
  return [...map.entries()].map(([subject, questions]) => ({ subject, questions, marks: questions }));
}

function questionStart(line) {
  let match = String(line || '').match(Q_PREFIX_RE);
  if (match) return { number: +match[1], text: match[2] || '' };
  match = String(line || '').match(Q_NUMBER_RE);
  if (match) return { number: +match[1], text: match[2] || '' };
  return null;
}

function optionKeyFromLine(line) {
  let match = String(line || '').match(LETTER_OPTION_RE);
  if (match) {
    const rawKey = match[1] || match[2];
    return { scheme: 'letter', key: optionLetter(rawKey), text: match[3] || '' };
  }
  match = String(line || '').match(NUMBER_OPTION_RE);
  if (match) {
    const rawKey = match[1] || match[2];
    return { scheme: 'number', key: toLetter(rawKey), text: match[3] || '' };
  }
  return null;
}

function isExplicitAnswerLine(line) {
  return ANSWER_LINE_RE.test(String(line || '').trim());
}

function optionProgress(lines) {
  const keys = new Set();
  for (const line of lines.slice(questionStart(lines[0]) ? 1 : 0)) {
    const option = optionKeyFromLine(line);
    if (option) keys.add(option.key);
  }
  return keys.size;
}

function looksLikeUnnumberedQuestionStart(lines, index) {
  const line = lines[index];
  if (!line || questionStart(line) || optionKeyFromLine(line) || isExplicitAnswerLine(line) || isQuestionStructure(line)) return false;
  let expected = 0;
  for (let i = index + 1; i < Math.min(lines.length, index + 8); i++) {
    if (questionStart(lines[i])) break;
    const option = optionKeyFromLine(lines[i]);
    if (!option) continue;
    if (option.key === ['A', 'B', 'C', 'D'][expected]) expected++;
    if (expected >= 2) return true;
  }
  return false;
}

/**
 * Recover accidental line breaks such as:
 *   24. 485.267 లో 'సహ
 *   25. సహస్రాంశం' స్థానంలో ఉన్న అంకె ఏది?
 *   A) ...
 *
 * The first fragment has no options, while the next numbered fragment owns the
 * options. Older builds silently dropped the first fragment and reduced the
 * imported count. We merge only an option-less block into the immediately
 * following block, keeping the first question number and all text.
 */
function recoverOrphanQuestionBlocks(blocks) {
  const recovered = [];

  for (let index = 0; index < blocks.length; index++) {
    const currentBlock = blocks[index];
    const nextBlock = blocks[index + 1];
    const current = currentBlock.lines || currentBlock;
    const next = nextBlock ? (nextBlock.lines || nextBlock) : null;
    const sameSubject = !nextBlock || !currentBlock.subject || !nextBlock.subject || currentBlock.subject === nextBlock.subject;
    const currentHasOptions = optionProgress(current) > 0;
    const nextHasOptions = next ? optionProgress(next) > 0 : false;

    const first = questionStart(current[0]);
    const nextFirst = next ? questionStart(next[0]) : null;
    const currentText = [first?.text || current[0], ...current.slice(1)].filter(Boolean).join(' ');
    const looksCutOff = !/[?.!।:：]$/u.test(currentText.trim());
    const isSequentialFragment = Boolean(first && nextFirst && nextFirst.number === first.number + 1);

    const likelyNumberedFragment = currentText.length < 180 || looksCutOff;
    if (!currentHasOptions && next && nextHasOptions && likelyNumberedFragment && isSequentialFragment && sameSubject) {
      const nextText = nextFirst?.text || next[0];
      const mergedFirst = `${first?.number || nextFirst?.number || recovered.length + 1}. ${currentText} ${nextText}`.trim();
      recovered.push({ subject: currentBlock.subject || nextBlock.subject, lines: [mergedFirst, ...next.slice(1)] });
      index++;
      continue;
    }

    recovered.push(currentBlock.lines ? currentBlock : { subject: 'General', lines: currentBlock });
  }

  return recovered;
}

function splitQuestionBlocks(lines, defaultSubject = 'General') {
  const blocks = [];
  let current = [];
  let currentSubject = defaultSubject || 'General';

  const pushCurrent = () => {
    if (!current.length) return;
    blocks.push({ subject: currentSubject, lines: current });
    current = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (isHeading(line)) {
      const nextSubject = subjectFromHeading(line);
      if (nextSubject) {
        pushCurrent();
        currentSubject = nextSubject;
      }
      continue;
    }

    const start = questionStart(line);
    if (!current.length) {
      if (start) current = [line];
      continue;
    }

    if (!start) {
      current.push(line);
      continue;
    }

    const progress = optionProgress(current);
    const option = optionKeyFromLine(line);
    const expected = ['A', 'B', 'C', 'D'][progress] || '';
    const isExpectedNumericOption = Boolean(option && option.scheme === 'number' && option.key === expected && progress < 4);
    const currentHasAnswer = current.some(isExplicitAnswerLine) || current.some(hasCorrectAnswerMarker);
    const currentIsCompleteQuestion = progress >= 4 || (progress >= 2 && currentHasAnswer);
    // 1), 2), 3), 4) are numeric options until the current MCQ has four options.
    // Once A-D (or another complete answer pattern) has finished, ANY later
    // numbered line starts a new question. Question numbers are allowed to
    // have gaps (for example 4 -> 6 or 10 -> 12). Older builds required strict
    // sequential numbering and merged all questions after a missing number.
    if (isExpectedNumericOption || !currentIsCompleteQuestion) {
      current.push(line);
      continue;
    }

    pushCurrent();
    current = [line];
  }

  pushCurrent();
  return blocks;
}

function parseBlock(lines, index, defaultSubject) {
  const first = questionStart(lines[0]);
  const body = [first?.text || lines[0], ...lines.slice(1)].filter(Boolean);
  const questionLines = [];
  const options = { A: '', B: '', C: '', D: '' };
  let answer = '';
  let currentOption = null;

  for (const original of body) {
    let line = String(original || '').trim();
    if (!line) continue;

    const explicit = line.match(ANSWER_LINE_RE);
    if (explicit) {
      answer = toLetter(explicit[1]);
      currentOption = null;
      continue;
    }

    const option = optionKeyFromLine(line);
    if (option) {
      let text = option.text.trim();
      const prefixLength = Math.max(0, line.indexOf(option.text));
      const hasMark = hasCorrectAnswerMarker(text) || hasCorrectAnswerMarker(line.slice(0, prefixLength));
      if (hasMark) answer = option.key;

      text = stripMarks(text);
      const embedded = extractEmbeddedAnswer(text);
      if (embedded.answer) answer = embedded.answer;
      options[option.key] = appendText(options[option.key], embedded.text);
      currentOption = option.key;
      continue;
    }

    if (currentOption && !isQuestionStructure(line) && !questionStart(line)) {
      if (hasCorrectAnswerMarker(line)) answer = currentOption;
      const embedded = extractEmbeddedAnswer(stripMarks(line));
      if (embedded.answer) answer = embedded.answer;
      options[currentOption] = appendText(options[currentOption], embedded.text);
    } else {
      currentOption = null;
      questionLines.push(formatQuestionLine(stripMarks(line)));
    }
  }

  let questionText = cleanDanglingDelimiters(compactQuestion(questionLines));
  // Remove a duplicated inner question label such as `1. ప్రశ్న 1 ...` in student view.
  questionText = questionText.replace(/^(?:ప్రశ్న|Question|Q)\s*\d{1,4}\s*[.):-]?\s*/iu, '').trim();
  return {
    id: `q${Date.now()}_${index}`,
    sourceNumber: first?.number || index + 1,
    subject: defaultSubject || 'General',
    question: questionText,
    type: detectQuestionType(questionText),
    options: ['A', 'B', 'C', 'D'].map(key => ({ key, text: cleanDanglingDelimiters(options[key] || '') })),
    answer: answer || '',
    marks: 1
  };
}



function cleanDanglingDelimiters(value) {
  let text = String(value || '').trim();
  const pairs = [['(', ')'], ['[', ']'], ['{', '}']];
  for (const [open, close] of pairs) {
    const opens = [...text].filter(ch => ch === open).length;
    const closes = [...text].filter(ch => ch === close).length;
    if (opens > closes && text.endsWith(open)) text = text.slice(0, -1).trim();
  }
  return text.replace(/\s{2,}/g, ' ').trim();
}

function detectQuestionType(questionText) {
  const text = String(questionText || '');
  if (/(?:Assertion|నిశ్చయం|ప్రతిపాదన)\s*[:.\-]/iu.test(text) && /(?:Reason|కారణం|హేతువు)\s*[:.\-]/iu.test(text)) return 'assertion-reason';
  const matchingSignals = [
    /(?:జతపరచండి|సరిపోల్చండి|Match\s+the\s+following|Matching)/iu,
    /(?:List|జాబితా)\s*[-:]?\s*(?:I|II|1|2)/iu,
    /(?:A|I)\s*[-–—:]\s*\d.+(?:B|II)\s*[-–—:]\s*\d/isu
  ];
  if (matchingSignals.some(re => re.test(text))) return 'matching';
  const romanCount = (text.match(/(?:^|\n)\s*(?:I|II|III|IV|V|i|ii|iii|iv|v)\s*[).:\-]/gu) || []).length;
  if (romanCount >= 2 || /(?:క్రింది|పై)\s+(?:ప్రకటనలు|వాక్యాలు|statements)/iu.test(text)) return 'statement';
  return 'standard';
}

/** Normalized key used for exact + punctuation/spacing tolerant duplicate checks. */
export function normalizeQuestionKey(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-IN')
    .replace(/^(?:q(?:uestion)?|ప్రశ్న)?\s*\d{1,4}\s*[.):\-]*\s*/iu, '')
    .replace(/[“”‘’'"`´]/gu, '')
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function findDuplicateQuestions(questions = []) {
  const byKey = new Map();
  questions.forEach((question, index) => {
    const key = normalizeQuestionKey(question?.question);
    // Very short labels such as “A” are intentionally ignored to avoid false matches.
    if (!key || key.length < 8) return;
    const indexes = byKey.get(key) || [];
    indexes.push(index);
    byKey.set(key, indexes);
  });

  const groups = [...byKey.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([key, indexes], groupIndex) => ({
      id: `duplicate-${groupIndex + 1}`,
      key,
      indexes,
      firstIndex: indexes[0],
      duplicateIndexes: indexes.slice(1),
      question: String(questions[indexes[0]]?.question || '').trim()
    }));

  const duplicateIndexes = [...new Set(
    groups.flatMap(group => group.duplicateIndexes)
  )].sort((a, b) => a - b);

  return {
    rawCount: questions.length,
    uniqueCount: Math.max(0, questions.length - duplicateIndexes.length),
    duplicateCount: duplicateIndexes.length,
    groups,
    duplicateIndexes
  };
}

/**
 * Phase 4 Step 1 health engine.
 * Returns per-question issues, severity and a deterministic 0–100 score.
 */
export function analyzeQuestionHealth(questions = []) {
  const duplicateReport = findDuplicateQuestions(questions);
  const duplicateSet = new Set(duplicateReport.duplicateIndexes);
  const counts = {
    emptyQuestion: 0,
    missingOptions: 0,
    missingAnswer: 0,
    brokenQuestion: 0,
    duplicate: duplicateReport.duplicateCount
  };

  const reports = questions.map((question, index) => {
    const issues = [];
    const text = String(question?.question || '').trim();
    const options = Array.isArray(question?.options) ? question.options : [];
    const optionMap = new Map(options.map(option => [String(option?.key || '').toUpperCase(), String(option?.text || '').trim()]));
    const filled = [...optionMap.values()].filter(Boolean);
    const answer = String(question?.answer || '').trim().toUpperCase();

    const add = (type, severity, message, penalty) => issues.push({ type, severity, message, penalty });
    if (!text) add('emptyQuestion', 'critical', 'Question text missing', 55);
    else if (text.length < 3) add('brokenQuestion', 'critical', 'Question text is too short', 35);

    const missingOptionCount = Math.max(0, 4 - filled.length);
    if (missingOptionCount) add('missingOptions', missingOptionCount >= 2 ? 'critical' : 'warning', `${missingOptionCount} option(s) missing`, Math.min(45, missingOptionCount * 12));

    if (!['A', 'B', 'C', 'D'].includes(answer)) add('missingAnswer', 'critical', 'Correct answer missing', 30);
    else if (!optionMap.get(answer)) add('brokenQuestion', 'critical', `Answer ${answer} points to an empty option`, 30);

    const normalizedOptions = filled.map(value => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''));
    if (normalizedOptions.some((value, i) => value && normalizedOptions.indexOf(value) !== i)) {
      add('brokenQuestion', 'warning', 'Two or more options have the same text', 15);
    }
    if (options.length !== 4) add('brokenQuestion', 'warning', `Expected 4 option rows; found ${options.length}`, 10);
    if (duplicateSet.has(index)) add('duplicate', 'warning', 'Duplicate question', 15);

    const uniqueTypes = new Set(issues.map(issue => issue.type));
    uniqueTypes.forEach(type => { if (type in counts && type !== 'duplicate') counts[type] += 1; });
    const score = Math.max(0, 100 - issues.reduce((sum, issue) => sum + issue.penalty, 0));
    const severity = issues.some(issue => issue.severity === 'critical') ? 'critical' : issues.length ? 'warning' : 'healthy';
    return { index, score, severity, issues };
  });

  const healthScore = reports.length ? Math.round(reports.reduce((sum, report) => sum + report.score, 0) / reports.length) : 0;
  const healthyQuestions = reports.filter(report => report.severity === 'healthy').length;
  const warningQuestions = reports.filter(report => report.severity === 'warning').length;
  const criticalQuestions = reports.filter(report => report.severity === 'critical').length;
  const status = !reports.length ? 'EMPTY' : criticalQuestions || healthScore < 60 ? 'CRITICAL' : warningQuestions || healthScore < 100 ? 'WARNING' : 'HEALTHY';

  return {
    totalQuestions: reports.length,
    healthyQuestions,
    warningQuestions,
    criticalQuestions,
    healthScore,
    status,
    counts,
    questions: reports,
    duplicateReport
  };
}



/** Phase 5 Step 1: detects the structure of an MCQ without changing its content. */
export function classifyQuestionType(question = {}) {
  const text = String(question?.question || '').normalize('NFKC').trim();
  const lower = text.toLocaleLowerCase();
  const romanCount = (text.match(/(?:^|\n)\s*(?:i{1,3}|iv|v|vi{0,3}|ix|x|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])\s*[\).:\-]/giu) || []).length;
  const numberedListCount = (text.match(/(?:^|\n)\s*[1-4]\s*[\).:\-]/gu) || []).length;
  const pairSignals = (text.match(/(?:a\s*[-–—]\s*\d|[a-d]\s*[-–—]\s*[1-4]|i\s*[-–—]\s*\d)/giu) || []).length;
  const hasAssertion = /assertion|reason|నిశ్చయం|కారణం|ప్రతిపాదన\s*[-:]?\s*[a]/iu.test(text);
  const hasMatching = /జతపరచండి|సరిపోల్చండి|match\s+(?:the\s+)?following|list\s*[-–—]?\s*i|column\s*[-–—]?\s*[ab]/iu.test(text) || pairSignals >= 2;
  const hasPair = /సరైన\s*జత|సరికాని\s*జత|correct\s*pair|incorrect\s*pair/iu.test(text);
  const hasStatements = romanCount >= 2 || numberedListCount >= 3 || /క్రింది\s+(?:ప్రకటన|వాక్య)|statements?\s+(?:given|below)|పై\s+వాటిలో/iu.test(text);

  let type = 'standard';
  let label = 'Standard MCQ';
  let confidence = 72;
  if (hasAssertion) { type = 'assertion-reason'; label = 'Assertion–Reason'; confidence = 94; }
  else if (hasMatching) { type = 'matching'; label = 'Matching'; confidence = 92; }
  else if (hasPair) { type = 'pair'; label = 'Correct / Incorrect Pair'; confidence = 90; }
  else if (hasStatements) { type = 'statement'; label = 'Statement Type'; confidence = romanCount >= 2 ? 91 : 84; }

  return { type, label, confidence, signals: { romanCount, numberedListCount, pairSignals, hasAssertion, hasMatching, hasPair, hasStatements } };
}

/** Returns type counts, percentages and answer-key distribution for an exam. */
export function analyzeQuestionDistribution(questions = []) {
  const typeOrder = ['standard', 'statement', 'matching', 'pair', 'assertion-reason'];
  const labels = {
    standard: 'Standard MCQ',
    statement: 'Statement Type',
    matching: 'Matching',
    pair: 'Correct / Incorrect Pair',
    'assertion-reason': 'Assertion–Reason'
  };
  const types = Object.fromEntries(typeOrder.map(type => [type, 0]));
  const answers = { A: 0, B: 0, C: 0, D: 0, missing: 0 };
  const details = questions.map((question, index) => {
    const classification = classifyQuestionType(question);
    types[classification.type] = (types[classification.type] || 0) + 1;
    const answer = String(question?.answer || '').trim().toUpperCase();
    if (answer in answers && answer !== 'missing') answers[answer] += 1;
    else answers.missing += 1;
    return { index, ...classification };
  });
  const total = questions.length;
  const typeSummary = typeOrder.map(type => ({
    type,
    label: labels[type],
    count: types[type] || 0,
    percentage: total ? Math.round(((types[type] || 0) / total) * 100) : 0
  }));
  const validAnswers = answers.A + answers.B + answers.C + answers.D;
  const expected = validAnswers ? validAnswers / 4 : 0;
  const maxDeviation = validAnswers ? Math.max(...['A','B','C','D'].map(key => Math.abs(answers[key] - expected))) : 0;
  const answerBalanceScore = validAnswers ? Math.max(0, Math.round(100 - (maxDeviation / Math.max(1, expected)) * 50)) : 0;
  return { total, types, typeSummary, answers, answerBalanceScore, details };
}

/** Keeps the first occurrence and removes later normalized duplicates. */
export function removeDuplicateQuestions(questions = []) {
  const report = findDuplicateQuestions(questions);
  const remove = new Set(report.duplicateIndexes);
  const uniqueQuestions = questions
    .filter((_, index) => !remove.has(index))
    .map((question, index) => ({
      ...question,
      id: question?.id || `q${Date.now()}_${index}`,
      options: (question?.options || []).map(option => ({ ...option }))
    }));

  return {
    questions: uniqueQuestions,
    removedCount: report.duplicateCount,
    report
  };
}

function appendText(existing, next) {
  const value = String(next || '').trim();
  if (!value) return existing || '';
  return existing ? `${existing} ${value}` : value;
}

function optionLetter(value) {
  const raw = String(value || '').trim();
  const upper = raw.toUpperCase();
  return ({ 'ఎ': 'A', 'ఏ': 'A', 'బి': 'B', 'బీ': 'B', 'సి': 'C', 'సీ': 'C', 'డి': 'D', 'డీ': 'D' })[raw] || upper;
}

function toLetter(value) {
  const raw = String(value || '').trim();
  const upper = raw.toUpperCase();
  return ({ 1: 'A', 2: 'B', 3: 'C', 4: 'D', 'ఎ': 'A', 'ఏ': 'A', 'బి': 'B', 'బీ': 'B', 'సి': 'C', 'సీ': 'C', 'డి': 'D', 'డీ': 'D' })[raw] || upper;
}

function stripMarks(text) {
  return String(text || '')
    .replace(MARKS_GLOBAL, '')
    .replace(/\b(?:correct|right\s*answer|సరి(?:యైన|అయిన)\s*(?:జవాబు|సమాధానం))\b/giu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function hasCorrectAnswerMarker(text) {
  const value = String(text || '').trim();
  if (MARK_RE.test(value)) return true;
  if (/\b(?:correct|right\s*answer|సరి(?:యైన|అయిన)\s*(?:జవాబు|సమాధానం))\b/iu.test(value)) return true;
  if (/(?:^|\s)[✅✓✔☑](?:\s|$)/u.test(value)) return true;
  return false;
}

function extractEmbeddedAnswer(text) {
  let value = String(text || '');
  let found = '';
  const regex = new RegExp(`(?:${ANSWER_WORDS})\\s*[:.\\-]?\\s*([A-D1-4]|ఎ|ఏ|బి|బీ|సి|సీ|డి|డీ)(?:\\s*[\\).:\\-]?)?`, 'giu');
  value = value.replace(regex, (_, key) => {
    found = toLetter(key);
    return '';
  });
  return { text: value.replace(/\s{2,}/g, ' ').trim(), answer: found };
}

function isQuestionStructure(line) {
  return ROMAN_RE.test(line)
    || LIST_HEADER_RE.test(line)
    || /^పై\s/u.test(line)
    || /^(?:ప్రకటన|వ్యాఖ్య|Statement)\s*[I1]/iu.test(line)
    || /^(?:Assertion|Reason|నిశ్చయం|కారణం)\s*[:.\-]/iu.test(line);
}

function formatQuestionLine(line) {
  return isQuestionStructure(line) ? `\n${line}` : line;
}

function compactQuestion(lines) {
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

export function blankQuestion(subject = 'General') {
  return { id: `q${Date.now()}`, subject, question: '', type: 'standard', options: [{ key: 'A', text: '' }, { key: 'B', text: '' }, { key: 'C', text: '' }, { key: 'D', text: '' }], answer: '', marks: 1 };
}

export function studentShuffle(questions, seedText = '') {
  const bySubject = {};
  questions.forEach(question => {
    const subject = question.subject || 'General';
    (bySubject[subject] ||= []).push(question);
  });
  const random = mulberry32(hash(seedText || 'KSR'));
  let output = [];
  Object.keys(bySubject).forEach(subject => output = output.concat(shuffle([...bySubject[subject]], random)));
  return output;
}

function shuffle(items, random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function hash(value) {
  let result = 1779033703;
  for (let i = 0; i < value.length; i++) {
    result = Math.imul(result ^ value.charCodeAt(i), 3432918353);
    result = result << 13 | result >>> 19;
  }
  return result >>> 0;
}

function mulberry32(seed) {
  return function () {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

