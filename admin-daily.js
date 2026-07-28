import {
  auth,
  db,
  onAuthStateChanged,
  signOut,
  collection,
  getDocs,
  getDoc,
  addDoc,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  writeBatch,
  query,
  where,
  $,
  show,
  esc
} from './app.js?v=20260727-create-exam-core-v4';

import * as Parser from './parser.js?v=20260729-sprint3-resolver-v1';

// Parser compatibility layer: using a namespace import prevents the whole Create Exam
// module from failing when GitHub temporarily serves an older parser.js that lacks one
// of the newer Phase 3/4/5 named exports.
const parseQuestionsDetailed = Parser.parseQuestionsDetailed || ((raw, subject='General') => ({
  questions: (Parser.parseQuestions ? Parser.parseQuestions(raw, subject) : []),
  diagnostics: { healthScore: 0, missingAnswers: 0, criticalQuestions: 0 }
}));
const normalizeQuestionKey = Parser.normalizeQuestionKey || (value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim());
const findDuplicateQuestions = Parser.findDuplicateQuestions || (list => {
  const seen = new Map(), groups = [];
  (list || []).forEach((q, index) => {
    const key = normalizeQuestionKey(q.question || q.q || '');
    if (!key) return;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(index);
  });
  seen.forEach(indexes => { if (indexes.length > 1) groups.push({ key: normalizeQuestionKey((list[indexes[0]] || {}).question || ''), indexes }); });
  return groups;
});
const removeDuplicateQuestions = Parser.removeDuplicateQuestions || (list => {
  const seen = new Set();
  return (list || []).filter(q => {
    const key = normalizeQuestionKey(q.question || '');
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
});
const analyzeQuestionHealth = Parser.analyzeQuestionHealth || (list => ({
  total: (list || []).length,
  healthScore: (list || []).length ? 100 : 0,
  missingAnswers: (list || []).filter(q => !q.answer).length,
  criticalQuestions: (list || []).filter(q => !(q.question || '').trim() || (q.options || []).length < 4 || !q.answer).length,
  issues: []
}));
const analyzeQuestionDistribution = Parser.analyzeQuestionDistribution || (list => ({ total: (list || []).length }));
const blankQuestion = Parser.blankQuestion || (subject => ({
  id: `q${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
  subject: subject || 'General', question: '',
  options: ['A','B','C','D'].map(key => ({ key, text: '' })), answer: 'A'
}));

window.__KSR_ADMIN_DAILY_MODULE_LOADED__ = true;


window.addEventListener('error', event => {
  console.error('KSR Create Exam runtime error:', event.error || event.message);
  const box = document.getElementById('msg');
  if (box) {
    box.className = 'msg err';
    box.textContent = `Create Exam error: ${event.message || 'Unknown error'}. Please refresh once.`;
  }
});
window.addEventListener('unhandledrejection', event => {
  console.error('KSR Create Exam promise error:', event.reason);
  const box = document.getElementById('msg');
  if (box) {
    box.className = 'msg err';
    box.textContent = `Create Exam error: ${event.reason?.message || event.reason || 'Unknown error'}`;
  }
});

let user = null;
let questions = [];
let subjects = [{ name: 'General', rawBits: '', questions: [] }];
let activeSubjectIndex = 0;
let previewQuestions = [];
let previewIndex = 0;
let lastCodes = [];
let lastExam = null;
let institutes = [];
let batches = [];
let batchStudents = [];
let lastImportSummary = null;
let lastDuplicateRemovalSnapshot = null;
let healthIssueFilter = 'all';
let healthIssueCursor = -1;
let activeHealthIssue = null;

const LAST_GENERATED_CODES_KEY = 'ksrLastGeneratedCodesV1';

// Create Exam Core Bridge V3: available even if a later optional enterprise panel fails.
window.__KSR_CREATE_EXAM_CORE__ = {
  parseRawQuestions() {
    const raw = $('rawBits')?.value || '';
    const subject = cleanSubjectName($('subjectName')?.value || 'General');
    const result = parseQuestionsDetailed(raw, subject);
    if (!result.questions.length) {
      show('Questions detect avvaledu. Question number + A/B/C/D options format check cheyyandi.', 'err');
      return { ok:false, count:0 };
    }
    questions = result.questions.map((q, index) => ({
      ...q,
      id: q.id || `q${Date.now()}_${index}`,
      subject,
      options: (q.options || []).map(o => ({...o}))
    }));
    lastImportSummary = result.diagnostics;
    currentSubject().name = subject;
    currentSubject().questions = questions.map(q => ({...q, options:(q.options||[]).map(o=>({...o}))}));
    currentSubject().rawBits = raw;
    currentSubject().parserDiagnostics = { ...result.diagnostics, parsedAt: Date.now() };
    if ($('subjectQuestionCount')) $('subjectQuestionCount').value = questions.length;
    renderSubjectTabs();
    renderEditor();
    renderDuplicateEngine();
    renderQuestionTypeAnalyzer();
    renderSmartAnalytics();
    renderExamQuality();
    renderHealth();
    if ($('questionEditor')) $('questionEditor').dataset.open = '1';
    if ($('parseBtn')) $('parseBtn').textContent = 'Save Edits & Close';
    saveDraft();
    flash(`${questions.length} questions detected ✅ · Health ${result.diagnostics.healthScore}%`);
    return { ok:true, count:questions.length, diagnostics:result.diagnostics };
  },
  async reloadBatchStudents() { await loadBatchStudents(); },
  getQuestionCount() { return questions.length; }
};

function persistGeneratedCodes() {
  try {
    localStorage.setItem(LAST_GENERATED_CODES_KEY, JSON.stringify({
      savedAt: Date.now(),
      exam: lastExam,
      codes: lastCodes
    }));
  } catch (error) {
    console.warn('Codes local backup failed:', error);
  }
}

function restoreGeneratedCodes() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAST_GENERATED_CODES_KEY) || 'null');
    if (!saved || !Array.isArray(saved.codes) || !saved.codes.length || !saved.exam) return false;
    lastCodes = saved.codes;
    lastExam = saved.exam;
    if ($('resultExamId')) $('resultExamId').value = lastExam.examId || lastExam.examCode || '';
    if ($('codesExamId')) $('codesExamId').value = lastExam.examId || lastExam.examCode || '';
    renderCodes();
    flash(`${lastCodes.length} saved codes restored ✅`);
    return true;
  } catch (error) {
    console.warn('Codes restore failed:', error);
    return false;
  }
}

let __draftTimer=null,__healthTimer=null;
function scheduleDraftSave(){clearTimeout(__draftTimer);__draftTimer=setTimeout(saveDraft,350)}
function scheduleHealth(){clearTimeout(__healthTimer);__healthTimer=setTimeout(renderHealth,120)}


function cleanSubjectName(value) {
  return String(value || '').trim() || `Subject ${activeSubjectIndex + 1}`;
}

function currentSubject() {
  if (!subjects[activeSubjectIndex]) {
    subjects[activeSubjectIndex] = { name: `Subject ${activeSubjectIndex + 1}`, rawBits: '', questions: [] };
  }
  return subjects[activeSubjectIndex];
}

function commitCurrentSubject() {
  const subject = currentSubject();
  subject.name = cleanSubjectName($('subjectName')?.value || subject.name);
  subject.rawBits = $('rawBits')?.value || '';
  subject.questions = questions.map(q => ({ ...q, subject: subject.name, options: (q.options || []).map(o => ({ ...o })) }));
  if ($('qbSubject')) $('qbSubject').value = subject.name;
}

function loadActiveSubject() {
  const subject = currentSubject();
  questions = (subject.questions || []).map(q => ({ ...q, subject: subject.name, options: (q.options || []).map(o => ({ ...o })) }));
  if ($('subjectName')) $('subjectName').value = subject.name || '';
  if ($('qbSubject')) $('qbSubject').value = subject.name || 'General';
  if ($('rawBits')) $('rawBits').value = subject.rawBits || questionsToText(questions);
  if ($('subjectQuestionCount')) $('subjectQuestionCount').value = questions.length;
  if ($('questionEditor')) { $('questionEditor').innerHTML = ''; $('questionEditor').dataset.open = '0'; }
  if ($('parseBtn')) $('parseBtn').textContent = 'Parse Questions';
  renderSubjectTabs();
  renderDuplicateEngine();
  renderQuestionTypeAnalyzer();
  renderSmartAnalytics();
  renderExamQuality();
  renderHealth();
  if (typeof renderBulkQuestionManager === 'function') renderBulkQuestionManager();
}

function renderSubjectTabs() {
  const box = $('subjectTabs');
  if (!box) return;
  box.innerHTML = subjects.map((subject, index) => `
    <button type="button" class="subjectTab ${index === activeSubjectIndex ? 'active' : ''}" data-subject-index="${index}">
      <span>${esc(subject.name || `Subject ${index + 1}`)}</span>
      <b>${(subject.questions || []).length}</b>
    </button>`).join('');
  box.querySelectorAll('[data-subject-index]').forEach(btn => {
    btn.onclick = () => {
      sync();
      commitCurrentSubject();
      activeSubjectIndex = Number(btn.dataset.subjectIndex);
      loadActiveSubject();
      saveDraft();
    };
  });
}

function getAllQuestions() {
  sync();
  commitCurrentSubject();
  return subjects.flatMap((subject, subjectIndex) => (subject.questions || []).map((q, questionIndex) => ({
    ...q,
    subject: subject.name,
    subjectIndex,
    subjectQuestionIndex: questionIndex,
    options: (q.options || []).map(o => ({ ...o }))
  })));
}

function validateQuestionList(list) {
  const health = analyzeQuestionHealth(list);
  const issues = [];
  health.questions.forEach(report => {
    const question = list[report.index] || {};
    const subjectIndex = Number.isInteger(question.subjectIndex) ? question.subjectIndex : activeSubjectIndex;
    const questionIndex = Number.isInteger(question.subjectQuestionIndex) ? question.subjectQuestionIndex : report.index;
    const label = question.subject ? `${question.subject} Q${questionIndex + 1}` : `Q${questionIndex + 1}`;
    report.issues.forEach(issue => issues.push({
      index: report.index,
      subjectIndex,
      questionIndex,
      label,
      type: issue.type,
      severity: issue.severity,
      score: report.score,
      text: `${label}: ${issue.message}`
    }));
  });
  return issues;
}



function renderQuestionTypeAnalyzer() {
  const box = $('questionTypeSummary');
  if (!box) return;
  const report = analyzeQuestionDistribution(questions);
  if (!report.total) {
    box.innerHTML = '<p class="small">Questions parse చేసిన తర్వాత type distribution ఇక్కడ కనిపిస్తుంది.</p>';
    return;
  }
  const typeCards = report.typeSummary.map(item => `
    <button type="button" class="questionTypeCard" data-question-type="${item.type}">
      <b>${item.count}</b><span>${esc(item.label)}</span><small>${item.percentage}%</small>
    </button>`).join('');
  const answerBars = ['A','B','C','D'].map(key => {
    const count = report.answers[key];
    const pct = report.total ? Math.round((count / report.total) * 100) : 0;
    return `<div class="answerDistributionRow"><span>${key}</span><div><i style="width:${pct}%"></i></div><b>${count}</b></div>`;
  }).join('');
  box.innerHTML = `
    <div class="questionTypeGrid">${typeCards}</div>
    <div class="answerDistributionPanel">
      <div class="answerDistributionHead"><b>Correct Answer Distribution</b><span>Balance Score <strong>${report.answerBalanceScore}%</strong></span></div>
      ${answerBars}
      ${report.answers.missing ? `<p class="typeAnalysisWarning">⚠️ Missing answers: <b>${report.answers.missing}</b></p>` : '<p class="typeAnalysisReady">✅ All parsed questions have answer keys.</p>'}
    </div>`;
  box.querySelectorAll('[data-question-type]').forEach(button => {
    button.onclick = () => {
      const match = report.details.find(item => item.type === button.dataset.questionType);
      if (match) openQuestionInEditor(match.index);
    };
  });
}


const SMART_STOP_WORDS = new Set([
  'the','and','for','with','from','this','that','which','what','when','where','who','are','was','were','has','have','into','only','correct','incorrect',
  'క్రింది','కింది','వాటిలో','పై','సరైన','సరికాని','ప్రకటనలు','ప్రకటనలను','గుర్తించండి','ఏవి','మాత్రమే','సంబంధించి','ఆధారంగా','ఇక్కడ','అనే','ఉన్న','చేయండి'
]);

function smartText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function inferDifficulty(question) {
  const text = smartText(question?.question || question?.text);
  const optionText = (question?.options || []).map(option => smartText(option?.text ?? option)).join(' ');
  const combined = `${text} ${optionText}`;
  const statementCount = (combined.match(/(?:^|\s)(?:i{1,4}|iv|v|vi{0,3}|[1-9])\s*[).:-]/gi) || []).length;
  const hardHints = /assertion|reason|matching|match the following|జతపరచండి|కారణం|నిశ్చయం|విశ్లేష|క్రమపద్ధతి|సరికాని జత/i.test(combined);
  const mediumHints = /ప్రకటన|statement|consider|observe|గమనించండి|సరైనవి|incorrect|correct/i.test(combined);
  const length = combined.length;
  if (hardHints || statementCount >= 4 || length > 700) return 'Hard';
  if (mediumHints || statementCount >= 2 || length > 330) return 'Medium';
  return 'Easy';
}

function analyzeSmartAnalytics() {
  sync();
  commitCurrentSubject();
  const all = subjects.flatMap((subject, subjectIndex) => (subject.questions || []).map((question, index) => ({
    ...question,
    subject: smartText(question.subject || subject.name || 'General'),
    lesson: smartText(question.lesson || question.topic || question.chapter || question.className || 'Unspecified'),
    subjectIndex,
    subjectQuestionIndex: index
  })));
  const subjectCounts = {};
  const lessonCounts = {};
  const difficulty = { Easy: 0, Medium: 0, Hard: 0 };
  const lengths = [];
  let optionImbalanceCount = 0;
  const keywordCounts = new Map();

  all.forEach(question => {
    const subject = question.subject || 'General';
    const lesson = question.lesson || 'Unspecified';
    subjectCounts[subject] = (subjectCounts[subject] || 0) + 1;
    const lessonKey = lesson === 'Unspecified' ? lesson : `${subject} · ${lesson}`;
    lessonCounts[lessonKey] = (lessonCounts[lessonKey] || 0) + 1;
    difficulty[inferDifficulty(question)] += 1;

    const qText = smartText(question.question || question.text);
    lengths.push(qText.length);
    const optionLengths = (question.options || []).map(option => smartText(option?.text ?? option).length).filter(Boolean);
    if (optionLengths.length >= 2) {
      const max = Math.max(...optionLengths), min = Math.min(...optionLengths), avg = optionLengths.reduce((a,b)=>a+b,0)/optionLengths.length;
      if ((max - min) > Math.max(35, avg * .75)) optionImbalanceCount += 1;
    }
    qText.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)?.forEach(word => {
      if (!SMART_STOP_WORDS.has(word) && !/^\d+$/.test(word)) keywordCounts.set(word, (keywordCounts.get(word) || 0) + 1);
    });
  });

  const total = all.length;
  const avgLength = total ? Math.round(lengths.reduce((a,b)=>a+b,0) / total) : 0;
  const longCount = lengths.filter(value => value > 300).length;
  const shortCount = lengths.filter(value => value > 0 && value < 45).length;
  const estimatedMinutes = Math.max(0, Math.ceil(difficulty.Easy * .75 + difficulty.Medium * 1.25 + difficulty.Hard * 2));
  const repeatedKeywords = [...keywordCounts.entries()].filter(([,count]) => count >= Math.max(2, Math.ceil(total * .08))).sort((a,b)=>b[1]-a[1]).slice(0,12);
  const suggestions = [];
  if (!total) suggestions.push('Questions parse చేసిన తర్వాత Smart Analytics report వస్తుంది.');
  if (total && Object.keys(subjectCounts).length < 2) suggestions.push('Exam coverage కోసం అవసరమైతే మరిన్ని subjects చేర్చండి.');
  if (total && difficulty.Hard === 0) suggestions.push('Higher-order assessment కోసం కొన్ని Hard questions చేర్చండి.');
  if (total && difficulty.Easy / total > .7) suggestions.push('Easy questions ఎక్కువగా ఉన్నాయి; Medium/Hard balance పెంచండి.');
  if (total && difficulty.Hard / total > .45) suggestions.push('Hard questions ఎక్కువగా ఉన్నాయి; student levelకి సరిపోతుందో review చేయండి.');
  if (optionImbalanceCount) suggestions.push(`${optionImbalanceCount} questionsలో option lengths unevenగా ఉన్నాయి; answer clue రాకుండా balance చేయండి.`);
  if (longCount > Math.max(3, total * .25)) suggestions.push('Long questions ఎక్కువగా ఉన్నాయి; exam completion time పెరిగే అవకాశం ఉంది.');
  if (shortCount > Math.max(3, total * .25)) suggestions.push('చాలా short questions ఉన్నాయి; wording clarityని review చేయండి.');
  if (Object.keys(lessonCounts).length === 1 && lessonCounts.Unspecified) suggestions.push('Lesson/Topic metadata add చేస్తే coverage report మరింత స్పష్టంగా ఉంటుంది.');
  if (!suggestions.length && total) suggestions.push('Current analytics balance బాగుంది. Final health reportతో పాటు ఒకసారి review చేయండి.');
  return { total, all, subjectCounts, lessonCounts, difficulty, avgLength, longCount, shortCount, optionImbalanceCount, estimatedMinutes, repeatedKeywords, suggestions };
}

function analyticsCountList(items, emptyText) {
  const entries = Object.entries(items).sort((a,b)=>b[1]-a[1]);
  if (!entries.length) return `<p class="small">${esc(emptyText)}</p>`;
  const max = Math.max(...entries.map(([,count])=>count), 1);
  return `<div class="smartCountList">${entries.map(([label,count]) => `<div class="smartCountRow"><span title="${esc(label)}">${esc(label)}</span><div><i style="width:${Math.round(count/max*100)}%"></i></div><b>${count}</b></div>`).join('')}</div>`;
}

function renderSmartAnalytics() {
  const box = $('smartAnalyticsSummary');
  if (!box) return;
  const report = analyzeSmartAnalytics();
  if (!report.total) {
    box.innerHTML = '<p class="small">Questions parse చేసిన తర్వాత Smart Analytics ఇక్కడ కనిపిస్తుంది.</p>';
    return;
  }
  const diffTotal = report.total || 1;
  box.innerHTML = `
    <div class="smartMetricGrid">
      <article><span>Total Questions</span><b>${report.total}</b></article>
      <article><span>Estimated Time</span><b>${report.estimatedMinutes} min</b></article>
      <article><span>Average Length</span><b>${report.avgLength} chars</b></article>
      <article><span>Uneven Options</span><b>${report.optionImbalanceCount}</b></article>
    </div>
    <div class="smartAnalyticsGrid">
      <article class="smartPanel"><h4>Subject Coverage</h4>${analyticsCountList(report.subjectCounts, 'Subject data లేదు.')}</article>
      <article class="smartPanel"><h4>Lesson / Topic Coverage</h4>${analyticsCountList(report.lessonCounts, 'Lesson data లేదు.')}</article>
      <article class="smartPanel"><h4>Difficulty Distribution</h4>
        <div class="difficultyBars">${['Easy','Medium','Hard'].map(level => `<div class="difficultyRow ${level.toLowerCase()}"><span>${level}</span><div><i style="width:${Math.round(report.difficulty[level]/diffTotal*100)}%"></i></div><b>${report.difficulty[level]}</b></div>`).join('')}</div>
      </article>
      <article class="smartPanel"><h4>Question Length</h4><div class="smartLengthStats"><span>Long (&gt;300)<b>${report.longCount}</b></span><span>Short (&lt;45)<b>${report.shortCount}</b></span><span>Normal<b>${Math.max(0,report.total-report.longCount-report.shortCount)}</b></span></div></article>
      <article class="smartPanel smartWide"><h4>Repeated Keywords</h4>${report.repeatedKeywords.length ? `<div class="keywordChips">${report.repeatedKeywords.map(([word,count])=>`<span>${esc(word)} <b>${count}</b></span>`).join('')}</div>` : '<p class="small">Meaningful repeated keywords గుర్తించబడలేదు.</p>'}</article>
      <article class="smartPanel smartWide"><h4>Smart Suggestions</h4><div class="smartSuggestions">${report.suggestions.map(text=>`<p>• ${esc(text)}</p>`).join('')}</div></article>
    </div>`;
}

function exportSmartAnalyticsReport() {
  const report = analyzeSmartAnalytics();
  if (!report.total) { flash('Export చేయడానికి questions లేవు'); return; }
  const lines = [
    'KSR EXAMOS · PHASE 5 STEP 2 SMART ANALYTICS',
    `Generated: ${new Date().toLocaleString()}`,
    '', `Total Questions: ${report.total}`, `Estimated Completion Time: ${report.estimatedMinutes} minutes`,
    `Average Question Length: ${report.avgLength} characters`, `Long Questions: ${report.longCount}`, `Short Questions: ${report.shortCount}`,
    `Uneven Option Length Questions: ${report.optionImbalanceCount}`, '', 'SUBJECT COVERAGE',
    ...Object.entries(report.subjectCounts).map(([key,value])=>`${key}: ${value}`), '', 'LESSON / TOPIC COVERAGE',
    ...Object.entries(report.lessonCounts).map(([key,value])=>`${key}: ${value}`), '', 'DIFFICULTY',
    ...Object.entries(report.difficulty).map(([key,value])=>`${key}: ${value}`), '', 'REPEATED KEYWORDS',
    ...(report.repeatedKeywords.length ? report.repeatedKeywords.map(([key,value])=>`${key}: ${value}`) : ['None']), '', 'SMART SUGGESTIONS',
    ...report.suggestions.map((text,index)=>`${index+1}. ${text}`)
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `KSR-Smart-Analytics-${Date.now()}.txt`;
  document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  flash('Smart Analytics report downloaded ✅');
}


function clampQualityScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function estimateBloomLevel(question = {}) {
  const text = smartText(question.question || question.text).toLowerCase();
  const combined = `${text} ${(question.options || []).map(o => smartText(o?.text ?? o)).join(' ')}`;
  if (/analyse|analyze|విశ్లేష|తులన|compare|కారణం|reason|assertion|సరికాని|వివేచ/i.test(combined)) return 'Analyse';
  if (/apply|calculate|solve|ఉపయోగించి|గణించ|పరిష్కరించ|అన్వయ/i.test(combined)) return 'Apply';
  if (/explain|describe|understand|వివరించ|అర్థం|సారాంశం|గమనించండి|ప్రకటన/i.test(combined)) return 'Understand';
  return 'Remember';
}

function analyzeExamQuality() {
  const analytics = analyzeSmartAnalytics();
  const distribution = analyzeQuestionDistribution(analytics.all || []);
  const health = analyzeQuestionHealth(analytics.all || []);
  const total = analytics.total || 0;
  const healthScore = clampQualityScore(health?.score ?? (total ? 100 : 0));
  const easy = analytics.difficulty?.Easy || 0, medium = analytics.difficulty?.Medium || 0, hard = analytics.difficulty?.Hard || 0;
  const desired = { Easy: .35, Medium: .45, Hard: .20 };
  const difficultyPenalty = total ? (Math.abs(easy/total-desired.Easy)+Math.abs(medium/total-desired.Medium)+Math.abs(hard/total-desired.Hard))*55 : 100;
  const difficultyScore = clampQualityScore(100-difficultyPenalty);
  const typeCounts = distribution?.typeCounts || distribution?.types || {};
  const typeValues = Object.values(typeCounts).map(Number).filter(v => v > 0);
  const typeVariety = typeValues.length;
  const diversityScore = clampQualityScore(total ? 35 + Math.min(45, typeVariety*12) + Math.min(20, Object.keys(analytics.subjectCounts||{}).length*5) : 0);
  const answerCounts = distribution?.answerCounts || distribution?.answers || {};
  const answerVals = ['A','B','C','D'].map(k => Number(answerCounts[k] || 0));
  const answerMean = total ? answerVals.reduce((a,b)=>a+b,0)/4 : 0;
  const answerDeviation = answerMean ? answerVals.reduce((a,b)=>a+Math.abs(b-answerMean),0)/(4*answerMean) : 1;
  const answerScore = clampQualityScore(100-answerDeviation*85);
  const subjectCount = Object.keys(analytics.subjectCounts || {}).length;
  const lessonCount = Object.keys(analytics.lessonCounts || {}).filter(k => !/Unspecified/i.test(k)).length;
  const coverageScore = clampQualityScore(total ? 45 + Math.min(30, subjectCount*8) + Math.min(25, lessonCount*4) : 0);
  const bloom = { Remember:0, Understand:0, Apply:0, Analyse:0 };
  (analytics.all || []).forEach(q => bloom[estimateBloomLevel(q)]++);
  const higherOrder = total ? (bloom.Apply + bloom.Analyse)/total : 0;
  const bloomScore = clampQualityScore(total ? 55 + Math.min(45, higherOrder*100) : 0);
  const overall = clampQualityScore(healthScore*.30 + difficultyScore*.18 + diversityScore*.17 + answerScore*.15 + coverageScore*.10 + bloomScore*.10);
  const critical = Number(health?.criticalCount || health?.summary?.critical || 0);
  const warnings = Number(health?.warningCount || health?.summary?.warning || 0);
  let certification = 'NOT READY';
  if (total && critical === 0 && overall >= 82) certification = 'READY';
  else if (total && critical === 0 && overall >= 60) certification = 'NEEDS REVIEW';
  const suggestions = [];
  if (!total) suggestions.push('Questions parse చేసిన తర్వాత Exam Quality report వస్తుంది.');
  if (healthScore < 90) suggestions.push('Parser Health issues fix చేసి Health Scoreని 90కి పైగా తీసుకెళ్లండి.');
  if (difficultyScore < 70) suggestions.push('Easy, Medium, Hard questions balanceని review చేయండి.');
  if (diversityScore < 70) suggestions.push('Statement, matching, pair లేదా assertion–reason వంటి question types చేర్చండి.');
  if (answerScore < 75) suggestions.push('Correct answers A, B, C, D మధ్య సమంగా distribute చేయండి.');
  if (coverageScore < 70) suggestions.push('Subject మరియు Lesson/Topic metadataని పూర్తిగా add చేయండి.');
  if (higherOrder < .20 && total >= 10) suggestions.push('Apply/Analyse స్థాయి higher-order questionsని కనీసం 20% వరకు పెంచండి.');
  if (!suggestions.length && total) suggestions.push('Exam quality standards బాగున్నాయి. Final manual review తర్వాత publish చేయండి.');
  return { total, overall, certification, scores:{healthScore,difficultyScore,diversityScore,answerScore,coverageScore,bloomScore}, bloom, suggestions, critical, warnings };
}

function qualityScoreCard(label, score) {
  const cls = score >= 80 ? 'good' : score >= 60 ? 'review' : 'poor';
  return `<article class="qualityScoreCard ${cls}"><span>${esc(label)}</span><b>${score}</b><div><i style="width:${score}%"></i></div></article>`;
}

function renderExamQuality() {
  const box = $('examQualitySummary');
  if (!box) return;
  const report = analyzeExamQuality();
  if (!report.total) { box.innerHTML='<p class="small">Questions parse చేసిన తర్వాత Exam Quality ఇక్కడ కనిపిస్తుంది.</p>'; return; }
  const certClass = report.certification === 'READY' ? 'ready' : report.certification === 'NEEDS REVIEW' ? 'review' : 'blocked';
  const bloomTotal = report.total || 1;
  box.innerHTML = `
    <div class="qualityHero ${certClass}">
      <div class="qualityRing" style="--quality-score:${report.overall}"><strong>${report.overall}</strong><span>Quality Score</span></div>
      <div><h4>Exam Certification</h4><b class="qualityCertification">${report.certification}</b><p>${report.critical ? `${report.critical} critical issues ఉన్నాయి.` : report.warnings ? `${report.warnings} warnings ఉన్నాయి.` : 'Critical issues లేవు.'}</p></div>
    </div>
    <div class="qualityScoreGrid">
      ${qualityScoreCard('Parser Health', report.scores.healthScore)}
      ${qualityScoreCard('Difficulty Balance', report.scores.difficultyScore)}
      ${qualityScoreCard('Question Diversity', report.scores.diversityScore)}
      ${qualityScoreCard('Answer Distribution', report.scores.answerScore)}
      ${qualityScoreCard('Coverage', report.scores.coverageScore)}
      ${qualityScoreCard("Bloom's Balance", report.scores.bloomScore)}
    </div>
    <div class="qualityDetailsGrid">
      <article class="qualityPanel"><h4>Bloom's Taxonomy Estimate</h4>${Object.entries(report.bloom).map(([k,v])=>`<div class="qualityBloomRow"><span>${k}</span><div><i style="width:${Math.round(v/bloomTotal*100)}%"></i></div><b>${v}</b></div>`).join('')}</article>
      <article class="qualityPanel"><h4>Quality Improvement Suggestions</h4><div class="qualitySuggestions">${report.suggestions.map(t=>`<p>• ${esc(t)}</p>`).join('')}</div></article>
    </div>`;
}

function exportExamQualityReport() {
  const r = analyzeExamQuality();
  if (!r.total) { flash('Export చేయడానికి questions లేవు'); return; }
  const lines = ['KSR EXAMOS · PHASE 5 STEP 3 EXAM QUALITY REPORT', `Generated: ${new Date().toLocaleString()}`, '', `Certification: ${r.certification}`, `Overall Quality Score: ${r.overall}/100`, `Total Questions: ${r.total}`, '', 'QUALITY SCORES', ...Object.entries(r.scores).map(([k,v])=>`${k}: ${v}/100`), '', "BLOOM'S TAXONOMY ESTIMATE", ...Object.entries(r.bloom).map(([k,v])=>`${k}: ${v}`), '', 'SUGGESTIONS', ...r.suggestions.map((t,i)=>`${i+1}. ${t}`)];
  const blob = new Blob([lines.join('
')], {type:'text/plain;charset=utf-8'});
  const url=URL.createObjectURL(blob), a=document.createElement('a'); a.href=url; a.download=`KSR-Exam-Quality-${Date.now()}.txt`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); flash('Exam Quality report downloaded ✅');
}

function renderDuplicateEngine() {
  if (!$('duplicateEngine')) return;
  const report = findDuplicateQuestions(questions);
  const importSummary = currentSubject().parserDiagnostics || lastImportSummary || {};
  const rawCount = Number(importSummary.rawQuestions ?? importSummary.detectedBlocks ?? questions.length);

  if ($('duplicateRawCount')) $('duplicateRawCount').textContent = rawCount;
  if ($('duplicateParsedCount')) $('duplicateParsedCount').textContent = questions.length;
  if ($('duplicateCount')) $('duplicateCount').textContent = report.duplicateCount;
  if ($('duplicateUniqueCount')) $('duplicateUniqueCount').textContent = report.uniqueCount;
  if ($('removeDuplicatesBtn')) $('removeDuplicatesBtn').disabled = report.duplicateCount === 0;
  if ($('removeSelectedDuplicatesBtn')) $('removeSelectedDuplicatesBtn').disabled = report.duplicateCount === 0;
  if ($('undoDuplicateRemovalBtn')) $('undoDuplicateRemovalBtn').disabled = !lastDuplicateRemovalSnapshot;

  const preview = $('duplicatePreview');
  if (!preview) return;
  if (!questions.length) {
    preview.innerHTML = '<p class="small">Questions parse చేసిన తర్వాత duplicate report ఇక్కడ కనిపిస్తుంది.</p>';
    return;
  }
  if (!report.groups.length) {
    preview.innerHTML = '<div class="duplicateClean">✅ Duplicate questions లేవు. Current subject clean గా ఉంది.</div>';
    return;
  }

  preview.innerHTML = report.groups.map((group, index) => `
    <article class="duplicateGroup">
      <div class="duplicateGroupHead"><b>Duplicate Group ${index + 1}</b><span>${group.indexes.length} copies</span></div>
      <p>${esc(group.question || 'Question text missing')}</p>
      <div class="duplicateQuestionLinks">${group.indexes.map((questionIndex, copyIndex) => `
        <label class="duplicateChoice ${copyIndex ? 'duplicateCopy' : 'duplicateOriginal'}">
          ${copyIndex ? `<input type="checkbox" class="duplicateSelect" data-question-index="${questionIndex}" checked>` : '<span class="duplicateKeepMark">✓</span>'}
          <button type="button" class="duplicateJump" data-question-index="${questionIndex}">
            Q${questionIndex + 1} · ${copyIndex ? 'Remove copy' : 'Keep original'}
          </button>
        </label>`).join('')}</div>
    </article>`).join('');

  preview.querySelectorAll('.duplicateJump').forEach(button => {
    button.onclick = () => openQuestionInEditor(Number(button.dataset.questionIndex), true);
  });
}

function applyDuplicateRemoval(removeIndexes, message) {
  const indexes = [...new Set(removeIndexes)].filter(index => Number.isInteger(index) && index >= 0 && index < questions.length);
  if (!indexes.length) {
    flash('Remove చేయడానికి duplicate copies select కాలేదు');
    return;
  }

  lastDuplicateRemovalSnapshot = {
    subjectIndex: activeSubjectIndex,
    questions: questions.map(question => ({ ...question, options: (question.options || []).map(option => ({ ...option })) })),
    rawBits: currentSubject().rawBits,
    parserDiagnostics: { ...(currentSubject().parserDiagnostics || {}) }
  };

  const remove = new Set(indexes);
  questions = questions.filter((_, index) => !remove.has(index)).map((question, index) => ({
    ...question,
    id: question.id || `q${Date.now()}_${index}`,
    subject: cleanSubjectName($('subjectName')?.value),
    options: (question.options || []).map(option => ({ ...option }))
  }));
  currentSubject().questions = questions.map(question => ({ ...question, options: (question.options || []).map(option => ({ ...option })) }));
  currentSubject().rawBits = questionsToText(questions);
  const duplicateReport = findDuplicateQuestions(questions);
  currentSubject().parserDiagnostics = {
    ...(currentSubject().parserDiagnostics || {}),
    parsedQuestions: questions.length,
    duplicateQuestions: duplicateReport.duplicateCount,
    uniqueQuestions: duplicateReport.uniqueCount,
    duplicateGroups: duplicateReport.groups.length,
    duplicateIndexes: duplicateReport.duplicateIndexes
  };
  if ($('rawBits')) $('rawBits').value = currentSubject().rawBits;
  renderEditor();
  renderSubjectTabs();
  renderDuplicateEngine();
  renderQuestionTypeAnalyzer();
  renderSmartAnalytics();
  renderExamQuality();
  renderHealth();
  saveDraft();
  flash(message || `${indexes.length} duplicate question(s) removed ✅`);
}


function openQuestionInEditor(questionIndex, highlightDuplicate = false) {
  renderEditor();
  if ($('questionEditor')) $('questionEditor').dataset.open = '1';
  if ($('parseBtn')) $('parseBtn').textContent = 'Save Edits & Close';
  setTimeout(() => {
    const card = document.querySelectorAll('.qcard')[questionIndex];
    if (!card) return;
    card.classList.add(highlightDuplicate ? 'duplicateHere' : 'issueHere');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.querySelector('textarea,input,select')?.focus();
    setTimeout(() => card.classList.remove('duplicateHere', 'issueHere'), 3000);
  }, 30);
}

$('removeDuplicatesBtn')?.addEventListener('click', () => {
  sync();
  const report = findDuplicateQuestions(questions);
  if (!report.duplicateCount) {
    flash('Duplicate questions లేవు ✅');
    renderDuplicateEngine();
    return;
  }
  applyDuplicateRemoval(report.duplicateIndexes, `${report.duplicateCount} duplicate question(s) removed ✅`);
});

$('removeSelectedDuplicatesBtn')?.addEventListener('click', () => {
  sync();
  const selected = [...document.querySelectorAll('.duplicateSelect:checked')]
    .map(input => Number(input.dataset.questionIndex));
  applyDuplicateRemoval(selected, `${selected.length} selected duplicate question(s) removed ✅`);
});

$('undoDuplicateRemovalBtn')?.addEventListener('click', () => {
  const snapshot = lastDuplicateRemovalSnapshot;
  if (!snapshot || snapshot.subjectIndex !== activeSubjectIndex) {
    flash('Undo చేయడానికి recent duplicate removal లేదు');
    return;
  }
  questions = snapshot.questions.map(question => ({ ...question, options: (question.options || []).map(option => ({ ...option })) }));
  currentSubject().questions = questions.map(question => ({ ...question, options: (question.options || []).map(option => ({ ...option })) }));
  currentSubject().rawBits = snapshot.rawBits || questionsToText(questions);
  currentSubject().parserDiagnostics = { ...(snapshot.parserDiagnostics || {}) };
  if ($('rawBits')) $('rawBits').value = currentSubject().rawBits;
  lastDuplicateRemovalSnapshot = null;
  renderEditor();
  renderSubjectTabs();
  renderDuplicateEngine();
  renderQuestionTypeAnalyzer();
  renderSmartAnalytics();
  renderExamQuality();
  renderHealth();
  saveDraft();
  flash('Duplicate removal undo అయింది ↩️');
});


const norm = value =>
  String(value || '')
    .trim()
    .toUpperCase();

function flash(message, type = 'ok') {
  let box = document.getElementById('floatingNotice');

  if (!box) {
    box = document.createElement('div');
    box.id = 'floatingNotice';
    document.body.appendChild(box);
  }

  box.className = `floatingNotice ${type}`;
  box.textContent = message;
  box.hidden = false;

  clearTimeout(window.__ksrNoticeTimer);

  window.__ksrNoticeTimer = setTimeout(() => {
    box.hidden = true;
  }, 2600);
}

onAuthStateChanged(auth, async u => {
  if (!u) {
    location.href = 'login.html';
    return;
  }

  user = u;
  setDefaultTimes();
  await loadMasters();
  clearCreateForm(false);
  loadActiveSubject();
  restoreGeneratedCodes();
});

$('logout')?.addEventListener('click', () => signOut(auth));

$('instituteId')?.addEventListener('change', async () => {
  batchStudents = [];
  renderBatchOptions();
  syncInstituteName();
  updateCodeCount();
  await loadBatchStudents();
  saveDraft();
});

$('batchId')?.addEventListener('change', async () => {
  batchStudents = [];
  updateCodeCount();
  await loadBatchStudents();
  saveDraft();
});

function setDefaultTimes() {
  const now = new Date();
  const end = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  const formatDate = d => {
    const two = n => String(n).padStart(2, '0');

    return (
      `${d.getFullYear()}-` +
      `${two(d.getMonth() + 1)}-` +
      `${two(d.getDate())}T` +
      `${two(d.getHours())}:` +
      `${two(d.getMinutes())}`
    );
  };

  $('startTime').value = formatDate(now);
  $('endTime').value = formatDate(end);
}

function clearCreateForm(showNotice = true) {
  questions = [];
  subjects = [{ name: 'General', rawBits: '', questions: [] }];
  if ($('questionShuffle')) $('questionShuffle').value = 'subject';
  if ($('optionShuffle')) $('optionShuffle').value = 'no';
  if ($('studentRandomization')) $('studentRandomization').value = 'different';
  activeSubjectIndex = 0;
  previewQuestions = [];
  previewIndex = 0;

  [
    'examId',
    'examTitle',
    'loginBefore',
    'rawBits'
  ].forEach(id => {
    if ($(id)) {
      $(id).value = '';
    }
  });

  if ($('backupCodeCount')) $('backupCodeCount').value = '10';
  updateCodeCount();

  if ($('secondsPerQuestion')) {
    $('secondsPerQuestion').value = '60';
  }

  if ($('status')) {
    $('status').value = 'active';
  }

  setDefaultTimes();

  if ($('questionEditor')) {
    $('questionEditor').innerHTML = '';
    $('questionEditor').dataset.open = '0';
  }

  if ($('parseBtn')) {
    $('parseBtn').textContent = 'Parse Questions';
  }

  if ($('previewCard')) {
    $('previewCard').hidden = true;
  }

  renderHealth();

  if (showNotice) {
    flash('Fresh exam form ready ✅');
  }
}

window.addEventListener('ksr:new-exam', () => {
  clearCreateForm(false);
  loadActiveSubject();
});

$('clearExamFormBtn')?.addEventListener('click', () => {
  if (confirm('Current form clear cheyyala?')) {
    localStorage.removeItem(DRAFT_KEY);
    clearCreateForm(true);
  }
});

$('recoverDraftBtn')?.addEventListener('click', () => {
  restoreDraft(true);
});

$('examId')?.addEventListener('input', () => {
  $('examId').value = norm($('examId').value).replace(/\s+/g, '-');
  saveDraft();
});

[
  'examTitle',
  'startTime',
  'endTime',
  'loginBefore',
  'secondsPerQuestion',
  'status',
  'subjectName',
  'qbSubject',
  'qbClass',
  'qbLesson',
  'rawBits'
].forEach(id => {
  $(id)?.addEventListener('input', scheduleDraftSave);
});
$('backupCodeCount')?.addEventListener('input', () => {
  updateCodeCount();
  scheduleHealth();
  scheduleDraftSave();
});
$('secondsPerQuestion')?.addEventListener('input', scheduleHealth);

async function loadMasters() {
  try {
    const [instituteSnapshot, batchSnapshot] = await Promise.all([
      getDocs(collection(db, 'institutes')),
      getDocs(collection(db, 'batches'))
    ]);

    institutes = [];
    batches = [];

    instituteSnapshot.forEach(documentSnapshot => {
      institutes.push({
        id: documentSnapshot.id,
        ...documentSnapshot.data()
      });
    });

    batchSnapshot.forEach(documentSnapshot => {
      batches.push({
        id: documentSnapshot.id,
        ...documentSnapshot.data()
      });
    });

    institutes.sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''))
    );

    if (!$('instituteId') || !$('batchId')) throw new Error('Create Exam select boxes missing');
    $('instituteId').innerHTML = institutes.length
      ? '<option value="">Select Institute</option>' + institutes
          .map(institute => `<option value="${institute.id}">${esc(institute.name || 'Institute')}</option>`)
          .join('')
      : '<option value="">No institutes found — add in Institute & Batch Master</option>';

    renderBatchOptions();
    syncInstituteName();
    await loadBatchStudents();
  } catch (error) {
    show('Institute/Batch load avvaledu: ' + error.message, 'err');
  }
}

function renderBatchOptions() {
  const instituteId = $('instituteId').value;

  const filteredBatches = batches.filter(
    batch => batch.instituteId === instituteId
  );

  if (!$('batchId')) return;
  $('batchId').innerHTML = filteredBatches.length
    ? '<option value="">Select Batch</option>' + filteredBatches
        .map(batch => `<option value="${batch.id}">${esc(batch.name || 'Batch')}</option>`)
        .join('')
    : '<option value="">No batches found for this institute</option>';
  batchStudents = [];
  updateCodeCount();
}

function updateCodeCount(){
  const activeCount = batchStudents.length;
  const backupCount = Math.max(0, Math.min(100, Number($('backupCodeCount')?.value || 10)));
  if ($('activeStudentCount')) $('activeStudentCount').value = activeCount;
  if ($('codeCount')) $('codeCount').value = activeCount + backupCount;
}

function syncInstituteName() {
  const selectedInstitute = institutes.find(
    institute => institute.id === $('instituteId').value
  );

  $('instituteName').value = selectedInstitute?.name || '';
}

async function loadBatchStudents() {
  const instituteId = $('instituteId')?.value || '';
  const batchId = $('batchId')?.value || '';
  batchStudents = [];
  updateCodeCount();
  if (!instituteId || !batchId) return;
  try {
    // Fetch-all + client filter avoids composite-index/rules mismatch and supports old student records.
    const snapshot = await getDocs(collection(db, 'studentMaster'));
    snapshot.forEach(documentSnapshot => {
      const data = documentSnapshot.data() || {};
      const sameBatch = String(data.batchId || '') === String(batchId);
      const sameInstitute = !data.instituteId || String(data.instituteId) === String(instituteId);
      const status = String(data.status || '').toLowerCase();
      const isActive = data.active !== false && !['hold','inactive','deleted'].includes(status);
      if (sameBatch && sameInstitute && isActive) batchStudents.push({ id: documentSnapshot.id, ...data });
    });
    batchStudents.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    updateCodeCount();
    flash(`${batchStudents.length} active students loaded + ${Number($('backupCodeCount')?.value || 10)} backup codes`);
  } catch (error) {
    updateCodeCount();
    show('Students load avvaledu: ' + error.message, 'err');
  }
}

const DRAFT_KEY = 'ksrDailyV5Draft';

function saveDraft() {
  try {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        instituteId: $('instituteId')?.value,
        batchId: $('batchId')?.value,
        examId: $('examId')?.value,
        examTitle: $('examTitle')?.value,
        codeCount: $('codeCount')?.value,
        backupCodeCount: $('backupCodeCount')?.value,
        startTime: $('startTime')?.value,
        endTime: $('endTime')?.value,
        loginBefore: $('loginBefore')?.value,
        secondsPerQuestion: $('secondsPerQuestion')?.value,
        status: $('status')?.value,
        qbSubject: $('qbSubject')?.value,
        qbClass: $('qbClass')?.value,
        qbLesson: $('qbLesson')?.value,
        rawBits: $('rawBits')?.value,
        subjects,
        activeSubjectIndex,
        questionShuffle: $('questionShuffle')?.value || 'subject',
        optionShuffle: $('optionShuffle')?.value || 'no',
        studentRandomization: $('studentRandomization')?.value || 'different',
        questions
      })
    );
  } catch (error) {
    console.error('Draft save error:', error);
  }
}

function restoreDraft(notify = true) {
  try {
    const draft = JSON.parse(
      localStorage.getItem(DRAFT_KEY) || 'null'
    );

    if (!draft) {
      if (notify) {
        flash('Saved draft ledu.', 'err');
      }

      return;
    }

    [
      'examId',
      'examTitle',
      'backupCodeCount',
      'startTime',
      'endTime',
      'loginBefore',
      'secondsPerQuestion',
      'status',
      'qbSubject',
      'qbClass',
      'qbLesson',
      'rawBits'
    ].forEach(id => {
      if (draft[id] != null && $(id)) {
        $(id).value = draft[id];
      }
    });

    if (Array.isArray(draft.subjects) && draft.subjects.length) {
      subjects = draft.subjects;
      activeSubjectIndex = Math.min(Number(draft.activeSubjectIndex || 0), subjects.length - 1);
      if ($('questionShuffle')) $('questionShuffle').value = draft.questionShuffle || 'subject';
      if ($('optionShuffle')) $('optionShuffle').value = draft.optionShuffle || 'no';
      if ($('studentRandomization')) $('studentRandomization').value = draft.studentRandomization || 'different';
      loadActiveSubject();
    } else if (Array.isArray(draft.questions) && draft.questions.length) {
      subjects = [{ name: draft.qbSubject || 'General', rawBits: draft.rawBits || '', questions: draft.questions }];
      activeSubjectIndex = 0;
      loadActiveSubject();
    }

    if (notify) {
      flash('Previous draft restored ✅', 'ok');
    }
  } catch (error) {
    if (notify) {
      flash('Draft restore avvaledu.', 'err');
    }
  }
}

$('addSubjectBtn')?.addEventListener('click', () => {
  sync();
  commitCurrentSubject();
  subjects.push({ name: `Subject ${subjects.length + 1}`, rawBits: '', questions: [] });
  activeSubjectIndex = subjects.length - 1;
  loadActiveSubject();
  saveDraft();
  flash('New subject added ✅');
});

$('saveSubjectBtn')?.addEventListener('click', async () => {
  try {
    sync();
    commitCurrentSubject();
    const savedIndex = activeSubjectIndex;
    const subjectName = currentSubject().name;
    const count = await saveSubjectQuestionsToBank(savedIndex, norm($('examId')?.value));

    // Lock the saved subject and immediately open a clean independent parser.
    subjects[savedIndex].rawBits = questionsToText(subjects[savedIndex].questions || []);
    subjects.push({ name: `Subject ${subjects.length + 1}`, rawBits: '', questions: [] });
    activeSubjectIndex = subjects.length - 1;
    questions = [];
    loadActiveSubject();
    if ($('rawBits')) $('rawBits').value = '';
    if ($('questionEditor')) { $('questionEditor').innerHTML = ''; $('questionEditor').dataset.open = '0'; }
    if ($('parseBtn')) $('parseBtn').textContent = 'Parse Questions';
    saveDraft();
    flash(`${subjectName}: ${count} questions saved ✅ New subject parser ready.`);
  } catch (error) {
    show(error.message, 'err');
  }
});



['questionShuffle','optionShuffle','studentRandomization'].forEach(id => {
  $(id)?.addEventListener('change', saveDraft);
});

$('subjectName')?.addEventListener('input', () => {
  currentSubject().name = cleanSubjectName($('subjectName').value);
  if ($('qbSubject')) $('qbSubject').value = currentSubject().name;
  questions.forEach(q => q.subject = currentSubject().name);
  renderSubjectTabs();
  scheduleDraftSave();
});

$('parseBtn')?.addEventListener('click', () => {
  const editor = $('questionEditor');
  if (editor?.dataset.open === '1') {
    sync();
    if ($('rawBits')) $('rawBits').value = questionsToText(questions);
    editor.innerHTML = '';
    editor.dataset.open = '0';
    if ($('parseBtn')) $('parseBtn').textContent = 'Parse Questions';
    flash(`${questions.length} questions edits saved ✅`);
    saveDraft();
    renderHealth();
    return;
  }
  window.__KSR_CREATE_EXAM_CORE__.parseRawQuestions();
});

function questionsToText(list) {
  return list
    .map(
      (question, index) =>
        `${index + 1}. ${question.question}\n` +
        question.options
          .map(
            option =>
              `${option.key}) ${option.text}${
                question.answer === option.key ? ' ●' : ''
              }`
          )
          .join('\n')
    )
    .join('\n\n');
}

$('addQuestionBtn')?.addEventListener('click', () => {
  questions.push(blankQuestion(cleanSubjectName($('subjectName')?.value)));
  commitCurrentSubject();
  renderSubjectTabs();

  renderEditor();
  renderDuplicateEngine();

  $('questionEditor').dataset.open = '1';
  $('parseBtn').textContent = 'Save Edits & Close';

  flash(`Question ${questions.length} added ✅`);
});

function validate() {
  return validateQuestionList(getAllQuestions()).map(issue => issue.text);
}


function normalizeSafeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .split('\n')
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .filter((line, index, lines) => line || (index > 0 && index < lines.length - 1))
    .join('\n')
    .trim();
}

function safeFixQuestion(question = {}) {
  const before = JSON.stringify(question);
  const originalOptions = Array.isArray(question.options) ? question.options : [];
  const optionMap = new Map();
  originalOptions.forEach((option, index) => {
    const rawKey = String(option?.key || '').trim().toUpperCase();
    const key = ['A', 'B', 'C', 'D'].includes(rawKey) ? rawKey : ['A', 'B', 'C', 'D'][index];
    if (key && !optionMap.has(key)) optionMap.set(key, normalizeSafeText(option?.text));
  });
  const options = ['A', 'B', 'C', 'D'].map(key => ({ key, text: optionMap.get(key) || '' }));
  let answer = String(question.answer || '').normalize('NFKC').trim().toUpperCase();
  const letterMatch = answer.match(/^[\(\[\{]?\s*([A-D])\s*[\)\]\}.:-]?$/i);
  if (letterMatch) answer = letterMatch[1].toUpperCase();
  if (!['A', 'B', 'C', 'D'].includes(answer) && answer) {
    const answerText = normalizeSafeText(answer).toLocaleLowerCase();
    const matched = options.find(option => normalizeSafeText(option.text).toLocaleLowerCase() === answerText);
    if (matched) answer = matched.key;
  }
  const fixed = {
    ...question,
    question: normalizeSafeText(question.question),
    options,
    answer: ['A', 'B', 'C', 'D'].includes(answer) ? answer : ''
  };
  return { question: fixed, changed: before !== JSON.stringify(fixed) };
}

function applySafeHealthFixes() {
  sync();
  commitCurrentSubject();
  let changed = 0;
  subjects = subjects.map(subject => {
    const fixedQuestions = (subject.questions || []).map(question => {
      const result = safeFixQuestion(question);
      if (result.changed) changed += 1;
      return { ...result.question, subject: subject.name };
    });
    return { ...subject, questions: fixedQuestions, rawBits: questionsToText(fixedQuestions) };
  });
  loadActiveSubject();
  renderEditor();
  saveDraft();
  flash(changed ? `${changed} questions safe-format auto fixed ✅` : 'Safe auto-fix avasaram ledu ✅');
}

function openHealthIssue(issue) {
  if (!issue) return;
  commitCurrentSubject();
  activeHealthIssue = {
    subjectIndex: Number(issue.subjectIndex || 0),
    questionIndex: Number(issue.questionIndex || 0),
    type: issue.type || 'all',
    severity: issue.severity || 'warning',
    text: issue.text || ''
  };
  activeSubjectIndex = activeHealthIssue.subjectIndex;
  loadActiveSubject();
  renderEditor();
  $('questionEditor').dataset.open = '1';
  if ($('parseBtn')) $('parseBtn').textContent = 'Save Edits & Close';
  setTimeout(() => {
    const card = document.querySelectorAll('.qcard')[activeHealthIssue?.questionIndex ?? -1];
    if (card) {
      card.classList.add('issueHere');
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.querySelector('textarea,input,select')?.focus();
    }
  }, 40);
}

function getCurrentHealthIssues() {
  commitCurrentSubject();
  const allQuestions = subjects.flatMap((subject, subjectIndex) =>
    (subject.questions || []).map((q, questionIndex) => ({
      ...q,
      subject: subject.name,
      subjectIndex,
      subjectQuestionIndex: questionIndex
    }))
  );
  return validateQuestionList(allQuestions);
}

function applyCurrentHealthFix(questionIndex) {
  sync();
  const target = activeHealthIssue || {
    subjectIndex: activeSubjectIndex,
    questionIndex: Number(questionIndex || 0),
    type: 'all'
  };
  const issues = getCurrentHealthIssues();
  const sameTypeStillExists = issues.find(issue =>
    Number(issue.subjectIndex) === Number(target.subjectIndex) &&
    Number(issue.questionIndex) === Number(target.questionIndex) &&
    (target.type === 'all' || issue.type === target.type)
  );

  if (sameTypeStillExists) {
    activeHealthIssue = { ...sameTypeStillExists };
    renderHealth();
    flash(`Q${Number(target.questionIndex) + 1} issue inka solve avvaledu. Fields check cheyyandi.`);
    setTimeout(() => {
      const card = document.querySelectorAll('.qcard')[Number(target.questionIndex)];
      card?.classList.add('issueHere');
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 30);
    return;
  }

  saveDraft();
  const remaining = issues.filter(issue =>
    healthIssueFilter === 'all' ||
    issue.severity === healthIssueFilter ||
    issue.type === healthIssueFilter
  );
  const nextIssue = remaining.find(issue =>
    Number(issue.subjectIndex) > Number(target.subjectIndex) ||
    (Number(issue.subjectIndex) === Number(target.subjectIndex) && Number(issue.questionIndex) >= Number(target.questionIndex))
  ) || remaining[0] || null;

  activeHealthIssue = null;
  renderEditor();
  flash(`Q${Number(target.questionIndex) + 1} issue solved ✅ Health auto rechecked.`);
  if (nextIssue) setTimeout(() => openHealthIssue(nextIssue), 180);
}

function healthIssueLabel(type) {
  return ({
    all: 'All Issues',
    critical: 'Critical',
    warning: 'Warnings',
    missingAnswer: 'Missing Answer',
    missingOptions: 'Missing Options',
    emptyQuestion: 'Empty Question',
    brokenQuestion: 'Broken Question',
    duplicate: 'Duplicates'
  })[type] || type;
}

function exportHealthReport(allQuestions, health, issues) {
  const lines = [
    'KSR EXAMOS - PHASE 4 PARSER HEALTH REPORT',
    `Generated: ${new Date().toLocaleString()}`,
    `Overall Status: ${health.status}`,
    `Health Score: ${health.healthScore}%`,
    `Total Questions: ${health.totalQuestions}`,
    `Clean Questions: ${health.healthyQuestions}`,
    `Warning Questions: ${health.warningQuestions}`,
    `Critical Questions: ${health.criticalQuestions}`,
    `Total Issues: ${issues.length}`,
    '',
    'ISSUE DETAILS'
  ];
  if (!issues.length) lines.push('No issues found. All questions are healthy.');
  issues.forEach((issue, index) => lines.push(`${index + 1}. [${issue.severity.toUpperCase()}] ${issue.text} (${healthIssueLabel(issue.type)})`));
  lines.push('', 'QUESTION SCORES');
  health.questions.forEach(report => {
    const question = allQuestions[report.index] || {};
    const subject = question.subject || 'General';
    const qNo = Number(question.subjectQuestionIndex ?? report.index) + 1;
    lines.push(`${subject} Q${qNo}: ${report.score}% - ${report.severity.toUpperCase()}`);
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `KSR-PARSER-HEALTH-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderHealth() {
  renderDuplicateEngine();
  commitCurrentSubject();
  const allQuestions = subjects.flatMap((subject, subjectIndex) => (subject.questions || []).map((q, questionIndex) => ({ ...q, subject: subject.name, subjectIndex, subjectQuestionIndex: questionIndex })));
  const issues = validateQuestionList(allQuestions);
  const overallHealth = analyzeQuestionHealth(allQuestions);
  const issueCount = type => issues.filter(issue => issue.type === type).length;
  const invalidQuestionKeys = new Set(issues.map(issue => `${issue.subjectIndex}:${issue.questionIndex}`));
  const valid = Math.max(0, allQuestions.length - invalidQuestionKeys.size);
  if ($('subjectQuestionCount')) $('subjectQuestionCount').value = questions.length;

  const subjectHealthRows = [];
  const subjectCards = subjects.map((subject, subjectIndex) => {
    const list = (subject.questions || []).map((q, questionIndex) => ({ ...q, subject: subject.name, subjectIndex, subjectQuestionIndex: questionIndex }));
    const subjectIssues = validateQuestionList(list);
    const invalid = new Set(subjectIssues.map(issue => issue.questionIndex)).size;
    const subjectValid = Math.max(0, list.length - invalid);
    const subjectHealth = analyzeQuestionHealth(list);
    const confidence = subjectHealth.healthScore;
    const countType = type => subjectIssues.filter(issue => issue.type === type).length;
    const missingAnswers = countType('missingAnswer');
    const totalSubjectIssues = subjectIssues.length;
    const statusText = list.length && !totalSubjectIssues ? 'Ready' : totalSubjectIssues ? 'Needs Fix' : 'Empty';
    subjectHealthRows.push(`<tr class="subjectHealthTableRow ${totalSubjectIssues ? 'hasIssues' : list.length ? 'ready' : 'empty'}" data-subject-health-index="${subjectIndex}" tabindex="0" role="button" aria-label="Open ${esc(subject.name || `Subject ${subjectIndex + 1}`)} questions">
      <td><b>${esc(subject.name || `Subject ${subjectIndex + 1}`)}</b></td>
      <td>${list.length}</td><td>${list.length}</td><td>${missingAnswers}</td><td>${totalSubjectIssues}</td>
      <td><span class="subjectTableStatus ${totalSubjectIssues ? 'needsFix' : list.length ? 'ready' : 'empty'}">${statusText}</span></td>
    </tr>`);
    const issueButtons = subjectIssues.map(issue => `<button type="button" class="issueJump" data-subject-index="${subjectIndex}" data-question-index="${issue.questionIndex}" data-issue-type="${esc(issue.type)}" data-issue-severity="${esc(issue.severity)}">Q${issue.questionIndex + 1} · ${esc(issue.text.split(':').slice(1).join(':').trim())}</button>`).join('');
    return `<section class="subjectHealthCard ${subjectIssues.length ? 'hasIssues' : list.length ? 'healthy' : 'empty'}">
      <div class="subjectHealthHead"><b>${subjectIndex + 1}. ${esc(subject.name || `Subject ${subjectIndex + 1}`)}</b><span>${list.length && !subjectIssues.length ? 'READY' : subjectIssues.length ? 'NEEDS FIX' : 'EMPTY'}</span></div>
      <div class="subjectHealthGrid">
        <span>Total <b>${list.length}</b></span><span>Valid <b>${subjectValid}</b></span>
        <span>Missing Answer <b>${countType('missingAnswer')}</b></span><span>Missing Options <b>${countType('missingOptions')}</b></span>
        <span>Duplicates <b>${countType('duplicate')}</b></span><span>Empty Questions <b>${countType('emptyQuestion')}</b></span>
        <span>Broken Questions <b>${countType('brokenQuestion')}</b></span>
        <span>Confidence <b>${confidence}%</b></span>
      </div>
      ${issueButtons ? `<div class="subjectIssueLinks">${issueButtons}</div>` : ''}
    </section>`;
  }).join('');

  const totalMissingAnswers = issueCount('missingAnswer');
  const totalSubjectIssues = issues.length;
  const finalSubjectHealthTable = `<section class="finalSubjectHealthSection">
    <div class="examHealthTitleRow"><div><b>Final Subject Health Table</b><small>Subject row paina press chesthe aa subject questions maatrame open avutayi.</small></div><span class="healthStatusBadge ${issues.length ? 'critical' : allQuestions.length ? 'healthy' : 'empty'}">${issues.length ? 'NEEDS FIX' : allQuestions.length ? 'READY' : 'EMPTY'}</span></div>
    <div class="subjectHealthTableWrap"><table class="subjectHealthTable"><thead><tr><th>Subject</th><th>Questions</th><th>Marks</th><th>Missing Answers</th><th>Issues</th><th>Status</th></tr></thead>
    <tbody>${subjectHealthRows.join('')}<tr class="subjectHealthTotalRow"><td><b>Total</b></td><td><b>${allQuestions.length}</b></td><td><b>${allQuestions.length}</b></td><td><b>${totalMissingAnswers}</b></td><td><b>${totalSubjectIssues}</b></td><td><span class="subjectTableStatus ${issues.length ? 'needsFix' : allQuestions.length ? 'ready' : 'empty'}">${issues.length ? 'Needs Fix' : allQuestions.length ? 'Ready' : 'Empty'}</span></td></tr></tbody></table></div>
  </section>`;

  const filters = ['all', 'critical', 'warning', 'missingAnswer', 'missingOptions', 'emptyQuestion', 'brokenQuestion', 'duplicate'];
  const filteredIssues = issues.filter(issue => healthIssueFilter === 'all' || issue.severity === healthIssueFilter || issue.type === healthIssueFilter);
  const healthFilterHtml = filters.map(filter => {
    const count = filter === 'all' ? issues.length : issues.filter(issue => issue.severity === filter || issue.type === filter).length;
    return `<button type="button" class="healthFilterBtn ${healthIssueFilter === filter ? 'active' : ''}" data-health-filter="${filter}">${healthIssueLabel(filter)} <b>${count}</b></button>`;
  }).join('');
  const filteredIssueHtml = filteredIssues.length ? filteredIssues.map(issue => `<button type="button" class="healthIssueRow ${issue.severity}" data-health-subject="${issue.subjectIndex}" data-health-question="${issue.questionIndex}" data-health-type="${esc(issue.type)}" data-health-severity="${esc(issue.severity)}"><span>${issue.severity === 'critical' ? '⛔' : '⚠️'}</span><b>${esc(issue.label)}</b><em>${esc(healthIssueLabel(issue.type))}</em><small>${esc(issue.text.split(':').slice(1).join(':').trim())}</small></button>`).join('') : '<div class="healthNoFilteredIssues">✅ Ee filter lo issues levu.</div>';

  const secondsEach = Math.max(5, Number($('secondsPerQuestion')?.value || 60));
  const totalMinutes = Math.ceil((allQuestions.length * secondsEach) / 60);
  const activeStudents = Number($('activeStudentCount')?.value || 0);
  const backupCodes = Number($('backupCodeCount')?.value || 0);
  const importSummary = currentSubject().parserDiagnostics || lastImportSummary;
  const criticalCount = issues.filter(issue => issue.severity === 'critical').length;
  const duplicateSplitCount = issueCount('duplicate') + issueCount('brokenQuestion');
  const invalidOptionsCount = issueCount('missingOptions');
  const sprint2MetricsHtml = `<section class="sprint2HealthMetrics">
    <button type="button" class="sprint2Metric total" data-health-filter="all"><span>Parsed Questions</span><b>${allQuestions.length}</b><small>All parsed bits</small></button>
    <button type="button" class="sprint2Metric missing" data-health-filter="missingAnswer"><span>Missing Answers</span><b>${issueCount('missingAnswer')}</b><small>Press to view questions</small></button>
    <button type="button" class="sprint2Metric critical" data-health-filter="critical"><span>Critical Issues</span><b>${criticalCount}</b><small>Press to view questions</small></button>
    <button type="button" class="sprint2Metric duplicate" data-health-filter="brokenQuestion"><span>Duplicate / Split</span><b>${duplicateSplitCount}</b><small>Broken or repeated bits</small></button>
    <button type="button" class="sprint2Metric invalid" data-health-filter="missingOptions"><span>Invalid Options</span><b>${invalidOptionsCount}</b><small>Incomplete option sets</small></button>
  </section>`;
  const importSummaryHtml = importSummary ? `<section class="parserImportSummary">
    <div class="parserSummaryHead"><b>Phase 2.2 Import Summary</b><span>${Number(importSummary.confidence || 0)}% confidence</span></div>
    <div class="parserSummaryGrid">
      <span>Detected <b>${Number(importSummary.parsedQuestions || 0)}</b></span>
      <span>Matching <b>${Number(importSummary.matchingQuestions || 0)}</b></span>
      <span>Assertion–Reason <b>${Number(importSummary.assertionReasonQuestions || 0)}</b></span>
      <span>Statement <b>${Number(importSummary.statementQuestions || 0)}</b></span>
      <span>Missing Answers <b>${Number(importSummary.missingAnswers || 0)}</b></span>
      <span>Missing Options <b>${Number(importSummary.missingOptions || 0)}</b></span>
      <span>Duplicates <b>${Number(importSummary.duplicateQuestions || 0)}</b></span>
      <span>Broken <b>${Number(importSummary.brokenQuestions || 0)}</b></span>
    </div>
  </section>` : '';
  $('health').innerHTML = `
    ${importSummaryHtml}
    <div class="examHealthTitleRow"><b>Sprint 5 · Final Exam Validation</b><span class="healthStatusBadge ${overallHealth.status.toLowerCase()}">${overallHealth.status}</span></div>
    ${sprint2MetricsHtml}
    <div class="examHealthTitleRow healthDetailTitle"><b>Issue Explorer</b><span class="healthStatusBadge ${overallHealth.status.toLowerCase()}">${overallHealth.status}</span></div>
    <section class="healthScoreHero ${overallHealth.status.toLowerCase()}">
      <div class="healthScoreRing" style="--health-score:${overallHealth.healthScore}"><strong>${overallHealth.healthScore}%</strong><span>Health Score</span></div>
      <div class="healthHeroStats">
        <span>Total Questions <b>${overallHealth.totalQuestions}</b></span>
        <span>Clean Questions <b>${overallHealth.healthyQuestions}</b></span>
        <span>Warning Questions <b>${overallHealth.warningQuestions}</b></span>
        <span>Critical Questions <b>${overallHealth.criticalQuestions}</b></span>
      </div>
      <div class="healthHeroActions">
        <button type="button" class="green" id="safeAutoFixBtn">Auto Fix Safe Issues</button>
        <button type="button" class="gray" id="nextHealthIssueBtn" ${issues.length ? '' : 'disabled'}>Next Issue</button>
        <button type="button" class="gray" id="recheckHealthBtn">Recheck</button>
        <button type="button" class="gray" id="exportHealthReportBtn">Export Health Report</button>
      </div>
    </section>
    <section class="finalHealthGate ${issues.length ? 'blocked' : 'ready'}">
      <b>${issues.length ? 'FINAL SAVE GATE: BLOCKED' : 'FINAL SAVE GATE: READY'}</b>
      <span>${issues.length ? `${issues.length} issue(s) fix chesaka maatrame exam save avutundi.` : 'All questions verified. Save & Generate Codes ready.'}</span>
    </section>
    <section class="healthIssueExplorer">
      <div class="healthFilterBar">${healthFilterHtml}</div>
      <div class="healthIssueList">${filteredIssueHtml}</div>
    </section>
    ${finalSubjectHealthTable}
    <details class="subjectHealthDetails"><summary>Detailed Subject Issue Cards</summary><div class="subjectHealthCards">${subjectCards || '<p class="small">Subject parsers levu.</p>'}</div></details>
    <div class="health-grid enterpriseHealth">
      <span>Total Subjects: <b>${subjects.length}</b></span><span>Total Bits: <b>${allQuestions.length}</b></span>
      <span>Valid Bits: <b>${valid}</b></span><span>Invalid Bits: <b>${invalidQuestionKeys.size}</b></span>
      <span>Missing Answers: <b>${issueCount('missingAnswer')}</b></span><span>Missing Options: <b>${issueCount('missingOptions')}</b></span>
      <span>Duplicates: <b>${issueCount('duplicate')}</b></span><span>Broken Questions: <b>${issueCount('brokenQuestion')}</b></span>
      <span>Duration: <b>${totalMinutes} min</b></span>
      <span>Active Students: <b>${activeStudents}</b></span><span>Backup Codes: <b>${backupCodes}</b></span>
      <span>Total Codes: <b>${activeStudents + backupCodes}</b></span>
    </div>
    ${issues.length ? '<div class="healthFixHint">Issue number paina click chesthe aa bit direct ga editor lo open avutundi.</div>' : '<div class="healthReadyMessage">✅ All subjects and bits are healthy. Final Exam Save & Generate Codes ready.</div>'}`;

  document.querySelectorAll('[data-health-filter]').forEach(button => {
    button.onclick = () => { healthIssueFilter = button.dataset.healthFilter || 'all'; renderHealth(); };
  });
  $('safeAutoFixBtn')?.addEventListener('click', applySafeHealthFixes);
  $('recheckHealthBtn')?.addEventListener('click', () => { sync(); renderHealth(); flash('Parser health rechecked ✅'); });
  $('nextHealthIssueBtn')?.addEventListener('click', () => {
    if (!issues.length) return;
    healthIssueCursor = (healthIssueCursor + 1) % issues.length;
    openHealthIssue(issues[healthIssueCursor]);
  });
  $('exportHealthReportBtn')?.addEventListener('click', () => exportHealthReport(allQuestions, overallHealth, issues));
  document.querySelectorAll('.healthIssueRow').forEach(button => {
    button.onclick = () => openHealthIssue({
      subjectIndex: Number(button.dataset.healthSubject),
      questionIndex: Number(button.dataset.healthQuestion),
      type: button.dataset.healthType || 'all',
      severity: button.dataset.healthSeverity || 'warning'
    });
  });

  document.querySelectorAll('[data-subject-health-index]').forEach(row => {
    const openSubject = () => {
      commitCurrentSubject();
      activeSubjectIndex = Number(row.dataset.subjectHealthIndex || 0);
      loadActiveSubject();
      renderSubjectTabs();
      renderEditor();
      document.getElementById('questionEditor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      flash(`${subjects[activeSubjectIndex]?.name || 'Subject'} questions opened ✅`);
    };
    row.addEventListener('click', openSubject);
    row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openSubject(); } });
  });

  document.querySelectorAll('.issueJump').forEach(button => {
    button.onclick = () => {
      openHealthIssue({
        subjectIndex: Number(button.dataset.subjectIndex),
        questionIndex: Number(button.dataset.questionIndex),
        type: button.dataset.issueType || 'all',
        severity: button.dataset.issueSeverity || 'warning'
      });
    };
  });
  $('saveGenerateBtn').disabled = !allQuestions.length || Boolean(issues.length);
}


function renderEditor() {
  $('questionEditor').dataset.open = '1';

  $('questionEditor').innerHTML = questions
    .map(
      (question, index) => `
        <div class="qcard ${activeHealthIssue && activeHealthIssue.subjectIndex === activeSubjectIndex && activeHealthIssue.questionIndex === index ? 'sprint3ActiveIssue' : ''}">
          <div class="qhead">
            <b>Q${index + 1}</b>

            <div>
              <button
                class="gray moveUp"
                data-i="${index}"
              >
                ↑
              </button>

              <button
                class="gray moveDown"
                data-i="${index}"
              >
                ↓
              </button>

              <button
                class="danger deleteQ"
                data-i="${index}"
              >
                Delete
              </button>
            </div>
          </div>

          <label>Question</label>

          <textarea
            class="editQ"
            data-i="${index}"
          >${esc(question.question)}</textarea>

          <div class="grid two">
            ${question.options
              .map(
                (option, optionIndex) => `
                  <div>
                    <label>${option.key}) Option</label>

                    <input
                      class="editOpt"
                      data-i="${index}"
                      data-j="${optionIndex}"
                      value="${esc(option.text)}"
                    >
                  </div>
                `
              )
              .join('')}
          </div>

          <label>Correct Answer</label>

          <select
            class="editAns"
            data-i="${index}"
          >
            <option value="" ${question.answer ? '' : 'selected'}>Select correct answer</option>
            ${['A', 'B', 'C', 'D']
              .map(
                key =>
                  `<option value="${key}" ${
                    question.answer === key ? 'selected' : ''
                  }>${key}</option>`
              )
              .join('')}
          </select>
          ${activeHealthIssue && activeHealthIssue.subjectIndex === activeSubjectIndex && activeHealthIssue.questionIndex === index ? `
            <section class="sprint3FixPanel">
              <div><b>Fixing Q${index + 1}: ${esc(healthIssueLabel(activeHealthIssue.type))}</b><small>${esc((activeHealthIssue.text || '').split(':').slice(1).join(':').trim() || 'Question fields correct chesi Apply Fix press cheyyandi.')}</small></div>
              <button type="button" class="green applyHealthFix" data-i="${index}">Save / Apply Fix</button>
            </section>` : ''}
        </div>
      `
    )
    .join('');

  bindEditor();
  renderHealth();
}

function sync() {
  document.querySelectorAll('.editQ').forEach(element => {
    questions[Number(element.dataset.i)].question =
      element.value;
  });

  document.querySelectorAll('.editOpt').forEach(element => {
    questions[Number(element.dataset.i)].options[
      Number(element.dataset.j)
    ].text = element.value;
  });

  document.querySelectorAll('.editAns').forEach(element => {
    questions[Number(element.dataset.i)].answer =
      element.value;
  });

  commitCurrentSubject();
  renderSubjectTabs();
  scheduleDraftSave();
}

function bindEditor() {
  document
    .querySelectorAll('.editQ,.editOpt,.editAns')
    .forEach(element => {
      element.oninput = () => {
        sync();
        scheduleHealth();
      };
    });

  document.querySelectorAll('.applyHealthFix').forEach(button => {
    button.onclick = () => applyCurrentHealthFix(Number(button.dataset.i));
  });

  document.querySelectorAll('.deleteQ').forEach(button => {
    button.onclick = () => {
      questions.splice(Number(button.dataset.i), 1);
      renderEditor();
    };
  });

  document.querySelectorAll('.moveUp').forEach(button => {
    button.onclick = () => {
      sync();

      const index = Number(button.dataset.i);

      if (index > 0) {
        [questions[index - 1], questions[index]] = [
          questions[index],
          questions[index - 1]
        ];
      }

      renderEditor();
    };
  });

  document.querySelectorAll('.moveDown').forEach(button => {
    button.onclick = () => {
      sync();

      const index = Number(button.dataset.i);

      if (index < questions.length - 1) {
        [questions[index + 1], questions[index]] = [
          questions[index],
          questions[index + 1]
        ];
      }

      renderEditor();
    };
  });
}

$('previewBtn')?.addEventListener('click', () => {
  sync();

  previewQuestions = getAllQuestions();

  if (!previewQuestions.length) {
    return show('Preview ki questions levu.', 'err');
  }

  previewIndex = 0;

  $('previewCard').hidden = false;

  renderPreview();

  location.hash = 'previewCard';
});

function renderPreview() {
  const question = previewQuestions[previewIndex];

  $('previewTitle').textContent =
    $('examTitle').value.trim() ||
    $('examId').value.trim() ||
    'Exam Preview';

  $('previewTimer').textContent =
    `${$('secondsPerQuestion').value || 60} sec / Q`;

  $('previewContent').innerHTML = `
    <div class="questionText">
      <b>
        ${esc(question.subject || 'General')} • Question ${previewIndex + 1} of ${previewQuestions.length}
      </b>

      <h3>
        ${esc(question.question).replace(/\n/g, '<br>')}
      </h3>
    </div>

    ${question.options
      .map(
        option => `
          <label class="optionCard">
            <input
              type="radio"
              name="previewAnswer"
            >

            <b>${option.key}</b>

            <span>${esc(option.text)}</span>
          </label>
        `
      )
      .join('')}

    <div class="controls">
      <button
        class="gray"
        id="pPrev"
      >
        Previous
      </button>

      <button
        class="green"
        id="pNext"
      >
        Save & Next
      </button>
    </div>
  `;

  $('previewNav').innerHTML = previewQuestions
    .map(
      (_, index) => `
        <button
          class="pbtn ${
            index === previewIndex ? 'cur' : 'not'
          }"
          data-p="${index}"
        >
          ${index + 1}
        </button>
      `
    )
    .join('');

  document.querySelectorAll('[data-p]').forEach(button => {
    button.onclick = () => {
      previewIndex = Number(button.dataset.p);
      renderPreview();
    };
  });

  $('pPrev')?.addEventListener('click', () => {
    if (previewIndex > 0) {
      previewIndex--;
      renderPreview();
    }
  });

  $('pNext')?.addEventListener('click', () => {
    if (previewIndex < previewQuestions.length - 1) {
      previewIndex++;
      renderPreview();
    }
  });
}

function randomSixDigitCode() {
  return String(
    Math.floor(100000 + Math.random() * 900000)
  );
}

async function makeUniqueSixDigitCode(usedCodes) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const code = randomSixDigitCode();

    if (usedCodes.has(code)) {
      continue;
    }

    const existing = await getDoc(
      doc(db, 'studentAccess', code)
    );

    if (!existing.exists()) {
      usedCodes.add(code);
      return code;
    }
  }

  throw new Error(
    'Unique 6-digit Exam Code generate avvaledu. Malli try cheyyandi.'
  );
}

