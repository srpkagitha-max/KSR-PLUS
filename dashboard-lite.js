import {
  auth, db, $, show, esc,
  
onAuthStateChanged, signOut,
  collection, getDocs, query, where, doc, getDoc,
  updateDoc, deleteDoc, writeBatch, serverTimestamp
} from './app.js?v=20260729-matching-pdf-v11';

const examPublicId = e => e?.examId || e?.examCode || e?.id || '-';
const examLink = () => new URL('index.html', location.href).href;
const prettyDate = v => { if(!v)return '-'; const d=v?.toDate?v.toDate():new Date(v); return isNaN(d)?String(v):d.toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}); };
const examMinutes = e => { const a=new Date(e?.startTime),b=new Date(e?.endTime); return !isNaN(a)&&!isNaN(b)?Math.max(1,Math.round((b-a)/60000)):Number(e?.totalMinutes||e?.questionCount||0); };
function premiumPrint(title, body){
 const w=window.open('','_blank'); if(!w)return show('Popup allow cheyyandi.','err');
 w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>*{box-sizing:border-box}body{margin:0;background:#dbe5ef;color:#101820;font-family:Arial,sans-serif}.sheet{width:794px;max-width:100%;margin:auto;background:#fff;min-height:1123px;padding:28px}.hero{border:2px solid #0b2f55;border-radius:18px;padding:20px;background:#fff;box-shadow:0 8px 24px #0b2f551f}.brand{display:flex;gap:14px;align-items:center;background:#0b2f55;color:#fff;margin:-20px -20px 0;padding:18px 20px;border-radius:15px 15px 0 0;border-bottom:5px solid #1673bd}.logo{width:58px;height:58px;border-radius:12px;background:#0b2f55;color:#fff;display:grid;place-items:center;font-weight:900;border:2px solid #061c32}.inst{font-size:28px;font-weight:900;color:#fff;text-shadow:0 1px 1px #000}.sub{font-weight:700;color:#d9eaff;margin-top:5px}.badge{margin:18px auto 14px;width:max-content;border:2px solid #0b2f55;background:#fff;color:#0b2f55;border-radius:8px;padding:8px 18px;font-weight:700}.stats,.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.stat,.summary div{border:1px solid #8ea7bd;border-radius:9px;background:#fff;padding:11px;text-align:center}.stat{border-top:5px solid #1673bd}.stat small{display:block;color:#31485d;margin-bottom:7px;font-weight:800}.stat b,.summary b{color:#071c31}.instructions{margin-top:15px;border:2px solid #0b2f55;background:#fff;border-radius:10px;padding:14px}.instructions h3{margin:-14px -14px 11px;padding:10px 14px;background:#0b2f55;color:#fff}.instructions p{margin:7px 0;color:#111}.link{margin-top:13px;background:#eef5fb;border-left:7px solid #1673bd;border-radius:7px;padding:11px;word-break:break-all;color:#071c31}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:13px}th{background:#082744;color:#fff;font-weight:900;padding:10px;text-align:left;border:1px solid #fff}td{border:1px solid #60788e;padding:9px;color:#050b12;font-weight:600}tr:nth-child(even) td{background:#edf3f8}.code{font-weight:900;letter-spacing:1px;color:#071c31}.summary{margin:16px 0}.summary div{border-top:5px solid #0b2f55}.summary b{display:block;font-size:23px;margin-top:5px}.footer{text-align:center;color:#334b60;font-size:11px;margin-top:16px;border-top:2px solid #0b2f55;padding-top:9px}@page{size:A4;margin:0}@media print{body{background:#fff}.sheet{width:100%;padding:22px}}</style></head><body>${body}<script>setTimeout(()=>window.print(),450)<\/script></body></html>`); w.document.close();
}


let currentUser = null;
let lastExam = null;
let lastCodes = [];
let allSavedExams = [];
let savedView = 'active';
let lastResultRows=[];
let lastResultAccess=[];

const norm = value => String(value || '').trim().toUpperCase();
const fmt = value => {
  if (!value) return '-';
  const date = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('en-IN');
};

onAuthStateChanged(auth, user => {
  if (!user) {
    location.href = 'login.html';
    return;
  }
  currentUser = user;
});

$('logout')?.addEventListener('click', async () => {
  await signOut(auth);
  location.href = 'login.html';
});

async function findExam(publicId) {
  const id = norm(publicId);
  if (!id) return null;
  const direct = await getDoc(doc(db, 'exams', id));
  if (direct.exists()) return { id: direct.id, ...direct.data() };

  const snap = await getDocs(collection(db, 'exams'));
  let found = null;
  snap.forEach(d => {
    const x = d.data();
    if (!found && [d.id, x.examId, x.examCode, x.title].some(v => norm(v) === id)) {
      found = { id: d.id, ...x };
    }
  });
  return found;
}

function renderCodes() {
  const box = $('codesBox');
  if (!box) return;
  if (!lastExam) {
    box.innerHTML = '<p class="small">Exam search cheyyandi.</p>';
    return;
  }
  box.innerHTML = `
    <div class="qcard">
      <h3>${esc(lastExam.title || lastExam.examId || lastExam.id)}</h3>
      <p><b>Exam ID:</b> ${esc(lastExam.examId || lastExam.examCode || lastExam.id)}</p>
      <p>${esc(lastExam.instituteName || '')} ${lastExam.batchName ? '• ' + esc(lastExam.batchName) : ''}</p>
      <p><b>Codes:</b> ${lastCodes.length}</p>
    </div>
    ${lastCodes.length ? lastCodes.map((x,i) => `
      <div class="qcard codeRow">
        <b>${i+1}. ${esc(x.studentName || (x.isBackup ? 'Backup Code' : 'Student'))}</b>
        <span class="pill">${esc(x.code)}</span>
        <small>${esc(x.status || 'unused')}</small>
      </div>`).join('') : '<p class="msg warn">Ee exam ki codes dorakaledu.</p>'}
  `;
}

async function loadCodes() {
  const publicId = norm($('codesExamId')?.value);
  if (!publicId) return show('Exam ID enter cheyyandi.', 'err');
  const btn = $('searchCodesBtn');
  btn.disabled = true;
  btn.textContent = 'Searching...';
  try {
    const exam = await findExam(publicId);
    if (!exam) throw new Error('Exam ID dorakaledu.');
    const examPublicId = exam.examId || exam.examCode || exam.id;
    let snap = await getDocs(query(collection(db, 'studentAccess'), where('examId', '==', examPublicId)));
    if (snap.empty && exam.id !== examPublicId) {
      snap = await getDocs(query(collection(db, 'studentAccess'), where('examId', '==', exam.id)));
    }
    lastExam = exam;
    lastCodes = snap.docs.map(d => {
      const x = d.data();
      return {
        id: d.id,
        code: x.code || d.id,
        studentName: x.assignedName || x.studentName || '',
        status: x.status || 'unused',
        isBackup: Boolean(x.isBackup)
      };
    }).sort((a,b) => String(a.studentName).localeCompare(String(b.studentName), 'en', {numeric:true}));
    renderCodes();
    $('codesSearchStatus').textContent = `${examPublicId}: ${lastCodes.length} codes loaded.`;
    show(`${lastCodes.length} codes loaded ✅`);
  } catch (e) {
    $('codesSearchStatus').textContent = e.message;
    show(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search Exam Codes';
  }
}

$('searchCodesBtn')?.addEventListener('click', loadCodes);
$('codesExamId')?.addEventListener('keydown', e => { if (e.key === 'Enter') loadCodes(); });

$('copyCodes')?.addEventListener('click', async () => {
  if (!lastCodes.length) return show('Munduga codes search cheyyandi.', 'err');
  const id = lastExam.examId || lastExam.examCode || lastExam.id;
  const text = `Exam ID: ${id}\n\n` + lastCodes.map((x,i) => `${i+1}. ${x.studentName || 'Student'} - ${x.code}`).join('\n');
  await navigator.clipboard.writeText(text);
  show('Codes copied ✅');
});

$('printCodes')?.addEventListener('click',()=>{
 if(!lastExam||!lastCodes.length)return show('Munduga codes search cheyyandi.','err');
 const id=examPublicId(lastExam),inst=lastExam.instituteName||'KSR Online Exams',batch=lastExam.batchName||'-';
 const rows=lastCodes.map((x,i)=>`<tr><td>${i+1}</td><td><b>${esc(x.studentName||(x.isBackup?'Backup Code':'Student'))}</b></td><td class="code">${esc(x.code)}</td></tr>`).join('');
 premiumPrint(id+' Codes',`<main class="sheet"><section class="hero"><div class="brand"><div class="logo">KSR</div><div><div class="inst">${esc(inst)}</div><div class="sub">${esc(id)} • ${esc(batch)}</div></div></div><div class="badge">Exam ID: <b>${esc(id)}</b></div><div class="stats"><div class="stat"><small>Exam Starts</small><b>${esc(prettyDate(lastExam.startTime))}</b></div><div class="stat"><small>Login Before</small><b>${esc(prettyDate(lastExam.loginBefore))}</b></div><div class="stat"><small>Total Bits</small><b>${Number(lastExam.questionCount||0)}</b></div><div class="stat"><small>Exam Time</small><b>${examMinutes(lastExam)} Minutes</b></div></div><div class="instructions"><h3>Student Login Instructions</h3><p><b>Name:</b> మీ పేరు ఇవ్వండి</p><p><b>Exam ID:</b> ${esc(id)} ఇవ్వండి</p><p><b>Exam Code:</b> కింద ఉన్న codes లో మీకు కేటాయించిన code ఇవ్వండి</p><p><b>Phone No:</b> మీ phone number ఇవ్వండి</p></div><div class="link"><b>Exam Link:</b> ${esc(examLink())}</div></section><table><thead><tr><th>S.No</th><th>Student Name</th><th>Exam Code</th></tr></thead><tbody>${rows}</tbody></table><div class="footer">Generated by KSR Online Exams</div></main>`);
});
$('shareWhatsapp')?.addEventListener('click',()=>{
 if(!lastExam||!lastCodes.length)return show('Munduga codes search cheyyandi.','err');
 const id=examPublicId(lastExam),inst=lastExam.instituteName||'KSR Online Exams',batch=lastExam.batchName||'-';
 const text=`🏆 KSR Online Exams\n\nInstitute: ${inst}\nBatch: ${batch}\nExam: ${lastExam.title||id}\nExam ID: ${id}\nStart: ${prettyDate(lastExam.startTime)}\nLogin Before: ${prettyDate(lastExam.loginBefore)}\nQuestions: ${Number(lastExam.questionCount||0)}\nTime: ${examMinutes(lastExam)} Minutes\n\nExam Link: ${examLink()}`;
 window.open('https://wa.me/?text='+encodeURIComponent(text),'_blank');
});

async function loadResults() {
  const publicId = norm($('resultExamId')?.value);
  if (!publicId) return show('Exam ID enter cheyyandi.', 'err');
  const btn = $('loadResults');
  btn.disabled = true;
  btn.textContent = 'Searching...';
  try {
    const exam = await findExam(publicId);
    if (!exam) throw new Error('Exam ID dorakaledu.');
    const examPublicId = exam.examId || exam.examCode || exam.id;
    const resultsSnap = await getDocs(collection(db, 'results'));
    let rows = resultsSnap.docs.map(d => ({id:d.id, ...d.data()})).filter(x => {
      const ids = [x.examId, x.examPublicId, x.examCode, x.publicExamId].map(norm);
      return ids.includes(norm(examPublicId)) || ids.includes(norm(exam.id)) || norm(x.id).startsWith(norm(examPublicId) + '_');
    });

    if (!rows.length) {
      const leaderSnap = await getDocs(query(collection(db, 'leaderboard'), where('examId', '==', examPublicId)));
      rows = leaderSnap.docs.map(d => ({id:d.id, ...d.data()}));
    }

    rows = rows.map(x => ({
      ...x,
      studentName: x.studentName || x.name || x.assignedName || '-',
      score: Number(x.score || x.marks || x.obtainedMarks || 0),
      total: Number(x.total || x.totalMarks || exam.questionCount || 0),
      submittedAt: x.submittedAt
    })).sort((a,b) => b.score-a.score || Number(a.submittedAt?.seconds||0)-Number(b.submittedAt?.seconds||0));

    const accessSnap = await getDocs(query(collection(db, 'studentAccess'), where('examId', '==', examPublicId)));
    const accessRows = accessSnap.docs.map(d => d.data());
    const writing = accessRows.filter(x => ['inProgress','writing','started'].includes(x.status)).length;
    const submitted = accessRows.filter(x => ['completed','submitted'].includes(x.status)).length;
    const notOpened = Math.max(0, accessRows.length-writing-submitted);
    lastExam=exam; lastResultRows=rows; lastResultAccess=accessRows;

    $('resultsBox').innerHTML = `
      <div class="qcard"><h3>${esc(exam.title || examPublicId)}</h3>
      <p><b>Exam ID:</b> ${esc(examPublicId)}</p>
      <p>${esc(exam.instituteName || '')} ${exam.batchName ? '• '+esc(exam.batchName) : ''}</p></div>
      <div class="resultSummaryGrid">
        <div class="summaryCard"><span>Total Codes</span><b>${accessRows.length}</b></div>
        <div class="summaryCard"><span>Writing</span><b>${writing}</b></div>
        <div class="summaryCard"><span>Submitted</span><b>${submitted}</b></div>
        <div class="summaryCard"><span>Not Opened</span><b>${notOpened}</b></div>
      </div>
      ${rows.length ? `<div class="tableWrap"><table class="table"><tr><th>Rank</th><th>Student</th><th>Score</th><th>Submitted</th></tr>${rows.map((r,i)=>`<tr><td>${i+1}</td><td>${esc(r.studentName)}</td><td>${r.score}/${r.total}</td><td>${esc(fmt(r.submittedAt))}</td></tr>`).join('')}</table></div>` : '<p class="msg warn">Exam dorikindi. Inka evaru submit cheyyaledu.</p>'}
    `;
    show(rows.length ? `${rows.length} results loaded ✅` : 'Exam loaded. Results inka levu.', rows.length ? 'ok' : 'warn');
  } catch(e) {
    $('resultsBox').innerHTML = `<p class="msg err">${esc(e.message)}</p>`;
    show(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Search Exam Results';
  }
}

$('loadResults')?.addEventListener('click', loadResults);
$('resultExamId')?.addEventListener('keydown', e => { if(e.key==='Enter') loadResults(); });
$('printResults')?.addEventListener('click',()=>{
 if(!lastExam)return show('Munduga results search cheyyandi.','err');
 const id=examPublicId(lastExam),inst=lastExam.instituteName||'KSR Online Exams',batch=lastExam.batchName||'-',a=lastResultAccess;
 const writing=a.filter(x=>['inProgress','writing','started'].includes(x.status)).length,submitted=a.filter(x=>['completed','submitted'].includes(x.status)).length,notOpened=Math.max(0,a.length-writing-submitted);
 const rows=lastResultRows.length?lastResultRows.map((r,i)=>`<tr><td>${i+1}</td><td><b>${esc(r.studentName)}</b></td><td>${r.score}/${r.total}</td><td>${r.total?Math.round(r.score/r.total*100):0}%</td><td>${esc(fmt(r.submittedAt))}</td></tr>`).join(''):'<tr><td colspan="5" style="text-align:center;padding:30px">ఇంకా ఎవరూ submit చేయలేదు.</td></tr>';
 premiumPrint(id+' Results',`<main class="sheet"><section class="hero"><div class="brand"><div class="logo">KSR</div><div><div class="inst">${esc(inst)}</div><div class="sub">Results & Ranks • ${esc(batch)}</div></div></div><div class="badge">Exam ID: <b>${esc(id)}</b></div><div class="stats"><div class="stat"><small>Exam Starts</small><b>${esc(prettyDate(lastExam.startTime))}</b></div><div class="stat"><small>Total Bits</small><b>${Number(lastExam.questionCount||0)}</b></div><div class="stat"><small>Exam Time</small><b>${examMinutes(lastExam)} Minutes</b></div><div class="stat"><small>Results</small><b>${lastResultRows.length}</b></div></div></section><div class="summary"><div>Total Students<b>${a.length}</b></div><div>Writing<b>${writing}</b></div><div>Submitted<b>${submitted}</b></div><div>Not Opened<b>${notOpened}</b></div></div><table><thead><tr><th>Rank</th><th>Student Name</th><th>Marks</th><th>%</th><th>Submitted</th></tr></thead><tbody>${rows}</tbody></table><div class="footer">${esc(inst)} • ${esc(id)} • KSR Online Exams</div></main>`);
});

function examBucket(exam) {
  if (exam.status === 'deleted' || exam.deletedAt) return 'deleted';
  if (exam.status === 'archived' || exam.archivedAt) return 'archived';
  return 'active';
}

async function ensureExams(force=false) {
  if (allSavedExams.length && !force) return;
  const snap = await getDocs(collection(db, 'exams'));
  allSavedExams = snap.docs.map(d => ({id:d.id, ...d.data()})).sort((a,b)=>Number(b.createdAt?.seconds||0)-Number(a.createdAt?.seconds||0));
}

function renderSaved(term='') {
  const key = String(term||'').trim().toLowerCase();
  const rows = allSavedExams.filter(x => examBucket(x)===savedView).filter(x => !key || [x.id,x.examId,x.examCode,x.title,x.instituteName,x.batchName].some(v=>String(v||'').toLowerCase().includes(key)));
  $('savedExams').innerHTML = rows.length ? rows.map(x => {
    const publicId=x.examId||x.examCode||x.id;
    return `<div class="qcard"><h3>${esc(x.title||publicId)}</h3><p>Exam ID: <b>${esc(publicId)}</b></p><p>${esc(x.instituteName||'')} ${x.batchName?'• '+esc(x.batchName):''} • Questions: ${Number(x.questionCount||0)}</p><div class="action-row">${savedView==='active'?`<button class="useResult" data-id="${esc(publicId)}">Results</button><button class="orange stateBtn" data-doc="${esc(x.id)}" data-state="archived">Archive</button><button class="danger stateBtn" data-doc="${esc(x.id)}" data-state="deleted">Delete</button>`:`<button class="green stateBtn" data-doc="${esc(x.id)}" data-state="active">Restore</button>`}</div></div>`;
  }).join('') : '<p class="msg warn">Matching exam dorakaledu.</p>';

  document.querySelectorAll('.useResult').forEach(b => b.onclick=()=>{
    $('resultExamId').value=b.dataset.id;
    document.querySelector('[data-open="resultsPanel"]')?.click();
    loadResults();
  });
  document.querySelectorAll('.stateBtn').forEach(b => b.onclick=async()=>{
    if(!confirm('Continue cheyyala?')) return;
    await updateDoc(doc(db,'exams',b.dataset.doc),{status:b.dataset.state,updatedAt:serverTimestamp()});
    await ensureExams(true); renderSaved($('examSearch').value); show('Exam updated ✅');
  });
}

$('searchExam')?.addEventListener('click', async()=>{try{await ensureExams();renderSaved($('examSearch').value)}catch(e){show(e.message,'err')}});
$('loadAllExams')?.addEventListener('click', async()=>{try{await ensureExams(true);$('examSearch').value='';renderSaved('')}catch(e){show(e.message,'err')}});
$('examSearch')?.addEventListener('keydown',e=>{if(e.key==='Enter')$('searchExam').click()});
document.querySelectorAll('.examViewBtn').forEach(b=>b.addEventListener('click',()=>{savedView=b.dataset.view;document.querySelectorAll('.examViewBtn').forEach(x=>x.classList.remove('active'));b.classList.add('active');renderSaved($('examSearch').value)}));
