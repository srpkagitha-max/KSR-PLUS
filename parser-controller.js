import { parseQuestionsDetailed, analyzeQuestionHealth } from './parser.js?v=20260729-sprint9-linecheck-v1';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let standaloneQuestions = [];
let activeFilter = 'all';

function notify(message, type='ok') {
  const box=$('msg'); if(box){box.className=`msg ${type==='err'?'err':'ok'}`;box.textContent=message;}
}
function issuesFor(q,i){
  const out=[];
  if(!String(q.question||'').trim()) out.push({index:i,type:'emptyQuestion',severity:'critical',text:'Question text missing'});
  const opts=Array.isArray(q.options)?q.options:[];
  const missing=opts.filter(o=>!String(o.text||'').trim()).length;
  if(missing) out.push({index:i,type:'missingOptions',severity:missing>1?'critical':'warning',text:`${missing} option(s) missing`});
  if(!['A','B','C','D'].includes(String(q.answer||'').toUpperCase())) out.push({index:i,type:'missingAnswer',severity:'critical',text:'Correct answer missing'});
  return out;
}
function allIssues(){return standaloneQuestions.flatMap(issuesFor)}
function score(){const r=analyzeQuestionHealth(standaloneQuestions);return r.healthScore||0}
function filteredIssues(){const list=allIssues();return activeFilter==='all'?list:list.filter(x=>x.type===activeFilter||x.severity===activeFilter)}
function syncFromEditor(){
  document.querySelectorAll('[data-s9-question]').forEach(el=>standaloneQuestions[+el.dataset.s9Question].question=el.value);
  document.querySelectorAll('[data-s9-option]').forEach(el=>{const q=standaloneQuestions[+el.dataset.s9Option];const o=q.options.find(x=>x.key===el.dataset.key);if(o)o.text=el.value;});
  document.querySelectorAll('[data-s9-answer]').forEach(el=>standaloneQuestions[+el.dataset.s9Answer].answer=el.value);
  window.__KSR_STANDALONE_PARSED_QUESTIONS__=standaloneQuestions;
}
function renderEditor(){
  const editor=$('questionEditor'); if(!editor)return;
  editor.dataset.open='1';
  editor.innerHTML=`<section class="sprint9QuestionTools"><input id="s9QuestionSearch" inputmode="numeric" placeholder="Question number"><button type="button" id="s9SearchBtn">Open Question</button></section>`+standaloneQuestions.map((q,i)=>`<article class="qcard sprint8QuestionCard" id="s9-q-${i}"><div class="qhead"><b>Q${i+1}</b><div><button type="button" class="gray s9Up" data-i="${i}">↑</button><button type="button" class="gray s9Down" data-i="${i}">↓</button><button type="button" class="danger s9Delete" data-i="${i}">Delete</button></div></div><label>Question</label><textarea data-s9-question="${i}">${esc(q.question)}</textarea><div class="grid two">${['A','B','C','D'].map(k=>{const o=(q.options||[]).find(x=>x.key===k)||{text:''};return `<div><label>${k}) Option</label><input data-s9-option="${i}" data-key="${k}" value="${esc(o.text)}"></div>`}).join('')}</div><label>Correct Answer</label><select data-s9-answer="${i}"><option value="">Select correct answer</option>${['A','B','C','D'].map(k=>`<option value="${k}" ${q.answer===k?'selected':''}>${k}</option>`).join('')}</select><button type="button" class="green s9Apply" data-i="${i}">Save / Apply Fix</button></article>`).join('');
  document.querySelectorAll('[data-s9-question],[data-s9-option],[data-s9-answer]').forEach(el=>el.addEventListener('input',()=>{syncFromEditor();renderHealth();}));
  document.querySelectorAll('.s9Apply').forEach(b=>b.onclick=()=>{syncFromEditor();renderHealth();const next=filteredIssues()[0];if(next)jump(next.index);else notify('All parser issues solved ✅');});
  document.querySelectorAll('.s9Delete').forEach(b=>b.onclick=()=>{standaloneQuestions.splice(+b.dataset.i,1);renderAll();});
  document.querySelectorAll('.s9Up').forEach(b=>b.onclick=()=>{const i=+b.dataset.i;if(i>0)[standaloneQuestions[i-1],standaloneQuestions[i]]=[standaloneQuestions[i],standaloneQuestions[i-1]];renderAll();});
  document.querySelectorAll('.s9Down').forEach(b=>b.onclick=()=>{const i=+b.dataset.i;if(i<standaloneQuestions.length-1)[standaloneQuestions[i+1],standaloneQuestions[i]]=[standaloneQuestions[i],standaloneQuestions[i+1]];renderAll();});
  $('s9SearchBtn')?.addEventListener('click',()=>{const n=Number($('s9QuestionSearch')?.value);if(n>=1&&n<=standaloneQuestions.length)jump(n-1);else notify('Correct question number enter cheyyandi.','err');});
}
function jump(i){const card=$(`s9-q-${i}`);card?.scrollIntoView({behavior:'smooth',block:'start'});card?.classList.add('activeHealthQuestion');setTimeout(()=>card?.classList.remove('activeHealthQuestion'),1800)}
function renderHealth(){
  const health=$('health');if(!health)return;
  const issues=allIssues();const missing=issues.filter(x=>x.type==='missingAnswer').length;const critical=issues.filter(x=>x.severity==='critical').length;const status=issues.length?'NEEDS FIX':'READY';
  const subjectMap=new Map();standaloneQuestions.forEach((q,i)=>{const s=q.subject||$('subjectName')?.value||'General';if(!subjectMap.has(s))subjectMap.set(s,[]);subjectMap.get(s).push(i)});
  const rows=[...subjectMap.entries()].map(([s,indexes])=>{const n=indexes.reduce((a,i)=>a+issuesFor(standaloneQuestions[i],i).length,0);const m=indexes.reduce((a,i)=>a+issuesFor(standaloneQuestions[i],i).filter(x=>x.type==='missingAnswer').length,0);return `<tr data-s9-subject="${esc(s)}"><td><b>${esc(s)}</b></td><td>${indexes.length}</td><td>${indexes.length}</td><td>${m}</td><td>${n}</td><td>${n?'Needs Fix':'Ready'}</td></tr>`}).join('');
  const filters=[['all','All Issues'],['missingAnswer','Missing Answers'],['missingOptions','Missing Options'],['critical','Critical']];
  health.innerHTML=`<div class="examHealthTitleRow"><div><b>Parser Health Dashboard</b><small>Card లేదా question number press చేసి problem open చేయండి.</small></div><span class="healthStatusBadge ${issues.length?'critical':'healthy'}">${status}</span></div><div class="health-grid sprint8HealthGrid"><button data-s9-filter="all">Parsed Questions <b>${standaloneQuestions.length}</b></button><button data-s9-filter="missingAnswer">Missing Answers <b>${missing}</b></button><button data-s9-filter="critical">Critical Issues <b>${critical}</b></button><span>Health Score <b>${score()}%</b></span></div><div class="healthFilterBar">${filters.map(([k,l])=>`<button type="button" data-s9-filter="${k}" class="${activeFilter===k?'active':''}">${l}</button>`).join('')}</div><div class="sprint8IssueList">${filteredIssues().length?filteredIssues().map(x=>`<button type="button" data-s9-jump="${x.index}">Q${x.index+1}: ${esc(x.text)}</button>`).join(''):'<p>All questions ready ✅</p>'}</div><section class="finalSubjectHealthSection"><div class="examHealthTitleRow"><b>Final Subject Health Table</b></div><div class="subjectHealthTableWrap"><table class="subjectHealthTable"><thead><tr><th>Subject</th><th>Questions</th><th>Marks</th><th>Missing</th><th>Issues</th><th>Status</th></tr></thead><tbody>${rows}<tr><td><b>Total</b></td><td><b>${standaloneQuestions.length}</b></td><td><b>${standaloneQuestions.length}</b></td><td><b>${missing}</b></td><td><b>${issues.length}</b></td><td><b>${status}</b></td></tr></tbody></table></div></section>`;
  document.querySelectorAll('[data-s9-filter]').forEach(b=>b.onclick=()=>{activeFilter=b.dataset.s9Filter;renderHealth();});
  document.querySelectorAll('[data-s9-jump]').forEach(b=>b.onclick=()=>jump(+b.dataset.s9Jump));
}
function renderAll(){if($('subjectQuestionCount'))$('subjectQuestionCount').value=standaloneQuestions.length;renderHealth();renderEditor();window.__KSR_STANDALONE_PARSED_QUESTIONS__=standaloneQuestions;}
function parseStandalone(){
  const raw=$('rawBits')?.value||'',subject=($('subjectName')?.value||'General').trim()||'General';
  if(!raw.trim())return notify('Paste Bits box empty ga undi.','err');
  const result=parseQuestionsDetailed(raw,subject);standaloneQuestions=result.questions||[];
  if(!standaloneQuestions.length)return notify('Questions detect avvaledu. Format check cheyyandi.','err');
  renderAll();if($('parseBtn'))$('parseBtn').textContent='Questions Parsed ✅';notify(`${standaloneQuestions.length} questions detected ✅`);
}
function bind(){
  const btn=$('parseBtn');if(btn&&!btn.dataset.s9Bound){btn.dataset.s9Bound='1';btn.addEventListener('click',e=>{if(window.__KSR_CREATE_EXAM_CORE__?.parseRawQuestions){e.preventDefault();window.__KSR_CREATE_EXAM_CORE__.parseRawQuestions();return;}e.preventDefault();parseStandalone();});}
  const add=$('addSubjectBtn');if(add&&!add.dataset.s9Bound){add.dataset.s9Bound='1';add.addEventListener('click',()=>{if(window.__KSR_CREATE_EXAM_CORE__?.addNewSubjectParser)return;standaloneQuestions=[];if($('subjectName'))$('subjectName').value='';if($('rawBits'))$('rawBits').value='';renderAll();});}
}
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',bind,{once:true}):bind();setTimeout(bind,800);