function bankFolder(value) {
  return String(value || '').trim() || 'General';
}

function bankHash(text) {
  let hash = 2166136261;

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function bankQuestionId(question) {
  return (
    'QB-' +
    bankHash(
      [
        question.question,
        ...question.options.map(option => option.text),
        question.answer
      ]
        .join('|')
        .toLowerCase()
        .replace(/\s+/g, ' ')
    )
  );
}

async function saveSubjectQuestionsToBank(subjectIndex = activeSubjectIndex, sourceExamId = '') {
  sync();
  commitCurrentSubject();
  const subject = subjects[subjectIndex];
  if (!subject) throw new Error('Subject dorakaledu.');
  const list = (subject.questions || []).map((question, questionIndex) => ({
    ...question,
    subject: subject.name,
    subjectIndex,
    subjectQuestionIndex: questionIndex,
    options: (question.options || []).map(option => ({ ...option }))
  }));
  const issues = validateQuestionList(list);
  if (!list.length) throw new Error(`${subject.name} lo questions levu.`);
  if (issues.length) throw new Error(`${subject.name} lo question issues fix cheyyandi.`);
  const className = bankFolder($('qbClass')?.value);
  const lesson = bankFolder($('qbLesson')?.value);
  for (let startIndex = 0; startIndex < list.length; startIndex += 450) {
    const batch = writeBatch(db);
    list.slice(startIndex, startIndex + 450).forEach(question => {
      batch.set(doc(db, 'questionBank', bankQuestionId(question)), {
        ...question,
        subject: subject.name,
        className,
        lesson,
        sourceExamId,
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp()
      }, { merge: true });
    });
    await batch.commit();
  }
  return list.length;
}

async function saveQuestionsToBank(sourceExamId = '') {
  const allQuestions = getAllQuestions();

  const issues = validateQuestionList(allQuestions);

  if (!allQuestions.length || issues.length) {
    throw new Error(
      'Question Bank save mundu question issues fix cheyyandi.'
    );
  }

  const subject = bankFolder($('subjectName')?.value);
  const className = bankFolder($('qbClass')?.value);
  const lesson = bankFolder($('qbLesson')?.value);

  for (
    let startIndex = 0;
    startIndex < allQuestions.length;
    startIndex += 450
  ) {
    const batch = writeBatch(db);

    allQuestions
      .slice(startIndex, startIndex + 450)
      .forEach(question => {
        batch.set(
          doc(
            db,
            'questionBank',
            bankQuestionId(question)
          ),
          {
            ...question,
            subject: question.subject || subject,
            className,
            lesson,
            sourceExamId,
            updatedAt: serverTimestamp(),
            createdAt: serverTimestamp()
          },
          {
            merge: true
          }
        );
      });

    await batch.commit();
  }

  return allQuestions.length;
}

$('saveToBankBtn')?.addEventListener(
  'click',
  async () => {
    try {
      const count = await saveQuestionsToBank(
        norm($('examId')?.value)
      );

      flash(
        `${count} questions Question Bank lo saved ✅`
      );
    } catch (error) {
      show(error.message, 'err');
    }
  }
);

$('openBankBtn')?.addEventListener('click', () => {
  $('bankPicker').hidden = false;

  $('bankSubjectFilter').value =
    $('qbSubject')?.value || '';

  $('bankClassFilter').value =
    $('qbClass')?.value || '';

  $('bankLessonFilter').value =
    $('qbLesson')?.value || '';

  $('bankPicker').scrollIntoView({
    behavior: 'smooth',
    block: 'start'
  });
});

$('closeBankBtn')?.addEventListener('click', () => {
  $('bankPicker').hidden = true;
});

let loadedBankQuestions = [];

function bankNorm(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function renderLoadedBankQuestions() {
  const keyword = bankNorm($('bankSearchText')?.value);
  const visible = loadedBankQuestions.filter(question => {
    if (!keyword) return true;
    return bankNorm([
      question.id,
      question.question,
      ...(question.options || []).map(option => option.text)
    ].join(' ')).includes(keyword);
  });

  $('bankPickerStats').innerHTML = `Loaded: <b>${loadedBankQuestions.length}</b> &nbsp; Showing: <b>${visible.length}</b> &nbsp; Selected: <b id="bankSelectedCount">0</b>`;
  $('bankPickerList').innerHTML = visible.length
    ? visible.map((question, index) => `
        <label class="bankQuestionRow">
          <input type="checkbox" class="bankPick" value="${esc(question.id)}">
          <span>
            <b>${index + 1}. ${esc(question.question || '')}</b>
            <small>${esc(question.id || 'QB')} · ${esc(question.subject || 'General')} → ${esc(question.className || 'General')} → ${esc(question.lesson || 'General')}</small>
          </span>
        </label>
      `).join('')
    : '<p class="msg warn">Matching questions levu.</p>';

  document.querySelectorAll('.bankPick').forEach(box => {
    box.addEventListener('change', () => {
      const count = document.querySelectorAll('.bankPick:checked').length;
      const counter = $('bankSelectedCount');
      if (counter) counter.textContent = count;
    });
  });
}

$('loadBankBtn')?.addEventListener('click', async () => {
  try {
    const snapshot = await getDocs(collection(db, 'questionBank'));
    loadedBankQuestions = [];
    const subjectFilter = bankNorm($('bankSubjectFilter').value);
    const classFilter = bankNorm($('bankClassFilter').value);
    const lessonFilter = bankNorm($('bankLessonFilter').value);

    snapshot.forEach(documentSnapshot => {
      const question = { id: documentSnapshot.id, ...documentSnapshot.data() };
      const matchesSubject = !subjectFilter || bankNorm(question.subject).includes(subjectFilter);
      const matchesClass = !classFilter || bankNorm(question.className).includes(classFilter);
      const matchesLesson = !lessonFilter || bankNorm(question.lesson).includes(lessonFilter);
      if (matchesSubject && matchesClass && matchesLesson) loadedBankQuestions.push(question);
    });

    loadedBankQuestions.sort((a, b) =>
      String(a.subject || '').localeCompare(String(b.subject || '')) ||
      String(a.lesson || '').localeCompare(String(b.lesson || '')) ||
      String(a.question || '').localeCompare(String(b.question || ''))
    );
    renderLoadedBankQuestions();
    flash(`${loadedBankQuestions.length} bank questions loaded`);
  } catch (error) {
    show(error.message, 'err');
  }
});

$('bankSearchText')?.addEventListener('input', renderLoadedBankQuestions);
$('selectAllBankBtn')?.addEventListener('click', () => {
  document.querySelectorAll('.bankPick').forEach(box => { box.checked = true; });
  const counter = $('bankSelectedCount');
  if (counter) counter.textContent = document.querySelectorAll('.bankPick:checked').length;
});
$('clearBankSelectionBtn')?.addEventListener('click', () => {
  document.querySelectorAll('.bankPick').forEach(box => { box.checked = false; });
  const counter = $('bankSelectedCount');
  if (counter) counter.textContent = 0;
});

$('addSelectedBankBtn')?.addEventListener('click', () => {
  const selectedIds = [...document.querySelectorAll('.bankPick:checked')].map(element => element.value);
  const selectedQuestions = loadedBankQuestions.filter(question => selectedIds.includes(question.id));
  if (!selectedQuestions.length) return show('Bank nundi questions select cheyyandi.', 'err');

  sync();
  const active = subjects[activeSubjectIndex];
  const activeName = bankNorm(active?.name || $('subjectName')?.value);
  const existingQuestions = new Set((active?.questions || []).map(question => bankNorm(question.question)));
  let added = 0, skipped = 0;

  selectedQuestions.forEach(question => {
    const key = bankNorm(question.question);
    if (existingQuestions.has(key)) { skipped++; return; }
    if (activeName && bankNorm(question.subject) !== activeName) { skipped++; return; }
    active.questions.push({
      question: question.question,
      options: (question.options || []).map(option => ({ ...option })),
      answer: question.answer,
      subject: active.name || question.subject || 'General'
    });
    existingQuestions.add(key);
    added++;
  });

  questions = active.questions;
  $('rawBits').value = questionsToText(questions);
  renderHealth();
  renderSubjectTabs();
  saveDraft();
  flash(`${added} questions exam ki added ✅${skipped ? ` · ${skipped} duplicates/other subject skipped` : ''}`);
});


/* =========================================================
   PHASE 6 · STEP 1 — AUTO VERSIONING + AUDIT HISTORY
========================================================= */
function versionDateText(value) {
  try {
    const date = value?.toDate ? value.toDate() : new Date(value || Date.now());
    return date.toLocaleString('en-IN');
  } catch { return '—'; }
}

async function loadExamVersionHistory() {
  const box = $('examVersionHistory');
  const examId = norm($('examId')?.value || '');
  if (!box) return;
  if (!examId) {
    box.innerHTML = '<p class="small">Exam ID enter చేసిన తర్వాత version history చూడవచ్చు.</p>';
    return;
  }
  box.innerHTML = '<p class="small">Version history loading…</p>';
  try {
    const snapshot = await getDocs(query(collection(db, 'examVersions'), where('examId', '==', examId)));
    const versions = snapshot.docs.map(d => ({ id:d.id, ...d.data() }))
      .sort((a,b) => Number(b.version||0)-Number(a.version||0));
    const examSnap = await getDoc(doc(db,'exams',examId));
    const currentVersion = Number(examSnap.data()?.version || (examSnap.exists()?1:0));
    if (!versions.length && !currentVersion) {
      box.innerHTML = '<p class="small">ఈ Exam IDకి saved versions లేవు.</p>';
      return;
    }
    const current = currentVersion ? `<div class="versionCurrent"><b>Current Version: v${currentVersion}</b><span>${esc(examSnap.data()?.title || examId)}</span></div>` : '';
    const rows = versions.map(v => `
      <article class="versionRow">
        <div><b>v${Number(v.version||0)}</b><span>${esc(v.action || 'Saved snapshot')}</span></div>
        <small>${esc(versionDateText(v.savedAt || v.createdAt))} · ${Number(v.questionCount||0)} questions · ${esc(v.savedBy || 'admin')}</small>
      </article>`).join('');
    box.innerHTML = current + (rows || '<p class="small">Previous snapshots ఇంకా లేవు. Next update సమయంలో v1 snapshot automaticగా save అవుతుంది.</p>');
  } catch (error) {
    console.error('Version history error:', error);
    box.innerHTML = `<p class="small errText">History load కాలేదు: ${esc(error.message)}</p>`;
  }
}

async function writeExamAudit(examId, payload) {
  try {
    await addDoc(collection(db, 'examAuditLogs'), {
      examId,
      ...payload,
      user: user?.email || 'admin',
      createdAt: serverTimestamp()
    });
  } catch (error) {
    console.warn('Audit log write failed:', error);
  }
}

function exportVersionSummary() {
  const examId = norm($('examId')?.value || '');
  const box = $('examVersionHistory');
  if (!examId || !box) return show('Exam ID enter చేసి history load చేయండి.', 'err');
  const text = `KSR EXAMOS — VERSION HISTORY\nExam ID: ${examId}\nGenerated: ${new Date().toLocaleString('en-IN')}\n\n${box.innerText}`;
  const blob = new Blob([text], {type:'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=`KSR-${examId}-Version-History.txt`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  flash('Version history downloaded ✅');
}



/* =========================================================
   PHASE 6 · STEP 2 — EXAM BACKUP + RESTORE
========================================================= */
const EXAM_BACKUP_HISTORY_KEY = 'ksrExamosBackupHistoryV1';

function simpleBackupHash(value) {
  const input = JSON.stringify(value || {});
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function currentExamBackupPayload(reason = 'Manual backup') {
  sync();
  const payload = {
    format: 'KSR_EXAMOS_BACKUP',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    createdBy: user?.email || 'admin',
    reason,
    exam: {
      instituteId: $('instituteId')?.value || '',
      instituteName: $('instituteName')?.value || '',
      batchId: $('batchId')?.value || '',
      examId: norm($('examId')?.value || ''),
      title: $('examTitle')?.value || '',
      startTime: $('startTime')?.value || '',
      endTime: $('endTime')?.value || '',
      loginBefore: $('loginBefore')?.value || '',
      secondsPerQuestion: Number($('secondsPerQuestion')?.value || 60),
      backupCodeCount: Number($('backupCodeCount')?.value || 10),
      status: $('status')?.value || 'active',
      shuffleQuestions: Boolean($('shuffleQuestions')?.checked),
      shuffleOptions: Boolean($('shuffleOptions')?.checked),
      allowPrevious: Boolean($('allowPrevious')?.checked)
    },
    subjects: subjects.map(subject => ({
      name: cleanSubjectName(subject.name),
      rawBits: subject.rawBits || questionsToText(subject.questions || []),
      questions: (subject.questions || []).map(q => ({
        question: q.question || '',
        options: (q.options || []).map(o => ({ key:o.key || '', text:o.text || '' })),
        answer: q.answer || '',
        subject: q.subject || subject.name || 'General',
        className: q.className || q.class || '',
        lesson: q.lesson || q.topic || ''
      }))
    }))
  };
  payload.questionCount = payload.subjects.reduce((sum, s) => sum + s.questions.length, 0);
  payload.integrity = simpleBackupHash({ exam: payload.exam, subjects: payload.subjects, questionCount: payload.questionCount });
  return payload;
}

function readBackupHistory() {
  try { return JSON.parse(localStorage.getItem(EXAM_BACKUP_HISTORY_KEY) || '[]'); }
  catch { return []; }
}

function saveBackupHistoryEntry(payload) {
  try {
    const history = readBackupHistory();
    history.unshift({
      createdAt: payload.createdAt,
      examId: payload.exam.examId || 'UNSAVED-EXAM',
      title: payload.exam.title || payload.exam.examId || 'Untitled Exam',
      questionCount: payload.questionCount,
      reason: payload.reason,
      integrity: payload.integrity,
      payload
    });
    localStorage.setItem(EXAM_BACKUP_HISTORY_KEY, JSON.stringify(history.slice(0, 10)));
    renderBackupHistory();
  } catch (error) { console.warn('Backup history save failed:', error); }
}

function downloadBackupPayload(payload) {
  const examId = payload.exam.examId || 'UNSAVED-EXAM';
  const date = payload.createdAt.slice(0, 19).replace(/[:T]/g, '-');
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type:'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `KSR-${examId}-Backup-${date}.json`;
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function validateBackupPayload(payload) {
  if (!payload || payload.format !== 'KSR_EXAMOS_BACKUP') return 'ఇది valid KSR EXAMOS backup file కాదు.';
  if (Number(payload.schemaVersion) !== 1) return 'ఈ backup version ప్రస్తుతం support చేయబడదు.';
  if (!payload.exam || !Array.isArray(payload.subjects)) return 'Backup data incompleteగా ఉంది.';
  const expected = simpleBackupHash({ exam:payload.exam, subjects:payload.subjects, questionCount:Number(payload.questionCount || 0) });
  if (payload.integrity !== expected) return 'Backup integrity check failed. File మార్చబడినట్లు ఉంది.';
  return '';
}

function applyBackupPayload(payload) {
  const exam = payload.exam || {};
  const setValue = (id, value) => { if ($(id)) $(id).value = value ?? ''; };
  setValue('instituteId', exam.instituteId); setValue('instituteName', exam.instituteName);
  setValue('batchId', exam.batchId); setValue('examId', exam.examId); setValue('examTitle', exam.title);
  setValue('startTime', exam.startTime); setValue('endTime', exam.endTime); setValue('loginBefore', exam.loginBefore);
  setValue('secondsPerQuestion', exam.secondsPerQuestion || 60); setValue('backupCodeCount', exam.backupCodeCount ?? 10);
  setValue('status', exam.status || 'active');
  if ($('shuffleQuestions')) $('shuffleQuestions').checked = Boolean(exam.shuffleQuestions);
  if ($('shuffleOptions')) $('shuffleOptions').checked = Boolean(exam.shuffleOptions);
  if ($('allowPrevious')) $('allowPrevious').checked = exam.allowPrevious !== false;
  subjects = payload.subjects.map((subject, index) => ({
    name: cleanSubjectName(subject.name || `Subject ${index+1}`),
    rawBits: subject.rawBits || questionsToText(subject.questions || []),
    questions: Array.isArray(subject.questions) ? subject.questions : []
  }));
  if (!subjects.length) subjects = [{ name:'General', rawBits:'', questions:[] }];
  activeSubjectIndex = 0;
  questions = subjects[0].questions;
  if ($('rawBits')) $('rawBits').value = subjects[0].rawBits || questionsToText(questions);
  renderSubjectTabs(); renderEditor(); renderHealth(); renderDuplicateEngine();
  renderQuestionTypeAnalyzer(); renderSmartAnalytics(); renderExamQuality(); saveDraft();
}

function renderBackupHistory() {
  const box = $('backupHistory');
  if (!box) return;
  const history = readBackupHistory();
  if (!history.length) {
    box.innerHTML = '<p class="small">ఈ deviceలో backup history ఇంకా లేదు.</p>';
    return;
  }
  box.innerHTML = history.map((item, index) => `
    <article class="backupHistoryRow">
      <div><b>${esc(item.examId)}</b><span>${Number(item.questionCount||0)} questions</span></div>
      <small>${esc(new Date(item.createdAt).toLocaleString('en-IN'))} · ${esc(item.reason || 'Backup')}</small>
      <div class="backupHistoryActions"><button type="button" class="gray" data-backup-download="${index}">Download</button><button type="button" class="orange" data-backup-restore="${index}">Restore</button></div>
    </article>`).join('');
  box.querySelectorAll('[data-backup-download]').forEach(btn => btn.addEventListener('click', () => downloadBackupPayload(history[Number(btn.dataset.backupDownload)].payload)));
  box.querySelectorAll('[data-backup-restore]').forEach(btn => btn.addEventListener('click', () => {
    const payload = history[Number(btn.dataset.backupRestore)].payload;
    const error = validateBackupPayload(payload); if (error) return show(error,'err');
    if (!confirm(`${payload.exam.examId || 'Unsaved Exam'} backup restore చేయాలా? Current unsaved changes replace అవుతాయి.`)) return;
    applyBackupPayload(payload); flash('Backup restored successfully ✅');
  }));
}

function createManualExamBackup() {
  const payload = currentExamBackupPayload('Manual backup');
  saveBackupHistoryEntry(payload); downloadBackupPayload(payload);
  flash(`Backup ready ✅ ${payload.questionCount} questions`);
}

function createAutomaticLocalBackup(reason = 'Before exam save') {
  const payload = currentExamBackupPayload(reason);
  saveBackupHistoryEntry(payload);
  return payload;
}

async function restoreBackupFile(file) {
  try {
    const payload = JSON.parse(await file.text());
    const error = validateBackupPayload(payload); if (error) return show(error, 'err');
    const summary = `${payload.exam.examId || 'Unsaved Exam'}\n${payload.questionCount || 0} questions\nCreated: ${new Date(payload.createdAt).toLocaleString('en-IN')}`;
    if (!confirm(`Backup Preview\n\n${summary}\n\nRestore చేయాలా? Current unsaved changes replace అవుతాయి.`)) return;
    applyBackupPayload(payload); saveBackupHistoryEntry({ ...payload, reason:'Imported backup restored' });
    flash('Backup file restored successfully ✅');
  } catch (error) { show(`Backup restore failed: ${error.message}`, 'err'); }
}


/* =========================================================
   SPRINT 5 · FINAL EXAM VALIDATION PREVIEW
========================================================= */
function getFinalValidationSnapshot() {
  sync();
  const allQuestions = getAllQuestions();
  const issues = validateQuestionList(allQuestions);
  const instituteId = $('instituteId')?.value || '';
  const batchId = $('batchId')?.value || '';
  const instituteName = $('instituteName')?.value?.trim() || '';
  const batchName = batches.find(batch => batch.id === batchId)?.name || '';
  const examId = norm($('examId')?.value || '');
  const start = $('startTime')?.value || '';
  const end = $('endTime')?.value || '';
  const loginBefore = $('loginBefore')?.value || start;
  const activeStudents = batchStudents.length;
  const backupCodes = Math.max(0, Math.min(100, Number($('backupCodeCount')?.value || 0)));
  const subjectRows = subjects.map((subject, subjectIndex) => {
    const list = (subject.questions || []).map((question, questionIndex) => ({
      ...question,
      subject: subject.name,
      subjectIndex,
      subjectQuestionIndex: questionIndex
    }));
    const subjectIssues = validateQuestionList(list);
    return {
      name: subject.name || `Subject ${subjectIndex + 1}`,
      questions: list.length,
      marks: list.length,
      issues: subjectIssues.length,
      status: list.length && !subjectIssues.length ? 'Ready' : 'Needs Fix'
    };
  });
  const checks = [
    { key: 'institute', label: 'Institute selected', ok: Boolean(instituteId && instituteName) },
    { key: 'batch', label: 'Batch selected', ok: Boolean(batchId && batchName) },
    { key: 'examId', label: 'Exam ID entered', ok: Boolean(examId) },
    { key: 'time', label: 'Valid exam time', ok: Boolean(start && end && Date.parse(end) > Date.parse(start)) },
    { key: 'questions', label: 'Questions available', ok: allQuestions.length > 0 },
    { key: 'health', label: 'Parser Health 100%', ok: allQuestions.length > 0 && issues.length === 0 },
    { key: 'students', label: 'Active students loaded', ok: activeStudents > 0 }
  ];
  return {
    allQuestions, issues, instituteId, batchId, instituteName, batchName, examId,
    examTitle: $('examTitle')?.value?.trim() || examId || '-', start, end, loginBefore,
    seconds: Math.max(5, Number($('secondsPerQuestion')?.value || 60)),
    activeStudents, backupCodes, totalCodes: activeStudents + backupCodes,
    subjectRows, checks, ready: checks.every(check => check.ok)
  };
}

function closeFinalValidation() {
  const modal = $('finalValidationModal');
  if (modal) modal.hidden = true;
  document.body.classList.remove('finalValidationOpen');
}

function openFinalValidation() {
  const data = getFinalValidationSnapshot();
  const failed = data.checks.filter(check => !check.ok);
  const subjectTable = data.subjectRows.length ? data.subjectRows.map(row => `
    <tr class="${row.status === 'Ready' ? 'ready' : 'hasIssues'}"><td>${esc(row.name)}</td><td>${row.questions}</td><td>${row.marks}</td><td>${row.issues}</td><td><b>${row.status}</b></td></tr>`).join('') : '<tr><td colspan="5">Subjects levu.</td></tr>';
  $('finalValidationContent').innerHTML = `
    <div class="finalValidationStatus ${data.ready ? 'ready' : 'blocked'}">
      <strong>${data.ready ? 'READY TO SAVE' : 'SAVE BLOCKED'}</strong>
      <span>${data.ready ? 'All validation checks passed.' : `${failed.length} checks complete cheyyali.`}</span>
    </div>
    <div class="finalValidationSummary">
      <div><span>Institute</span><b>${esc(data.instituteName || '-')}</b></div>
      <div><span>Batch</span><b>${esc(data.batchName || '-')}</b></div>
      <div><span>Exam ID</span><b>${esc(data.examId || '-')}</b></div>
      <div><span>Exam Name</span><b>${esc(data.examTitle || '-')}</b></div>
      <div><span>Total Subjects</span><b>${data.subjectRows.length}</b></div>
      <div><span>Total Questions</span><b>${data.allQuestions.length}</b></div>
      <div><span>Total Marks</span><b>${data.allQuestions.length}</b></div>
      <div><span>Active Students</span><b>${data.activeStudents}</b></div>
      <div><span>Backup Codes</span><b>${data.backupCodes}</b></div>
      <div><span>Total Codes</span><b>${data.totalCodes}</b></div>
      <div><span>Start Time</span><b>${esc(formatDateTime(data.start))}</b></div>
      <div><span>End Time</span><b>${esc(formatDateTime(data.end))}</b></div>
    </div>
    <section class="finalValidationChecks"><h3>Validation Checklist</h3>${data.checks.map(check => `<div class="${check.ok ? 'ok' : 'fail'}"><span>${check.ok ? '✅' : '⛔'}</span><b>${esc(check.label)}</b></div>`).join('')}</section>
    <section class="finalValidationSubjects"><h3>Subject Health</h3><div class="subjectHealthTableWrap"><table class="subjectHealthTable"><thead><tr><th>Subject</th><th>Questions</th><th>Marks</th><th>Issues</th><th>Status</th></tr></thead><tbody>${subjectTable}<tr class="total"><td>Total</td><td>${data.allQuestions.length}</td><td>${data.allQuestions.length}</td><td>${data.issues.length}</td><td><b>${data.issues.length ? 'Needs Fix' : data.allQuestions.length ? 'Ready' : 'Empty'}</b></td></tr></tbody></table></div></section>
    ${failed.length ? `<div class="finalValidationWarning">⛔ ${failed.map(check => esc(check.label)).join(' · ')}</div>` : '<div class="finalValidationReady">✅ Confirm Save + Generate Codes press cheyyandi.</div>'}`;
  $('confirmFinalSaveBtn').disabled = !data.ready;
  $('finalValidationModal').hidden = false;
  document.body.classList.add('finalValidationOpen');
}

$('saveGenerateBtn')?.addEventListener('click', openFinalValidation);
$('closeFinalValidationBtn')?.addEventListener('click', closeFinalValidation);
$('editFinalValidationBtn')?.addEventListener('click', closeFinalValidation);
document.querySelectorAll('[data-close-final-validation]').forEach(element => element.addEventListener('click', closeFinalValidation));

/* =========================================================
   SAVE EXAM + GENERATE CODES
   Existing Exam ID unte confirmation vastundi.
   OK press chesthe existing exam update avutundi.
========================================================= */

async function performFinalExamSave() {
  const allQuestions = getAllQuestions();

  const instituteId = $('instituteId').value;
  const batchId = $('batchId').value;

  const instituteName =
    $('instituteName').value.trim();

  const batchName =
    batches.find(batch => batch.id === batchId)?.name ||
    '';

  const examPublicId = norm($('examId').value);

  const title =
    $('examTitle').value.trim() || examPublicId;

  const start = $('startTime').value;
  const end = $('endTime').value;

  const loginBefore =
    $('loginBefore').value || start;

  const seconds = Math.max(
    5,
    Number($('secondsPerQuestion').value || 60)
  );

  const backupCount = Math.max(
    0,
    Math.min(100, Number($('backupCodeCount')?.value || 10))
  );
  const count = Math.min(1000, batchStudents.length + backupCount);

  const issues = validateQuestionList(allQuestions);

  if (
    !instituteId ||
    !batchId ||
    !instituteName ||
    !examPublicId ||
    !start ||
    !end
  ) {
    return show(
      'Institute, Batch, Exam ID, Start Time, End Time enter cheyyandi.',
      'err'
    );
  }

  if (Date.parse(end) <= Date.parse(start)) {
    return show(
      'End Time, Start Time తర్వాత ఉండాలి.',
      'err'
    );
  }

  if (issues.length || !allQuestions.length) {
    return show(
      'Questions lo issues fix cheyyandi.',
      'err'
    );
  }

  const selectedBatch = batches.find(batch => batch.id === batchId);
  if (!selectedBatch || selectedBatch.instituteId !== instituteId) {
    return show('Selected Batch ee Institute ki sambandhinchindi kaadu. Institute/Batch malli select cheyyandi.', 'err');
  }

  await loadBatchStudents();
  const freshBatchId = $('batchId').value;
  const freshInstituteId = $('instituteId').value;
  if (freshBatchId !== batchId || freshInstituteId !== instituteId) {
    return show('Institute/Batch selection marindi. Malli Save + Generate Codes nokkandi.', 'err');
  }

  createAutomaticLocalBackup('Automatic backup before exam save');
  $('saveGenerateBtn').disabled = true;

  try {
    const examRef = doc(
      db,
      'exams',
      examPublicId
    );

    const oldExamSnapshot = await getDoc(examRef);
    const oldExamData = oldExamSnapshot.exists() ? oldExamSnapshot.data() : null;
    const previousVersion = oldExamSnapshot.exists() ? Number(oldExamData?.version || 1) : 0;
    const nextVersion = oldExamSnapshot.exists() ? previousVersion + 1 : 1;

    let isUpdatingExistingExam = false;

    if (oldExamSnapshot.exists()) {
      const overwriteConfirmed = confirm(
        `Exam ID "${examPublicId}" database lo already undi.\n\nExisting exam ni update cheyyala?\n\nOK = Update\nCancel = Save Cancel`
      );

      if (!overwriteConfirmed) {
        show(
          'Exam save cancel chesaru. Vere Exam ID use cheyyandi.',
          'err'
        );

        return;
      }

      isUpdatingExistingExam = true;
    }

    const totalSeconds =
      seconds * allQuestions.length;

    const selectedInstitute =
      institutes.find(
        institute =>
          institute.id === instituteId
      );

    const existingCreatedAt =
      oldExamSnapshot.exists()
        ? oldExamSnapshot.data().createdAt
        : null;

    if (oldExamSnapshot.exists()) {
      const oldQuestionsSnapshot = await getDoc(doc(db, 'examQuestions', examPublicId));
      const snapshotId = `${examPublicId}__v${previousVersion}`;
      await setDoc(doc(db, 'examVersions', snapshotId), {
        examId: examPublicId,
        version: previousVersion,
        action: 'Before update snapshot',
        exam: oldExamData || {},
        questions: oldQuestionsSnapshot.exists() ? (oldQuestionsSnapshot.data().questions || []) : [],
        subjects: oldQuestionsSnapshot.exists() ? (oldQuestionsSnapshot.data().subjects || []) : [],
        questionCount: Number(oldExamData?.questionCount || oldQuestionsSnapshot.data()?.questionCount || 0),
        savedBy: user?.email || 'admin',
        savedAt: serverTimestamp()
      }, { merge: false });
    }

    await setDoc(
      examRef,
      {
        instituteId,
        batchId,
        batchName,
        instituteName,

        logoUrl:
          selectedInstitute?.logoUrl || '',

        instituteCode: instituteName,

        title,

        examId: examPublicId,
        examCode: examPublicId,
        version: nextVersion,
        previousVersion,
        versionUpdatedAt: serverTimestamp(),

        startTime: new Date(start).toISOString(),
        endTime: new Date(end).toISOString(),

        loginBefore: new Date(
          loginBefore
        ).toISOString(),

        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),

        secondsPerQuestion: seconds,

        totalMinutes: Math.ceil(
          totalSeconds / 60
        ),

        status: $('status').value,

        questionCount: allQuestions.length,

        allowPrevious: true,
        questionShuffle: $('questionShuffle')?.value || 'subject',
        shuffleQuestions: ($('questionShuffle')?.value || 'subject') !== 'none',
        shuffleOptions: ($('optionShuffle')?.value || 'no') === 'yes',
        studentRandomization: $('studentRandomization')?.value || 'different',

        createdBy:
          user?.email || 'admin',

        createdAt:
          existingCreatedAt ||
          serverTimestamp(),

        updatedAt: serverTimestamp()
      },
      {
        merge: true
      }
    );

    await setDoc(
      doc(
        db,
        'examQuestions',
        examPublicId
      ),
      {
        examId: examPublicId,
        version: nextVersion,
        questions: allQuestions,
        subjects: subjects.map((subject, subjectIndex) => ({ name: subject.name, order: subjectIndex, questionCount: (subject.questions || []).length })),
        questionCount: allQuestions.length,
        updatedAt: serverTimestamp()
      },
      {
        merge: true
      }
    );

    await saveQuestionsToBank(
      examPublicId
    );

    /*
      Existing Exam update chesthe mundu codes delete cheyyadam ledu.
      Kotha codes generate chestundi.
    */

    lastCodes = [];

    const selectedStudents = batchStudents.map(student => ({ ...student, isBackup: false }));
    for (let i = 0; i < backupCount; i++) {
      selectedStudents.push({
        name: `Backup-${String(i + 1).padStart(2, '0')}`,
        roll: '',
        id: '',
        isBackup: true
      });
    }

    const generatedCodes = [];
    const usedCodes = new Set();

    for (let index = 0; index < selectedStudents.length; index++) {
      generatedCodes.push(
        await makeUniqueSixDigitCode(usedCodes)
      );
    }

    for (
      let startIndex = 0;
      startIndex < selectedStudents.length;
      startIndex += 450
    ) {
      const batch = writeBatch(db);

      const chunk = selectedStudents.slice(
        startIndex,
        startIndex + 450
      );

      chunk.forEach((student, chunkIndex) => {
        const index =
          startIndex + chunkIndex;

        const code = generatedCodes[index];

        const accessRef = doc(
          db,
          'studentAccess',
          code
        );

        batch.set(accessRef, {
          examId: examPublicId,
          examPublicId,

          instituteId,
          batchId,
          batchName,

          studentMasterId:
            student.id || '',

          assignedName:
            student.isBackup ? '' : (student.name || ''),

          studentName: '',

          roll:
            student.roll || '',

          code,

          status: 'unused',

          mobile: '',
          isBackup: Boolean(student.isBackup),

          createdAt: serverTimestamp()
        });

        lastCodes.push({
          id: accessRef.id,
          code,
          status: 'unused',

          studentName:
            student.isBackup ? `Backup-${String(index - batchStudents.length + 1).padStart(2, '0')}` : (student.name || ''),

          roll:
            student.roll || ''
        });
      });

      await batch.commit();
    }

    lastExam = {
      docId: examPublicId,
      examId: examPublicId,
      title,
      version: nextVersion,

      instituteId,
      batchId,
      batchName,
      instituteName,

      logoUrl:
        selectedInstitute?.logoUrl || '',

      startTime:
        new Date(start).toISOString(),

      endTime:
        new Date(end).toISOString(),

      loginBefore:
        new Date(loginBefore).toISOString(),

      secondsPerQuestion: seconds,

      questionCount: allQuestions.length,

      totalMinutes:
        Math.ceil(totalSeconds / 60)
    };

    $('resultExamId').value =
      examPublicId;

    if ($('codesExamId')) $('codesExamId').value = examPublicId;

    renderCodes();
    persistGeneratedCodes();

    await writeExamAudit(examPublicId, {
      action: isUpdatingExistingExam ? 'EXAM_UPDATED' : 'EXAM_CREATED',
      fromVersion: previousVersion,
      toVersion: nextVersion,
      questionCount: allQuestions.length,
      instituteId,
      batchId,
      title
    });
    await loadExamVersionHistory();

    localStorage.removeItem(DRAFT_KEY);

    if (isUpdatingExistingExam) {
      flash(
        `Exam updated to v${nextVersion} ✅ ${lastCodes.length} codes generated.`
      );

      show(
        `Exam updated successfully to version v${nextVersion} ✅ ${lastCodes.length} codes generated.`
      );
    } else {
      flash(
        `Exam v${nextVersion} saved ✅ ${lastCodes.length} codes generated.`
      );

      show(
        `Exam version v${nextVersion} saved successfully ✅ ${lastCodes.length} codes generated.`
      );
    }
  } catch (error) {
    console.error('Exam save error:', error);

    show(
      `Exam save avvaledu: ${error.message}`,
      'err'
    );
  } finally {
    $('saveGenerateBtn').disabled = false;
    renderHealth();
  }
}

$('confirmFinalSaveBtn')?.addEventListener('click', async () => {
  const data = getFinalValidationSnapshot();
  if (!data.ready) {
    openFinalValidation();
    return show('Final validation checks complete cheyyandi.', 'err');
  }
  closeFinalValidation();
  await performFinalExamSave();
});

function formatDateTime(value) {
  if (!value) {
    return '-';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '-';
  }

  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function renderCodes() {
  const exam = lastExam || {};

  $('codesBox').innerHTML = lastCodes.length
    ? `
      <div class="print-header codePdfHeader premiumCodesHeader">
        <div class="codesBrand">
          ${
            exam.logoUrl
              ? `
                <img
                  src="${esc(exam.logoUrl)}"
                  class="pdfLogo"
                >
              `
              : '<div class="brandSeal">KSR</div>'
          }

          <div>
            <h1>
              ${esc(
                exam.instituteName || 'Institute'
              )}
            </h1>

            <h3>
              ${esc(exam.title || 'Daily Test')}
              •
              ${esc(exam.batchName || 'Batch')}
            </h3>
          </div>
        </div>

        <p class="examIdHighlight">
          Exam ID:
          <b>${esc(exam.examId || '')}</b>
        </p>

        <div class="examInfoCards">
          <div>
            <span>Exam Starts</span>
            <b>
              ${esc(
                formatDateTime(exam.startTime)
              )}
            </b>
          </div>

          <div>
            <span>Login Before</span>
            <b>
              ${esc(
                formatDateTime(
                  exam.loginBefore ||
                  exam.startTime
                )
              )}
            </b>
          </div>

          <div>
            <span>Total Bits</span>
            <b>
              ${Number(
                exam.questionCount || 0
              )}
            </b>
          </div>

          <div>
            <span>Exam Time</span>
            <b>
              ${Number(
                exam.totalMinutes || 0
              )}
              Minutes
            </b>
          </div>
        </div>

        <div class="loginInstructions colorfulInstructions">
          <h3>Student Login Instructions</h3>

          <p>
            <b>Name:</b>
            మీ పేరు
          </p>

          <p>
            <b>Exam ID:</b>
            ${esc(exam.examId || '')}
            ఇవ్వండి
          </p>

          <p>
            <b>Exam Code:</b>
            కింద ఉన్న codes లో మీకు కేటాయించిన code ఇవ్వండి
          </p>

          <p>
            <b>Phone No:</b>
            మీ phone number ఇవ్వండి
          </p>
        </div>
      </div>

      <table class="table codesTable">
        <tr>
          <th>S.No</th>
          <th>Student Name</th>
          <th>Exam Code</th>
          <th>Signature</th>
        </tr>

        ${lastCodes
          .map(
            (codeData, index) => `
              <tr>
                <td>${index + 1}</td>

                <td>
                  <b>
                    ${esc(
                      codeData.studentName || ''
                    )}
                  </b>
                </td>

                <td>
                  <b>${esc(codeData.code)}</b>
                </td>

                <td></td>
              </tr>
            `
          )
          .join('')}
      </table>
    `
    : '<p>No codes</p>';
}



async function loadCodesByExamId() {
  const publicId = norm($('codesExamId')?.value);
  if (!publicId) return show('Codes kosam Exam ID enter cheyyandi.', 'err');

  const button = $('searchCodesBtn');
  if (button) { button.disabled = true; button.textContent = 'Searching...'; }
  if ($('codesSearchStatus')) $('codesSearchStatus').textContent = 'Exam mariyu codes search chestunnam...';

  try {
    let examSnap = await getDoc(doc(db, 'exams', publicId));
    let examData = examSnap.exists() ? { id: examSnap.id, ...examSnap.data() } : null;

    if (!examData) {
      const allExams = await getDocs(collection(db, 'exams'));
      allExams.forEach(d => {
        const x = d.data();
        if (!examData && norm(x.examId || x.examCode || d.id) === publicId) examData = { id: d.id, ...x };
      });
    }
    if (!examData) {
      lastCodes = [];
      lastExam = null;
      renderCodes();
      if ($('codesSearchStatus')) $('codesSearchStatus').textContent = 'Exam ID dorakaledu.';
      return show('Exam ID dorakaledu.', 'err');
    }

    const accessSnap = await getDocs(query(collection(db, 'studentAccess'), where('examId', '==', examData.examId || examData.examCode || publicId)));
    lastCodes = accessSnap.docs.map(d => {
      const x = d.data();
      return {
        id: d.id,
        code: x.code || d.id,
        status: x.status || 'unused',
        studentName: x.assignedName || x.studentName || (x.isBackup ? 'Backup Code' : ''),
        roll: x.roll || '',
        isBackup: Boolean(x.isBackup)
      };
    }).sort((a,b) => String(a.studentName||'').localeCompare(String(b.studentName||''), 'en', {numeric:true}) || String(a.code).localeCompare(String(b.code)));

    lastExam = {
      docId: examData.id,
      examId: examData.examId || examData.examCode || publicId,
      title: examData.title || examData.examTitle || publicId,
      instituteId: examData.instituteId || '',
      batchId: examData.batchId || '',
      batchName: examData.batchName || '',
      instituteName: examData.instituteName || examData.instituteCode || 'Institute',
      logoUrl: examData.logoUrl || '',
      startTime: examData.startTime || examData.start || '',
      endTime: examData.endTime || examData.end || '',
      loginBefore: examData.loginBefore || examData.startTime || examData.start || '',
      secondsPerQuestion: Number(examData.secondsPerQuestion || 60),
      questionCount: Number(examData.questionCount || 0),
      totalMinutes: Number(examData.totalMinutes || Math.ceil((Number(examData.secondsPerQuestion || 60) * Number(examData.questionCount || 0)) / 60))
    };

    renderCodes();
    persistGeneratedCodes();
    if ($('resultExamId')) $('resultExamId').value = lastExam.examId;
    if ($('codesSearchStatus')) $('codesSearchStatus').textContent = `${lastExam.examId}: ${lastCodes.length} codes loaded.`;
    show(`${lastCodes.length} exam codes loaded ✅`);
  } catch (error) {
    console.error('Code search error:', error);
    if ($('codesSearchStatus')) $('codesSearchStatus').textContent = error.message;
    show(`Codes load avvaledu: ${error.message}`, 'err');
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Search Exam Codes'; }
  }
}

$('searchCodesBtn')?.addEventListener('click', loadCodesByExamId);
$('codesExamId')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') loadCodesByExamId();
});

$('copyCodes').onclick = async () => {
  if (!lastCodes.length) {
    return show('Codes levu.', 'err');
  }

  await navigator.clipboard.writeText(
    `${lastExam.instituteName}\n` +
    `Exam ID: ${lastExam.examId}\n\n` +
    `Student Login:\n` +
    `Name: మీ పేరు\n` +
    `Exam ID: ${lastExam.examId}\n` +
    `Exam Code: కింద codes లో మీకు కేటాయించిన code\n` +
    `Phone No: మీ phone number\n\n` +
    `Codes:\n` +
    lastCodes
      .map(codeData => codeData.code)
      .join('\n')
  );

  show('Exam ID + Codes copied ✅');
};

$('printCodes').onclick = () => {
  if (!lastCodes.length) {
    return show('Codes levu.', 'err');
  }

  printSection(
    'codesBox',
    'Generated Exam Codes'
  );
};

$('shareWhatsapp').onclick = async () => {
  if (!lastExam || !lastCodes.length) {
    return show('Munduga Exam ID search chesi codes load cheyyandi.', 'err');
  }

  const link = location.href.replace(/dashboard\.html.*$/, 'index.html');
  const codeLines = lastCodes.map((item, index) =>
    `${index + 1}. ${item.studentName || 'Student'} — ${item.code}`
  ).join('\n');

  const text =
    `🏆 KSR ➕\n\n` +
    `Institute: ${lastExam.instituteName}\n` +
    `Batch: ${lastExam.batchName || '-'}\n` +
    `Exam: ${lastExam.title}\n` +
    `Exam ID: ${lastExam.examId}\n` +
    `Start: ${formatDateTime(lastExam.startTime)}\n` +
    `Login Before: ${formatDateTime(lastExam.loginBefore || lastExam.startTime)}\n` +
    `Questions: ${lastExam.questionCount}\n` +
    `Time: ${lastExam.totalMinutes} Minutes\n\n` +
    `Student Codes:\n${codeLines}\n\n` +
    `Exam Link: ${link}\n` +
    `Contact: 9063012104`;

  try {
    if (navigator.share) {
      await navigator.share({ title: `${lastExam.title} Codes`, text });
    } else {
      window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
    }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      await navigator.clipboard.writeText(text);
      show('WhatsApp message copied ✅ WhatsApp lo paste cheyyandi.');
    }
  }
};

$('loadResults').onclick = loadResults;

$('printResults').onclick = () => {
  printSection(
    'resultsBox',
    'Exam Results & Ranks'
  );
};

async function loadResults() {
  const publicId = norm(
    $('resultExamId').value
  );

  if (!publicId) {
    return show(
      'Results kosam Exam ID enter cheyyandi.',
      'err'
    );
  }

  let examDocId = '';
  let examData = null;

  const examSnapshot = await getDocs(
    collection(db, 'exams')
  );

  examSnapshot.forEach(documentSnapshot => {
    const data = documentSnapshot.data();

    if (
      norm(data.examId || data.examCode) ===
      publicId
    ) {
      examDocId = documentSnapshot.id;

      examData = {
        id: documentSnapshot.id,
        ...data
      };
    }
  });

  if (!examDocId) {
    return show(
      'Exam ID dorakaledu.',
      'err'
    );
  }

  const resultSnapshot = await getDocs(
    collection(db, 'results')
  );

  let rows = [];

  resultSnapshot.forEach(documentSnapshot => {
    const result = documentSnapshot.data();
    const resultDocId = norm(documentSnapshot.id);

    const possibleExamIds = [
      result.examId,
      result.examPublicId,
      result.examCode,
      result.publicExamId,
      result.exam?.id,
      result.exam?.examId,
      result.accessId
    ].map(norm).filter(Boolean);

    const matchesExam =
      possibleExamIds.includes(norm(examDocId)) ||
      possibleExamIds.includes(publicId) ||
      resultDocId === publicId ||
      resultDocId.startsWith(publicId + '_') ||
      resultDocId.startsWith(publicId + '-') ||
      resultDocId.includes('_' + publicId + '_');

    if (matchesExam) {
      rows.push({
        id: documentSnapshot.id,
        ...result,
        name: result.name || result.studentName || result.assignedName || result.student?.name || '-',
        studentName: result.studentName || result.name || result.assignedName || result.student?.name || '-',
        studentCode: result.studentCode || result.examCode || result.accessId || result.code || '-',
        examCode: result.examCode || result.studentCode || result.accessId || result.code || '-',
        batchName: result.batchName || examData?.batchName || '-',
        totalTime: Number(result.totalTime || result.timeTaken || result.durationSeconds || 0),
        score: Number(result.score || result.marks || result.obtainedMarks || 0),
        total: Number(result.total || result.totalMarks || result.questionCount || examData?.questionCount || 0)
      });
    }
  });

  rows.sort(
    (a, b) =>
      Number(b.score || 0) -
        Number(a.score || 0) ||
      (Number(a.totalTime) || 999999) -
        (Number(b.totalTime) || 999999) ||
      String(a.name || '').localeCompare(
        String(b.name || '')
      )
  );

  let rank = 0;
  let lastScore = null;

  rows = rows.map((result, index) => {
    if (Number(result.score) !== lastScore) {
      rank = index + 1;
    }

    lastScore = Number(result.score);

    return {
      ...result,
      rank
    };
  });

  if (!rows.length) {
    // Older/newer builds may have leaderboard entries even when a detailed result
    // document is unavailable. Use them as a safe fallback for ranks.
    try {
      const leaderSnap = await getDocs(query(collection(db, 'leaderboard'), where('examId', '==', publicId)));
      rows = leaderSnap.docs.map(d => {
        const x = d.data();
        return {
          id: d.id,
          ...x,
          name: x.name || x.studentName || '-',
          studentName: x.studentName || x.name || '-',
          studentCode: x.studentCode || x.code || '-',
          score: Number(x.score || 0),
          total: Number(x.total || examData?.questionCount || 0),
          percent: Number(x.percent || 0),
          totalTime: Number(x.totalTime || 0)
        };
      });
    } catch (error) {
      console.warn('Leaderboard fallback failed:', error);
    }
  }

  if (!rows.length) {
    let accessRows = [];
    try {
      const accessSnap = await getDocs(query(collection(db, 'studentAccess'), where('examId', '==', publicId)));
      accessRows = accessSnap.docs.map(d => d.data());
    } catch (error) {
      console.warn('Access summary failed:', error);
    }
    const totalCodes = accessRows.length;
    const writing = accessRows.filter(x => ['inProgress','writing','started'].includes(x.status)).length;
    const submitted = accessRows.filter(x => ['completed','submitted'].includes(x.status)).length;
    const notOpened = Math.max(0, totalCodes - writing - submitted);
    $('resultsBox').innerHTML = `
      <div class="print-header premiumPrintHeader"><div class="brandSeal">KSR</div><div>
        <h1>${esc(examData?.instituteName || examData?.instituteCode || 'KSR Institute')}</h1>
        <h3>${esc(examData?.title || publicId)} • ${esc(examData?.batchName || '')}</h3>
        <p>Exam ID: <b>${esc(publicId)}</b></p>
      </div></div>
      <div class="resultSummaryGrid">
        <div class="summaryCard"><span>Generated Codes</span><b>${totalCodes}</b></div>
        <div class="summaryCard"><span>Writing</span><b>${writing}</b></div>
        <div class="summaryCard"><span>Submitted</span><b>${submitted}</b></div>
        <div class="summaryCard"><span>Not Opened</span><b>${notOpened}</b></div>
      </div>
      <p class="msg warn"><b>Exam dorikindi.</b><br>Inka evaru exam submit cheyyaledu. Student submit chesina tarvatha Results & Ranks ikkada automatic ga vastayi.</p>`;
    return;
  }

  rows.sort(
    (a, b) => Number(b.score || 0) - Number(a.score || 0) ||
      (Number(a.totalTime) || 999999) - (Number(b.totalTime) || 999999) ||
      String(a.name || '').localeCompare(String(b.name || ''))
  );
  let fallbackRank = 0, fallbackLastScore = null;
  rows = rows.map((result, index) => {
    if (Number(result.score) !== fallbackLastScore) fallbackRank = index + 1;
    fallbackLastScore = Number(result.score);
    return { ...result, rank: fallbackRank };
  });

  const participants = rows.length;

  const highest = Math.max(
    ...rows.map(result =>
      Number(result.score || 0)
    )
  );

  const totalMarks = Math.max(
    ...rows.map(result =>
      Number(result.total || 0)
    ),
    0
  );

  const average = (
    rows.reduce(
      (total, result) =>
        total + Number(result.score || 0),
      0
    ) / participants
  ).toFixed(2);

  const averagePercentage = totalMarks
    ? (
        (Number(average) / totalMarks) *
        100
      ).toFixed(1)
    : '0.0';

  const topThree = rows
    .filter(result => result.rank <= 3)
    .slice(0, 3);

  const medals = ['🥇', '🥈', '🥉'];

  const institute =
    examData?.instituteName ||
    examData?.instituteCode ||
    'KSR Institute';

  const title =
    examData?.title || 'Daily Test';

  $('resultsBox').innerHTML = `
    <div class="print-header premiumPrintHeader">
      <div class="brandSeal">KSR</div>

      <div>
        <h1>${esc(institute)}</h1>

        <h3>
          ${esc(title)}
          •
          ${esc(examData?.batchName || '')}
        </h3>

        <p>
          Exam ID:
          <b>${esc(publicId)}</b>
        </p>
      </div>
    </div>

    <div class="resultSummaryGrid">
      <div class="summaryCard">
        <span>Participants</span>
        <b>${participants}</b>
      </div>

      <div class="summaryCard">
        <span>Highest Score</span>
        <b>${highest} / ${totalMarks}</b>
      </div>

      <div class="summaryCard">
        <span>Average Score</span>
        <b>${average}</b>
      </div>

      <div class="summaryCard">
        <span>Average Accuracy</span>
        <b>${averagePercentage}%</b>
      </div>
    </div>

    <h3 class="sectionTitle">
      🏆 Top 3 Ranks
    </h3>

    <div class="topRankGrid">
      ${topThree
        .map(
          (result, index) => `
            <div class="rankCard rank${index + 1}">
              <div class="medal">
                ${medals[index]}
              </div>

              <div class="rankNo">
                Rank ${result.rank}
              </div>

              <h3>
                ${esc(
                  result.name ||
                  result.studentName ||
                  '-'
                )}
              </h3>

              <p>
                Exam Code:
                <b>
                  ${esc(
                    result.studentCode ||
                    result.examCode ||
                    '-'
                  )}
                </b>
              </p>

              <strong>
                ${Number(result.score || 0)}
                /
                ${Number(result.total || 0)}
              </strong>
            </div>
          `
        )
        .join('')}
    </div>

    <h3 class="sectionTitle">
      Complete Rank List
    </h3>

    <table class="table resultTable">
      <tr>
        <th>Rank</th>
        <th>Name</th>
        <th>Batch</th>
        <th>Exam Code</th>
        <th>Score</th>
        <th>Total</th>
      </tr>

      ${rows
        .map(
          result => `
            <tr>
              <td>
                <b>${result.rank}</b>
              </td>

              <td>
                ${esc(
                  result.name ||
                  result.studentName ||
                  '-'
                )}
              </td>

              <td>
                ${esc(
                  result.batchName ||
                  examData?.batchName ||
                  '-'
                )}
              </td>

              <td>
                ${esc(
                  result.studentCode ||
                  result.examCode ||
                  '-'
                )}
              </td>

              <td>
                <b>
                  ${Number(result.score || 0)}
                </b>
              </td>

              <td>
                ${Number(result.total || 0)}
              </td>
            </tr>
          `
        )
        .join('')}
    </table>

    <div class="pdfFooter">
      ${esc(institute)}
      • Generated by KSR ➕ •
      ${new Date().toLocaleString('en-IN')}
    </div>
  `;
}

function printSection(id, title) {
  const element = $(id);

  if (
    !element ||
    !element.innerHTML.trim()
  ) {
    return show(
      'Print cheyyadaniki data ledu.',
      'err'
    );
  }

  const printWindow = window.open(
    '',
    '_blank'
  );

  printWindow.document.write(`
    <html>
      <head>
        <meta charset="utf-8">

        <title>${esc(title)}</title>

        <link
          rel="stylesheet"
          href="style.css"
        >

        <style>
          body {
            padding: 24px;
            background: #fff;
          }

          .table {
            width: 100%;
            border-collapse: collapse;
          }

          .table th,
          .table td {
            border: 1px solid #b8c6d6;
            padding: 8px;
            text-align: left;
          }

          .pdfFooter {
            margin-top: 20px;
            padding-top: 8px;
            border-top: 1px solid #94a3b8;
            text-align: center;
            font-size: 11px;
            color: #475569;
          }

          @page {
            margin: 14mm;
          }

          @media print {
            button {
              display: none !important;
            }

            .card {
              box-shadow: none !important;
            }

            .topRankGrid,
            .resultSummaryGrid {
              break-inside: avoid;
            }
          }
        </style>
      </head>

      <body>
        ${element.innerHTML}

        <script>
          setTimeout(() => window.print(), 500);
        <\/script>
      </body>
    </html>
  `);

  printWindow.document.close();
}

let allSavedExams = [];
let savedView = 'active';

$('searchExam').onclick = async () => {
  await ensureExamsLoaded();

  renderSavedExams(
    $('examSearch').value
  );
};

$('loadAllExams').onclick = async () => {
  await ensureExamsLoaded(true);

  $('examSearch').value = '';

  renderSavedExams('');
};

$('examSearch').addEventListener(
  'keydown',
  event => {
    if (event.key === 'Enter') {
      $('searchExam').click();
    }
  }
);

document
  .querySelectorAll('.examViewBtn')
  .forEach(button => {
    button.onclick = () => {
      savedView = button.dataset.view;

      document
        .querySelectorAll('.examViewBtn')
        .forEach(element => {
          element.classList.remove('active');
        });

      button.classList.add('active');

      renderSavedExams(
        $('examSearch').value
      );
    };
  });

async function ensureExamsLoaded(
  force = false
) {
  if (allSavedExams.length && !force) {
    return;
  }

  const snapshot = await getDocs(
    collection(db, 'exams')
  );

  allSavedExams = [];

  snapshot.forEach(documentSnapshot => {
    allSavedExams.push({
      id: documentSnapshot.id,
      ...documentSnapshot.data()
    });
  });

  allSavedExams.sort(
    (a, b) =>
      Number(b.createdAt?.seconds || 0) -
      Number(a.createdAt?.seconds || 0)
  );
}

function examBucket(exam) {
  if (
    exam.status === 'deleted' ||
    exam.deletedAt
  ) {
    return 'deleted';
  }

  if (
    exam.status === 'archived' ||
    exam.archivedAt
  ) {
    return 'archived';
  }

  return 'active';
}

function renderSavedExams(term = '') {
  const searchKey = String(term || '')
    .trim()
    .toLowerCase();

  let filteredExams = allSavedExams.filter(
    exam =>
      examBucket(exam) === savedView
  );

  if (searchKey) {
    filteredExams = filteredExams.filter(
      exam =>
        [
          exam.title,
          exam.examId,
          exam.examCode,
          exam.instituteName,
          exam.instituteCode,
          exam.batchName
        ].some(value =>
          String(value || '')
            .toLowerCase()
            .includes(searchKey)
        )
    );
  }

  $('savedExams').innerHTML =
    filteredExams.length
      ? filteredExams
          .map(exam => {
            const publicId =
              exam.examId ||
              exam.examCode ||
              exam.id;

            let actions = '';

            if (savedView === 'active') {
              actions = `
                <button
                  class="gray useResult"
                  data-id="${esc(publicId)}"
                >
                  Results
                </button>

                <button
                  class="orange archiveExam"
                  data-doc="${esc(exam.id)}"
                >
                  Archive
                </button>

                <button
                  class="danger trashExam"
                  data-doc="${esc(exam.id)}"
                >
                  Delete
                </button>
              `;
            } else if (
              savedView === 'archived'
            ) {
              actions = `
                <button
                  class="green restoreExam"
                  data-doc="${esc(exam.id)}"
                >
                  Restore
                </button>

                <button
                  class="danger trashExam"
                  data-doc="${esc(exam.id)}"
                >
                  Move to Bin
                </button>
              `;
            } else {
              actions = `
                <button
                  class="green restoreExam"
                  data-doc="${esc(exam.id)}"
                >
                  Restore
                </button>

                <button
                  class="danger permanentDeleteExam"
                  data-doc="${esc(exam.id)}"
                  data-name="${esc(publicId)}"
                >
                  Delete Permanently
                </button>
              `;
            }

            return `
              <div class="qcard">
                <b>
                  ${esc(
                    exam.title ||
                    publicId ||
                    'Exam'
                  )}
                </b>

                <p>
                  Exam ID:
                  <b>${esc(publicId)}</b>
                </p>

                <p>
                  ${esc(
                    exam.instituteName || ''
                  )}

                  ${
                    exam.batchName
                      ? '• ' +
                        esc(exam.batchName)
                      : ''
                  }

                  • Questions:
                  ${Number(
                    exam.questionCount || 0
                  )}

                  • Status:
                  ${esc(
                    exam.status || 'active'
                  )}
                </p>

                <div class="action-row">
                  ${actions}
                </div>
              </div>
            `;
          })
          .join('')
      : searchKey
      ? '<p class="msg warn">Matching exam dorakaledu.</p>'
      : '<p class="msg warn">Ee section lo exams levu.</p>';

  document
    .querySelectorAll('.useResult')
    .forEach(button => {
      button.onclick = () => {
        $('resultExamId').value =
          button.dataset.id;

        document
          .querySelector(
            '[data-open="resultsPanel"]'
          )
          ?.click();

        loadResults();
      };
    });

  document
    .querySelectorAll('.archiveExam')
    .forEach(button => {
      button.onclick = () =>
        changeExamState(
          button.dataset.doc,
          'archived'
        );
    });

  document
    .querySelectorAll('.trashExam')
    .forEach(button => {
      button.onclick = () =>
        changeExamState(
          button.dataset.doc,
          'deleted'
        );
    });

  document
    .querySelectorAll('.restoreExam')
    .forEach(button => {
      button.onclick = () =>
        changeExamState(
          button.dataset.doc,
          'active'
        );
    });

  document
    .querySelectorAll(
      '.permanentDeleteExam'
    )
    .forEach(button => {
      button.onclick = () =>
        permanentDeleteExam(
          button.dataset.doc,
          button.dataset.name
        );
    });
}

async function changeExamState(
  documentId,
  state
) {
  const labels = {
    archived: 'Archive',
    deleted: 'Recycle Bin',
    active: 'Restore'
  };

  if (
    !confirm(
      `${labels[state]} cheyyala?`
    )
  ) {
    return;
  }

  try {
    await updateDoc(
      doc(db, 'exams', documentId),
      {
        status: state,

        archivedAt:
          state === 'archived'
            ? serverTimestamp()
            : null,

        deletedAt:
          state === 'deleted'
            ? serverTimestamp()
            : null,

        restoredAt:
          state === 'active'
            ? serverTimestamp()
            : null
      }
    );

    allSavedExams = [];

    await ensureExamsLoaded(true);

    renderSavedExams(
      $('examSearch').value
    );

    flash(
      `Exam ${labels[state]} complete ✅`
    );
  } catch (error) {
    show(error.message, 'err');
  }
}

async function deleteMatchingDocs(
  collectionName,
  field,
  value
) {
  const snapshot = await getDocs(
    collection(db, collectionName)
  );

  const references = [];

  snapshot.forEach(documentSnapshot => {
    const data = documentSnapshot.data();

    if (
      data[field] === value ||
      documentSnapshot.id === value
    ) {
      references.push(
        documentSnapshot.ref
      );
    }
  });

  for (
    let startIndex = 0;
    startIndex < references.length;
    startIndex += 450
  ) {
    const batch = writeBatch(db);

    references
      .slice(
        startIndex,
        startIndex + 450
      )
      .forEach(reference => {
        batch.delete(reference);
      });

    await batch.commit();
  }
}

async function permanentDeleteExam(
  documentId,
  publicId
) {
  const typedExamId = prompt(
    `Permanent delete kosam Exam ID type cheyyandi:\n${publicId}`
  );

  if (
    norm(typedExamId) !==
    norm(publicId)
  ) {
    return flash(
      'Exam ID match avvaledu. Delete cancel.',
      'err'
    );
  }

  if (
    !confirm(
      'Exam, Questions, Codes, Results permanently delete avutayi. Continue?'
    )
  ) {
    return;
  }

  try {
    await deleteMatchingDocs(
      'examQuestions',
      'examId',
      documentId
    );

    await deleteMatchingDocs(
      'studentAccess',
      'examId',
      documentId
    );

    await deleteMatchingDocs(
      'results',
      'examId',
      documentId
    );

    await deleteDoc(
      doc(db, 'exams', documentId)
    );

    allSavedExams = [];

    await ensureExamsLoaded(true);

    renderSavedExams('');

    flash(
      'Exam permanently deleted ✅'
    );
  } catch (error) {
    show(error.message, 'err');
  }
  }

$('refreshTypeAnalysisBtn')?.addEventListener('click', () => { sync(); renderQuestionTypeAnalyzer(); renderSmartAnalytics(); flash('Question type analysis refreshed ✅'); });
$('refreshSmartAnalyticsBtn')?.addEventListener('click', () => { renderSmartAnalytics(); renderExamQuality(); flash('Smart Analytics refreshed ✅'); });
$('refreshExamQualityBtn')?.addEventListener('click', () => { renderExamQuality(); flash('Exam Quality refreshed ✅'); });
$('exportExamQualityBtn')?.addEventListener('click', exportExamQualityReport);
$('exportSmartAnalyticsBtn')?.addEventListener('click', exportSmartAnalyticsReport);

$('loadVersionHistoryBtn')?.addEventListener('click', loadExamVersionHistory);
$('exportVersionHistoryBtn')?.addEventListener('click', exportVersionSummary);
$('examId')?.addEventListener('change', loadExamVersionHistory);


$('createExamBackupBtn')?.addEventListener('click', createManualExamBackup);
$('restoreExamBackupBtn')?.addEventListener('click', () => $('examBackupFile')?.click());
$('examBackupFile')?.addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) restoreBackupFile(file);
  event.target.value = '';
});
$('refreshBackupHistoryBtn')?.addEventListener('click', renderBackupHistory);
renderBackupHistory();


