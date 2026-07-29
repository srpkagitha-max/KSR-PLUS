import { parseQuestionsDetailed } from './parser.js?v=20260729-sprint8-controller-v1';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

function notify(message, type='ok') {
  const box = $('msg');
  if (box) {
    box.className = `msg ${type === 'err' ? 'err' : 'ok'}`;
    box.textContent = message;
  }
  console[type === 'err' ? 'error' : 'log'](`[Sprint8 Parser] ${message}`);
}

function healthIssues(question, index) {
  const issues = [];
  if (!question.question?.trim()) issues.push('Question text missing');
  if (!Array.isArray(question.options) || question.options.length !== 4) issues.push('4 options missing');
  if (!['A','B','C','D'].includes(question.answer)) issues.push('Correct answer missing');
  return issues.map(text => ({ index, text }));
}

function renderStandalone(result) {
  const questions = result.questions || [];
  window.__KSR_STANDALONE_PARSED_QUESTIONS__ = questions;
  if ($('subjectQuestionCount')) $('subjectQuestionCount').value = questions.length;
  if ($('parseBtn')) $('parseBtn').textContent = 'Questions Parsed ✅';

  const allIssues = questions.flatMap(healthIssues);
  const missing = questions.filter(q => !['A','B','C','D'].includes(q.answer)).length;
  const score = questions.length ? Math.max(0, Math.round(((questions.length - allIssues.length) / questions.length) * 100)) : 0;
  const health = $('health');
  if (health) {
    health.innerHTML = `
      <div class="examHealthTitleRow"><b>Parser Health Dashboard</b><span class="healthStatusBadge ${allIssues.length ? 'critical' : 'healthy'}">${allIssues.length ? 'NEEDS FIX' : 'READY'}</span></div>
      <div class="health-grid sprint8HealthGrid">
        <button type="button" class="healthMetric" data-health-filter="all">Parsed Questions: <b>${questions.length}</b></button>
        <button type="button" class="healthMetric" data-health-filter="missing">Missing Answers: <b>${missing}</b></button>
        <button type="button" class="healthMetric" data-health-filter="issues">Critical Issues: <b>${allIssues.length}</b></button>
        <span>Health Score: <b>${score}%</b></span>
      </div>
      <div id="sprint8IssueList" class="sprint8IssueList">${allIssues.length ? allIssues.map(issue => `<button type="button" data-q-index="${issue.index}">Q${issue.index + 1}: ${esc(issue.text)}</button>`).join('') : '<p>All questions ready ✅</p>'}</div>`;
  }

  const editor = $('questionEditor');
  if (editor) {
    editor.dataset.open = '1';
    editor.innerHTML = questions.map((q, i) => `
      <article class="qcard sprint8QuestionCard" id="sprint8-q-${i}">
        <div class="qhead"><b>Q${i + 1}</b><span>${esc(q.subject || $('subjectName')?.value || 'General')}</span></div>
        <label>Question</label><textarea data-s8-question="${i}">${esc(q.question)}</textarea>
        <div class="grid two">${['A','B','C','D'].map(key => {
          const option = (q.options || []).find(o => o.key === key) || {text:''};
          return `<div><label>${key}) Option</label><input data-s8-option="${i}" data-key="${key}" value="${esc(option.text)}"></div>`;
        }).join('')}</div>
        <label>Correct Answer</label><select data-s8-answer="${i}"><option value="">Select correct answer</option>${['A','B','C','D'].map(key => `<option value="${key}" ${q.answer === key ? 'selected' : ''}>${key}</option>`).join('')}</select>
      </article>`).join('');
  }

  document.querySelectorAll('[data-q-index]').forEach(button => button.addEventListener('click', () => {
    const card = $(`sprint8-q-${button.dataset.qIndex}`);
    card?.scrollIntoView({behavior:'smooth', block:'start'});
    card?.classList.add('activeHealthQuestion');
    setTimeout(() => card?.classList.remove('activeHealthQuestion'), 1800);
  }));

  notify(`${questions.length} questions detected ✅ · Health ${score}%`, allIssues.length ? 'ok' : 'ok');
}

function parseNow(event) {
  event?.preventDefault();
  event?.stopImmediatePropagation();
  const raw = $('rawBits')?.value || '';
  const subject = ($('subjectName')?.value || 'General').trim() || 'General';
  if (!raw.trim()) return notify('Paste Bits box empty ga undi.', 'err');

  try {
    if (window.__KSR_CREATE_EXAM_CORE__?.parseRawQuestions) {
      const response = window.__KSR_CREATE_EXAM_CORE__.parseRawQuestions();
      if (!response?.ok) notify('Questions detect avvaledu. Format check cheyyandi.', 'err');
      return;
    }
    const result = parseQuestionsDetailed(raw, subject);
    if (!result.questions?.length) return notify('Questions detect avvaledu. Question number + A/B/C/D format check cheyyandi.', 'err');
    renderStandalone(result);
  } catch (error) {
    notify(`Parser error: ${error?.message || error}`, 'err');
  }
}

function addParserFallback(event) {
  if (window.__KSR_CREATE_EXAM_CORE__?.addNewSubjectParser) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if ($('subjectName')) $('subjectName').value = '';
  if ($('rawBits')) $('rawBits').value = '';
  if ($('subjectQuestionCount')) $('subjectQuestionCount').value = '0';
  if ($('questionEditor')) { $('questionEditor').innerHTML = ''; $('questionEditor').dataset.open = '0'; }
  if ($('health')) $('health').innerHTML = '';
  $('subjectName')?.focus();
  notify('New parser ready ✅');
}

function bind() {
  const parseBtn = $('parseBtn');
  if (parseBtn && parseBtn.dataset.sprint8Bound !== '1') {
    parseBtn.dataset.sprint8Bound = '1';
    parseBtn.addEventListener('click', parseNow, true);
  }
  const addBtn = $('addSubjectBtn');
  if (addBtn && addBtn.dataset.sprint8Bound !== '1') {
    addBtn.dataset.sprint8Bound = '1';
    addBtn.addEventListener('click', addParserFallback, true);
  }
}

document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', bind, {once:true}) : bind();
setTimeout(bind, 500);
