import { auth, db, onAuthStateChanged, collection, getDocs, $, esc } from './app.js?v=20260729-sprint12-ordered-exam-builder-v1';
import { parseQuestionsDetailed } from './parser.js?v=20260729-sprint12-ordered-exam-builder-v1';

const state = { institutes: [], batches: [] };
const notify = (message, type = 'err') => {
  const box = $('msg');
  if (box) { box.className = `msg ${type}`; box.textContent = message; }
  console[type === 'err' ? 'error' : 'log'](message);
};

async function recoveryLoadMasters() {
  const instituteSelect = $('instituteId');
  const batchSelect = $('batchId');
  if (!instituteSelect || !batchSelect) return;
  try {
    const [is, bs] = await Promise.all([getDocs(collection(db,'institutes')), getDocs(collection(db,'batches'))]);
    state.institutes=[]; state.batches=[];
    is.forEach(d=>state.institutes.push({id:d.id,...d.data()}));
    bs.forEach(d=>state.batches.push({id:d.id,...d.data()}));
    state.institutes.sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
    const oldValue=instituteSelect.value;
    instituteSelect.innerHTML=state.institutes.length
      ? '<option value="">Select Institute</option>'+state.institutes.map(i=>`<option value="${i.id}">${esc(i.name||'Institute')}</option>`).join('')
      : '<option value="">No institutes found — add Institute first</option>';
    if (oldValue && state.institutes.some(i=>i.id===oldValue)) instituteSelect.value=oldValue;
    renderRecoveryBatches();
  } catch(error){ notify(`Institute/Batch load failed: ${error.message}`); }
}

function renderRecoveryBatches(){
  const iid=$('instituteId')?.value||'';
  const select=$('batchId'); if(!select)return;
  const old=select.value;
  const list=state.batches.filter(b=>String(b.instituteId||'')===String(iid));
  select.innerHTML=iid?(list.length?'<option value="">Select Batch</option>'+list.map(b=>`<option value="${b.id}">${esc(b.name||'Batch')}</option>`).join(''):'<option value="">No batches found</option>'):'<option value="">Select institute first</option>';
  if(old && list.some(b=>b.id===old))select.value=old;
  const inst=state.institutes.find(i=>i.id===iid); if($('instituteName'))$('instituteName').value=inst?.name||'';
}

async function recoveryLoadStudents(){
  const iid=$('instituteId')?.value||'', bid=$('batchId')?.value||'';
  if(!iid||!bid)return;
  try{
    if(window.__KSR_CREATE_EXAM_CORE__?.reloadBatchStudents){ await window.__KSR_CREATE_EXAM_CORE__.reloadBatchStudents(); return; }
    const snap=await getDocs(collection(db,'studentMaster')); let count=0;
    snap.forEach(d=>{const x=d.data()||{};const st=String(x.status||'').toLowerCase();if(String(x.batchId||'')===String(bid)&&(!x.instituteId||String(x.instituteId)===String(iid))&&x.active!==false&&!['hold','inactive','deleted'].includes(st))count++;});
    if($('activeStudentCount'))$('activeStudentCount').value=count;
    const backup=Number($('backupCodeCount')?.value||10);if($('codeCount'))$('codeCount').value=count+backup;
    notify(`${count} active students loaded ✅`,'ok');
  }catch(error){notify(`Students load failed: ${error.message}`);}
}

function fallbackEditableRender(result){
  const editor=$('questionEditor'); if(!editor)return;
  window.__KSR_RECOVERED_QUESTIONS__=result.questions;
  if($('subjectQuestionCount'))$('subjectQuestionCount').value=result.questions.length;
  editor.dataset.open='1';
  editor.innerHTML=result.questions.map((q,i)=>`<div class="qcard"><div class="qhead"><b>Q${i+1}</b><div><button class="gray fallbackUp" data-i="${i}">↑</button><button class="gray fallbackDown" data-i="${i}">↓</button><button class="danger fallbackDelete" data-i="${i}">Delete</button></div></div><label>Question</label><textarea class="fallbackQ" data-i="${i}">${esc(q.question)}</textarea><div class="grid two">${(q.options||[]).map((o,j)=>`<div><label>${o.key}) Option</label><input class="fallbackOpt" data-i="${i}" data-j="${j}" value="${esc(o.text)}"></div>`).join('')}</div><label>Correct Answer</label><select class="fallbackAns" data-i="${i}">${['A','B','C','D'].map(k=>`<option ${q.answer===k?'selected':''}>${k}</option>`).join('')}</select></div>`).join('');
  if(window.__KSR_CREATE_EXAM_CORE__?.renderHealth){
    window.__KSR_CREATE_EXAM_CORE__.renderHealth();
  } else {
    const health=$('health');
    if(health) health.innerHTML=`<div class="examHealthTitleRow"><b>Parser Health Dashboard</b><span class="healthStatusBadge ${result.diagnostics.criticalQuestions ? 'critical' : 'healthy'}">${result.diagnostics.criticalQuestions ? 'NEEDS FIX' : 'READY'}</span></div><div class="health-grid"><span>Parsed Questions: <b>${result.questions.length}</b></span><span>Health Score: <b>${result.diagnostics.healthScore}%</b></span><span>Missing Answers: <b>${result.diagnostics.missingAnswers}</b></span><span>Critical Issues: <b>${result.diagnostics.criticalQuestions}</b></span></div>`;
  }
  if($('parseBtn'))$('parseBtn').textContent='Questions Parsed ✅';
  notify(`${result.questions.length} questions detected ✅`,'ok');
}

function bindAuthoritativeParser(){
  const btn=$('parseBtn'); if(!btn||btn.dataset.coreV3==='1')return; btn.dataset.coreV3='1';
  btn.addEventListener('click',event=>{
    // Main bridge is authoritative and keeps Save/Preview state in sync.
    if(window.__KSR_CREATE_EXAM_CORE__?.parseRawQuestions){
      return; // main admin-daily listener is authoritative; do not block it in capture phase
    }
    event.preventDefault(); event.stopImmediatePropagation();
    try{const result=parseQuestionsDetailed($('rawBits')?.value||'',$('subjectName')?.value||'General');if(!result.questions.length)return notify('Questions detect avvaledu. Format check cheyyandi.');fallbackEditableRender(result);}catch(error){notify(`Parser error: ${error.message}`);}
  },true);
}

setTimeout(()=>{
  bindAuthoritativeParser();
  $('instituteId')?.addEventListener('change',()=>{renderRecoveryBatches();setTimeout(recoveryLoadStudents,50);});
  $('batchId')?.addEventListener('change',recoveryLoadStudents);
  onAuthStateChanged(auth,user=>{if(user)recoveryLoadMasters();});
},250);