// ===== Phase 6 Step 3: Bulk Question Manager =====
let bulkSelectedKeys = new Set();
let lastBulkSnapshot = null;

function bulkQuestionKey(subjectIndex, questionIndex) {
  return `${subjectIndex}:${questionIndex}`;
}

function cloneSubjectsForBulk() {
  commitCurrentSubject();
  return subjects.map(subject => ({
    ...subject,
    questions: (subject.questions || []).map(q => ({
      ...q,
      options: (q.options || []).map(o => ({ ...o }))
    }))
  }));
}

function saveBulkSnapshot(label) {
  lastBulkSnapshot = { label, subjects: cloneSubjectsForBulk(), activeSubjectIndex };
  if ($('bulkUndoBtn')) $('bulkUndoBtn').disabled = false;
}

function restoreBulkSnapshot() {
  if (!lastBulkSnapshot) return flash('Undo చేయడానికి action లేదు.', 'err');
  subjects = lastBulkSnapshot.subjects.map(subject => ({
    ...subject,
    questions: (subject.questions || []).map(q => ({ ...q, options: (q.options || []).map(o => ({ ...o })) }))
  }));
  activeSubjectIndex = Math.min(lastBulkSnapshot.activeSubjectIndex, Math.max(0, subjects.length - 1));
  bulkSelectedKeys.clear();
  const label = lastBulkSnapshot.label;
  lastBulkSnapshot = null;
  if ($('bulkUndoBtn')) $('bulkUndoBtn').disabled = true;
  loadActiveSubject();
  renderBulkQuestionManager();
  saveDraft();
  flash(`${label} undo పూర్తైంది ✅`);
}

