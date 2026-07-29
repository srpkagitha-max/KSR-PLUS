import {
  auth, db, $, show, esc,
  onAuthStateChanged, signOut,
  collection, getDocs, query, where, doc, getDoc,
  updateDoc, deleteDoc, writeBatch, serverTimestamp
} from './app.js?v=20260729-dashboard-fix-v7';

let currentUser = null;
let lastExam = null;
let lastCodes = [];
let allSavedExams = [];
let savedView = 'active';

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

$('printCodes')?.addEventListener('click', () => {
  if (!lastCodes.length) return show('Codes levu.', 'err');
  window.print();
});

$('shareWhatsapp')?.addEventListener('click', () => {
  if (!lastCodes.length) return show('Munduga codes search cheyyandi.', 'err');
  const id = lastExam.examId || lastExam.examCode || lastExam.id;
  const text = `KSR Exam\nExam ID: ${id}\n\n` + lastCodes.map((x,i) => `${i+1}. ${x.studentName || 'Student'} - ${x.code}`).join('\n');
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
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
$('printResults')?.addEventListener('click', () => window.print());

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