function inferBulkDifficulty(q) {
  const explicit = String(q.difficulty || '').toLowerCase();
  if (['easy','medium','hard'].includes(explicit)) return explicit;
  const text = `${q.question || q.text || ''} ${(q.options || []).map(o => o.text || o.value || '').join(' ')}`;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 85 || /assertion|reason|match|statement|క్రింది వాక్య|జతపరచండి|పరిశీలించండి/i.test(text)) return 'hard';
  if (words >= 42) return 'medium';
  return 'easy';
}

function getBulkRows() {
  commitCurrentSubject();
  const search = String($('bulkSearchText')?.value || '').trim().toLowerCase();
  const subjectFilter = $('bulkSubjectFilter')?.value || 'all';
  const difficultyFilter = $('bulkDifficultyFilter')?.value || 'all';
  const lessonFilter = String($('bulkLessonFilter')?.value || '').trim().toLowerCase();
  const rows = [];
  subjects.forEach((subject, subjectIndex) => {
    (subject.questions || []).forEach((q, questionIndex) => {
      const questionText = String(q.question || q.text || '');
      const optionText = (q.options || []).map(o => String(o.text || o.value || '')).join(' ');
      const lesson = String(q.lesson || q.topic || q.chapter || '');
      const difficulty = inferBulkDifficulty(q);
      const haystack = `${questionText} ${optionText} ${lesson}`.toLowerCase();
      if (search && !haystack.includes(search)) return;
      if (subjectFilter !== 'all' && String(subjectIndex) !== subjectFilter) return;
      if (difficultyFilter !== 'all' && difficulty !== difficultyFilter) return;
      if (lessonFilter && !lesson.toLowerCase().includes(lessonFilter)) return;
      rows.push({ subject, subjectIndex, questionIndex, q, questionText, lesson, difficulty, key: bulkQuestionKey(subjectIndex, questionIndex) });
    });
  });
  return rows;
}

function refreshBulkSubjectFilter() {
  const select = $('bulkSubjectFilter');
  if (!select) return;
  const current = select.value || 'all';
  select.innerHTML = '<option value="all">All Subjects</option>' + subjects.map((s,i) => `<option value="${i}">${esc(s.name || `Subject ${i+1}`)}</option>`).join('');
  select.value = [...select.options].some(o => o.value === current) ? current : 'all';
}

function updateBulkSelectionStatus(visibleCount = null) {
  const status = $('bulkSelectionStatus');
  if (status) status.textContent = `${bulkSelectedKeys.size} selected${visibleCount === null ? '' : ` · ${visibleCount} visible`}`;
}

function renderBulkQuestionManager() {
  const box = $('bulkQuestionSummary');
  if (!box) return;
  refreshBulkSubjectFilter();
  const rows = getBulkRows();
  // Remove stale selection keys after move/delete operations.
  const allKeys = new Set();
  subjects.forEach((s,si) => (s.questions || []).forEach((q,qi) => allKeys.add(bulkQuestionKey(si,qi))));
  bulkSelectedKeys = new Set([...bulkSelectedKeys].filter(key => allKeys.has(key)));
  updateBulkSelectionStatus(rows.length);
  if (!rows.length) {
    box.innerHTML = '<p class="small">Filtersకి matching questions లేవు.</p>';
    return;
  }
  box.innerHTML = `<div class="bulkTableHead"><span>Select</span><span>Question</span><span>Subject / Lesson</span><span>Difficulty</span></div>` + rows.map(row => `
    <article class="bulkQuestionRow ${bulkSelectedKeys.has(row.key) ? 'selected' : ''}">
      <label class="bulkCheck"><input type="checkbox" data-bulk-key="${row.key}" ${bulkSelectedKeys.has(row.key) ? 'checked' : ''}></label>
      <button type="button" class="bulkQuestionOpen" data-bulk-open="${row.key}"><b>Q${row.questionIndex + 1}</b><span>${esc(row.questionText || '(Empty question)')}</span></button>
      <div><b>${esc(row.subject.name || `Subject ${row.subjectIndex+1}`)}</b><small>${esc(row.lesson || 'No lesson')}</small></div>
      <span class="bulkDifficulty ${row.difficulty}">${row.difficulty.toUpperCase()}</span>
    </article>`).join('');
  box.querySelectorAll('[data-bulk-key]').forEach(input => input.addEventListener('change', () => {
    if (input.checked) bulkSelectedKeys.add(input.dataset.bulkKey); else bulkSelectedKeys.delete(input.dataset.bulkKey);
    input.closest('.bulkQuestionRow')?.classList.toggle('selected', input.checked);
    updateBulkSelectionStatus(rows.length);
  }));
  box.querySelectorAll('[data-bulk-open]').forEach(btn => btn.addEventListener('click', () => {
    const [si, qi] = btn.dataset.bulkOpen.split(':').map(Number);
    activeSubjectIndex = si;
    loadActiveSubject();
    openQuestionInEditor(qi);
    $('questionEditor')?.scrollIntoView({ behavior:'smooth', block:'start' });
  }));
}

function selectedBulkEntries() {
  const entries = [];
  subjects.forEach((subject, subjectIndex) => (subject.questions || []).forEach((q, questionIndex) => {
    const key = bulkQuestionKey(subjectIndex, questionIndex);
    if (bulkSelectedKeys.has(key)) entries.push({ subject, subjectIndex, questionIndex, q, key });
  }));
  return entries;
}

function afterBulkOperation(message) {
  bulkSelectedKeys.clear();
  loadActiveSubject();
  renderBulkQuestionManager();
  renderQuestionTypeAnalyzer();
  renderSmartAnalytics();
  renderExamQuality();
  renderHealth();
  saveDraft();
  flash(message);
}

function bulkReplaceSelected() {
  const entries = selectedBulkEntries();
  const findText = String($('bulkFindText')?.value || '');
  const replacement = String($('bulkReplaceText')?.value || '');
  if (!entries.length) return flash('ముందుగా questions select చేయండి.', 'err');
  if (!findText) return flash('Find text enter చేయండి.', 'err');
  saveBulkSnapshot('Bulk replace');
  let changed = 0;
  const replaceOptions = Boolean($('bulkReplaceOptions')?.checked);
  entries.forEach(({q}) => {
    const re = new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const field = Object.prototype.hasOwnProperty.call(q, 'question') ? 'question' : 'text';
    const before = String(q[field] || '');
    q[field] = before.replace(re, replacement);
    if (q[field] !== before) changed++;
    if (replaceOptions) (q.options || []).forEach(option => {
      const optionField = Object.prototype.hasOwnProperty.call(option, 'text') ? 'text' : 'value';
      const old = String(option[optionField] || '');
      option[optionField] = old.replace(re, replacement);
      if (option[optionField] !== old) changed++;
    });
  });
  afterBulkOperation(`${entries.length} questionsలో ${changed} replacements పూర్తయ్యాయి ✅`);
}

function bulkSetDifficulty() {
  const entries = selectedBulkEntries();
  const difficulty = $('bulkSetDifficulty')?.value || '';
  if (!entries.length) return flash('ముందుగా questions select చేయండి.', 'err');
  if (!difficulty) return flash('Difficulty select చేయండి.', 'err');
  saveBulkSnapshot('Difficulty update');
  entries.forEach(({q}) => { q.difficulty = difficulty; });
  afterBulkOperation(`${entries.length} questionsకి ${difficulty.toUpperCase()} difficulty set అయింది ✅`);
}

function bulkMoveSelected() {
  const entries = selectedBulkEntries();
  const targetName = String($('bulkTargetSubject')?.value || '').trim();
  const lesson = String($('bulkTargetLesson')?.value || '').trim();
  if (!entries.length) return flash('ముందుగా questions select చేయండి.', 'err');
  if (!targetName && !lesson) return flash('Target Subject లేదా Lesson enter చేయండి.', 'err');
  saveBulkSnapshot('Bulk move');
  let targetIndex = activeSubjectIndex;
  if (targetName) {
    targetIndex = subjects.findIndex(s => String(s.name || '').trim().toLowerCase() === targetName.toLowerCase());
    if (targetIndex < 0) {
      subjects.push({ name: targetName, rawBits:'', questions:[] });
      targetIndex = subjects.length - 1;
    }
  }
  const moving = entries.map(({q}) => ({ ...q, subject: subjects[targetIndex].name, lesson: lesson || q.lesson || q.topic || '', options:(q.options||[]).map(o=>({...o})) }));
  // Delete from source in descending index order.
  const grouped = new Map();
  entries.forEach(e => { if (!grouped.has(e.subjectIndex)) grouped.set(e.subjectIndex, []); grouped.get(e.subjectIndex).push(e.questionIndex); });
  [...grouped.entries()].forEach(([si, indexes]) => indexes.sort((a,b)=>b-a).forEach(qi => subjects[si].questions.splice(qi,1)));
  subjects[targetIndex].questions.push(...moving);
  subjects.forEach(s => { s.rawBits = questionsToText(s.questions || []); });
  activeSubjectIndex = targetIndex;
  afterBulkOperation(`${moving.length} questions ${subjects[targetIndex].name}${lesson ? ` / ${lesson}` : ''}కి move అయ్యాయి ✅`);
}

function bulkDeleteSelected() {
  const entries = selectedBulkEntries();
  if (!entries.length) return flash('ముందుగా questions select చేయండి.', 'err');
  if (!confirm(`${entries.length} selected questions delete చేయాలా? Undo available.`)) return;
  saveBulkSnapshot('Bulk delete');
  const grouped = new Map();
  entries.forEach(e => { if (!grouped.has(e.subjectIndex)) grouped.set(e.subjectIndex, []); grouped.get(e.subjectIndex).push(e.questionIndex); });
  [...grouped.entries()].forEach(([si, indexes]) => indexes.sort((a,b)=>b-a).forEach(qi => subjects[si].questions.splice(qi,1)));
  subjects.forEach(s => { s.rawBits = questionsToText(s.questions || []); });
  afterBulkOperation(`${entries.length} questions deleted ✅`);
}

$('bulkRefreshBtn')?.addEventListener('click', () => { sync(); commitCurrentSubject(); renderBulkQuestionManager(); flash('Bulk Question Manager refreshed ✅'); });
['bulkSearchText','bulkLessonFilter'].forEach(id => $(id)?.addEventListener('input', renderBulkQuestionManager));
['bulkSubjectFilter','bulkDifficultyFilter'].forEach(id => $(id)?.addEventListener('change', renderBulkQuestionManager));
$('bulkSelectVisibleBtn')?.addEventListener('click', () => { getBulkRows().forEach(row => bulkSelectedKeys.add(row.key)); renderBulkQuestionManager(); });
$('bulkClearSelectionBtn')?.addEventListener('click', () => { bulkSelectedKeys.clear(); renderBulkQuestionManager(); });
$('bulkReplaceBtn')?.addEventListener('click', bulkReplaceSelected);
$('bulkDifficultyBtn')?.addEventListener('click', bulkSetDifficulty);
$('bulkMoveBtn')?.addEventListener('click', bulkMoveSelected);
$('bulkDeleteBtn')?.addEventListener('click', bulkDeleteSelected);
$('bulkUndoBtn')?.addEventListener('click', restoreBulkSnapshot);
renderBulkQuestionManager();
