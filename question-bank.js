import {auth,db,onAuthStateChanged,signOut,collection,getDocs,doc,setDoc,deleteDoc,serverTimestamp,writeBatch,$,show,esc} from './app.js';
import {parseQuestions} from './parser.js';

let parsed=[];
let questions=[];
let subjects=[];
let page=1;
let moveIds=[];
let selectedLesson="";
const PAGE_SIZE=30;

const clean=v=>String(v??'').trim();
const norm=v=>clean(v).toLowerCase().replace(/\s+/g,' ');
const codeOf=v=>clean(v).toUpperCase().replace(/[^A-Z0-9_-]/g,'').slice(0,12);
const isGeneral=q=>!clean(q.subjectCode)&&(!clean(q.subject)||norm(q.subject)==='general');
const optionText=(q,key)=>(q.options||[]).find(o=>o.key===key)?.text||'';

function hashText(text){let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619)}return (h>>>0).toString(36)}
function signature(q){return norm([q.question,...(q.options||[]).map(o=>o.text),q.answer].join('|'))}
function qid(q,code='GEN'){return `${codeOf(code)||'GEN'}-${hashText(signature(q)).toUpperCase()}`}
function issuesFor(q){const a=[];if(!clean(q.question))a.push('Question missing');if((q.options||[]).filter(o=>clean(o.text)).length<4)a.push('Options missing');if(!['A','B','C','D'].includes(clean(q.answer).toUpperCase()))a.push('Answer missing');return a}
function subjectByCode(code){return subjects.find(s=>s.code===codeOf(code))}
function effectiveCode(q){const direct=codeOf(q.subjectCode);if(direct)return direct;const s=subjects.find(x=>norm(x.name)===norm(q.subject));return s?.code||''}
function getSubjectMeta(code){const s=subjectByCode(code);return s?{subject:s.name,subjectCode:s.code}:{subject:'General',subjectCode:''}}

function renderDashboard(){
  const lessons=new Set(questions.map(q=>clean(q.lesson)).filter(x=>x&&norm(x)!=='general'));
  $('totalQuestions').textContent=questions.length;
  $('totalSubjects').textContent=subjects.length;
  $('totalLessons').textContent=lessons.size;
  const generalTotal=questions.filter(isGeneral).length;
  $('generalCount').textContent=generalTotal;
  if($('dashboardGeneral')) $('dashboardGeneral').textContent=generalTotal;
}

function subjectOptions(selected=''){
  return `<option value="">General — No Subject</option>`+subjects.map(s=>`<option value="${esc(s.code)}" ${s.code===selected?'selected':''}>${esc(s.name)} — ${esc(s.code)}</option>`).join('');
}
function refreshSubjectControls(){
  $('subjectSelect').innerHTML=subjectOptions($('subjectSelect').value);
  $('editSubject').innerHTML=subjectOptions($('editSubject').value);
  $('moveSubject').innerHTML=subjectOptions($('moveSubject').value);
  $('browseSubject').innerHTML=`<option value="">All Subjects</option>`+subjects.map(s=>`<option value="${esc(s.code)}">${esc(s.name)} — ${esc(s.code)}</option>`).join('');
}

function renderSubjects(){
  const counts={};questions.forEach(q=>{const c=effectiveCode(q);if(c)counts[c]=(counts[c]||0)+1});
  $('subjectList').innerHTML=subjects.map(s=>`<div class="qbSubjectRow">
    <button class="qbSubjectOpen" data-code="${esc(s.code)}"><span><b>${esc(s.name)}</b><small>Code: ${esc(s.code)}</small></span><strong>${counts[s.code]||0}</strong></button>
    <button class="gray subjectEdit" data-code="${esc(s.code)}">Edit</button>
    <button class="danger subjectDelete" data-code="${esc(s.code)}">Delete</button>
  </div>`).join('')||'<p class="small">Subjects levu. Paina name and code enter chesi save cheyyandi.</p>';
  document.querySelectorAll('.qbSubjectOpen').forEach(b=>b.onclick=()=>{ $('browseSubject').value=b.dataset.code; selectedLesson=''; page=1;renderSubjectQuestions();$('browseSubject').scrollIntoView({behavior:'smooth',block:'center'}); });
  document.querySelectorAll('.subjectEdit').forEach(b=>b.onclick=()=>editSubject(b.dataset.code));
  document.querySelectorAll('.subjectDelete').forEach(b=>b.onclick=()=>deleteSubject(b.dataset.code));
}

function questionCard(q,index,{selectable=false}={}){
  const ec=effectiveCode(q);const meta=isGeneral(q)?'General':`${q.subject||'Subject'} — ${ec}`;
  return `<article class="qcard qbV2QuestionCard">
    <div class="qhead">
      <div>${selectable?`<input class="generalCheck" type="checkbox" value="${esc(q.id)}">`:''}<b>Q${index}. ${esc(q.question)}</b></div>
      <span class="qbDifficulty">${esc(q.difficulty||'Not Selected')}</span>
    </div>
    <div class="qbOptions">${(q.options||[]).map(o=>`<p class="${q.answer===o.key?'correctOption':''}">${o.key}) ${esc(o.text)} ${q.answer===o.key?'✅':''}</p>`).join('')}</div>
    <div class="qbQuestionMeta"><span>${esc(meta)}</span><span>Class: ${esc(q.className||'-')}</span><span>Lesson: ${esc(q.lesson||'-')}</span></div>
    <div class="action-row compact"><button class="gray qEdit" data-id="${esc(q.id)}">Edit</button><button class="qMove" data-id="${esc(q.id)}">Move</button><button class="danger qDelete" data-id="${esc(q.id)}">Delete</button></div>
  </article>`;
}
function wireQuestionButtons(root=document){
  root.querySelectorAll('.qEdit').forEach(b=>b.onclick=()=>openEdit(b.dataset.id));
  root.querySelectorAll('.qMove').forEach(b=>b.onclick=()=>openMove([b.dataset.id]));
  root.querySelectorAll('.qDelete').forEach(b=>b.onclick=()=>deleteQuestions([b.dataset.id]));
}

function renderGeneral(){
  const k=norm($('generalSearch').value);
  const rows=questions.filter(isGeneral).filter(q=>!k||norm([q.question,...(q.options||[]).map(o=>o.text),q.className,q.lesson].join(' ')).includes(k));
  $('generalList').innerHTML=rows.map((q,i)=>questionCard(q,i+1,{selectable:true})).join('')||'<p class="msg warn">General questions levu.</p>';
  wireQuestionButtons($('generalList'));
}
function renderSubjectQuestions(){
  const code=$('browseSubject').value;
  const k=norm($('browseSearch').value);
  const subjectRows=questions.filter(q=>!isGeneral(q)&&(!code||effectiveCode(q)===code));
  const lessonMap=new Map();
  subjectRows.forEach(q=>{const lesson=clean(q.lesson)||'No Lesson';lessonMap.set(lesson,(lessonMap.get(lesson)||0)+1)});
  const subjectMeta=code?subjectByCode(code):null;
  if($('selectedSubjectSummary')) $('selectedSubjectSummary').innerHTML=subjectMeta?`<div><b>${esc(subjectMeta.name)}</b><small>Code: ${esc(subjectMeta.code)} · ${subjectRows.length} Questions · ${lessonMap.size} Lessons</small></div>`:`<div><b>All Subjects</b><small>${subjectRows.length} Questions</small></div>`;
  if($('lessonFolders')) $('lessonFolders').innerHTML=[`<button class="qbLessonFolder ${!selectedLesson?'active':''}" data-lesson=""><span>All Lessons</span><strong>${subjectRows.length}</strong></button>`,...Array.from(lessonMap.entries()).sort((a,b)=>a[0].localeCompare(b[0])).map(([lesson,count])=>`<button class="qbLessonFolder ${selectedLesson===lesson?'active':''}" data-lesson="${esc(lesson)}"><span>${esc(lesson)}</span><strong>${count}</strong></button>`)].join('');
  document.querySelectorAll('.qbLessonFolder').forEach(b=>b.onclick=()=>{selectedLesson=b.dataset.lesson||'';page=1;renderSubjectQuestions()});
  const rows=subjectRows.filter(q=>!selectedLesson||(clean(q.lesson)||'No Lesson')===selectedLesson).filter(q=>!k||norm([q.question,...(q.options||[]).map(o=>o.text),q.className,q.lesson,q.subject,q.subjectCode].join(' ')).includes(k));
  const pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE));page=Math.min(page,pages);
  const shown=rows.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE);
  $('subjectQuestionsList').innerHTML=shown.map((q,i)=>questionCard(q,(page-1)*PAGE_SIZE+i+1)).join('')||'<p class="msg warn">Questions levu.</p>';
  $('pageInfo').textContent=`Page ${page} / ${pages} · ${rows.length} questions${selectedLesson?` · ${selectedLesson}`:''}`;
  $('prevPage').disabled=page<=1;$('nextPage').disabled=page>=pages;
  wireQuestionButtons($('subjectQuestionsList'));
}

function renderPreview(){
  const existing=new Set(questions.map(signature));let invalid=0,duplicates=0;
  $('preview').innerHTML=parsed.map((q,i)=>{const issues=issuesFor(q),dup=existing.has(signature(q));if(issues.length)invalid++;if(dup)duplicates++;return `<div class="qcard ${issues.length?'issue-card':''} ${dup?'duplicate-card':''}"><b>Q${i+1}. ${esc(q.question)}</b>${(q.options||[]).map(o=>`<p>${o.key}) ${esc(o.text)} ${q.answer===o.key?'✅':''}</p>`).join('')}${issues.length?`<p class="msg err">${issues.join(' · ')}</p>`:''}${dup?'<p class="msg warn">Duplicate — save lo skip avutundi.</p>':''}</div>`}).join('');
  const valid=Math.max(0,parsed.length-invalid-duplicates);
  $('parseInfo').innerHTML=`Total: <b>${parsed.length}</b> &nbsp; New Valid: <b>${valid}</b> &nbsp; Invalid: <b>${invalid}</b> &nbsp; Duplicate: <b>${duplicates}</b>`;
  $('saveBtn').disabled=!parsed.length||invalid>0||valid===0;
}

async function loadAll(){
  const [qSnap,sSnap]=await Promise.all([getDocs(collection(db,'questionBank')),getDocs(collection(db,'questionBankSubjects'))]);
  questions=[];qSnap.forEach(d=>questions.push({id:d.id,...d.data()}));
  subjects=[];sSnap.forEach(d=>subjects.push({id:d.id,...d.data(),code:codeOf(d.data().code||d.id),name:clean(d.data().name)}));
  // Existing projects may already have subject names but no subject master/code. Keep them visible.
  const known=new Set(subjects.map(s=>norm(s.name)));
  questions.forEach(q=>{const name=clean(q.subject);if(name&&norm(name)!=='general'&&!known.has(norm(name))){let base=codeOf(q.subjectCode)||codeOf(name.replace(/\s+/g,'').slice(0,3))||'SUB';let code=base,n=2;while(subjects.some(s=>s.code===code))code=`${base}${n++}`;subjects.push({id:code,code,name,inferred:true});known.add(norm(name));}});
  subjects.sort((a,b)=>a.name.localeCompare(b.name));
  questions.sort((a,b)=>String(a.subject||'').localeCompare(String(b.subject||''))||String(a.lesson||'').localeCompare(String(b.lesson||''))||String(a.question||'').localeCompare(String(b.question||'')));
  refreshSubjectControls();renderDashboard();renderSubjects();renderGeneral();renderSubjectQuestions();if(parsed.length)renderPreview();
}

async function saveSubject(name,code){
  name=clean(name);code=codeOf(code);if(!name||!code)throw new Error('Subject name mariyu code rendu enter cheyyandi.');
  if(subjects.some(s=>s.code===code))throw new Error('Ee subject code already undhi.');
  if(subjects.some(s=>norm(s.name)===norm(name)))throw new Error('Ee subject name already undhi.');
  await setDoc(doc(db,'questionBankSubjects',code),{name,code,createdAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:false});
}
async function editSubject(code){
  const s=subjectByCode(code);if(!s)return;
  const name=prompt('Subject name:',s.name);if(name===null||!clean(name))return;
  const newCode=codeOf(prompt('Subject code:',s.code));if(!newCode)return show('Code required.','err');
  if(newCode!==s.code&&subjects.some(x=>x.code===newCode))return show('Code already exists.','err');
  if(norm(name)!==norm(s.name)&&subjects.some(x=>norm(x.name)===norm(name)))return show('Subject name already exists.','err');
  await setDoc(doc(db,'questionBankSubjects',newCode),{name:clean(name),code:newCode,updatedAt:serverTimestamp(),createdAt:s.createdAt||serverTimestamp()},{merge:true});
  const affected=questions.filter(q=>codeOf(q.subjectCode)===s.code||(!q.subjectCode&&norm(q.subject)===norm(s.name)));
  for(let i=0;i<affected.length;i+=400){const wb=writeBatch(db);affected.slice(i,i+400).forEach(q=>wb.set(doc(db,'questionBank',q.id),{subject:clean(name),subjectCode:newCode,updatedAt:serverTimestamp()},{merge:true}));await wb.commit();}
  if(newCode!==s.code&&!s.inferred)await deleteDoc(doc(db,'questionBankSubjects',s.code));
  await loadAll();show('Subject updated ✅');
}
async function deleteSubject(code){
  const s=subjectByCode(code);if(!s)return;const count=questions.filter(q=>codeOf(q.subjectCode)===code).length;
  if(count&&!confirm(`${s.name} subject master delete chesthe ${count} questions General ki move avutayi. Continue?`))return;
  if(!count&&!confirm(`${s.name} subject delete cheyyala?`))return;
  const affected=questions.filter(q=>codeOf(q.subjectCode)===code);
  for(let i=0;i<affected.length;i+=400){const wb=writeBatch(db);affected.slice(i,i+400).forEach(q=>wb.set(doc(db,'questionBank',q.id),{subject:'General',subjectCode:'',updatedAt:serverTimestamp()},{merge:true}));await wb.commit();}
  if(!s.inferred)await deleteDoc(doc(db,'questionBankSubjects',code));
  await loadAll();show('Subject removed; questions General ki move ayyayi ✅');
}

function openEdit(id){
  const q=questions.find(x=>x.id===id);if(!q)return;
  $('editId').value=id;$('editQuestion').value=q.question||'';$('editA').value=optionText(q,'A');$('editB').value=optionText(q,'B');$('editC').value=optionText(q,'C');$('editD').value=optionText(q,'D');$('editAnswer').value=q.answer||'A';$('editDifficulty').value=q.difficulty||'Not Selected';$('editSubject').value=effectiveCode(q);$('editClass').value=q.className||'';$('editLesson').value=q.lesson||'';
  $('questionDialog').showModal();
}
async function saveEditedQuestion(){
  const id=$('editId').value,q=questions.find(x=>x.id===id);if(!q)return;
  const meta=getSubjectMeta($('editSubject').value);
  const updated={...q,question:clean($('editQuestion').value),options:['A','B','C','D'].map(k=>({key:k,text:clean($(`edit${k}`).value)})),answer:$('editAnswer').value,difficulty:$('editDifficulty').value,subject:meta.subject,subjectCode:meta.subjectCode,className:clean($('editClass').value),lesson:clean($('editLesson').value),updatedAt:serverTimestamp()};
  if(issuesFor(updated).length)return show('Question, 4 options and answer compulsory.','err');
  const duplicate=questions.some(x=>x.id!==id&&signature(x)===signature(updated));if(duplicate)return show('Edited question already exists.','err');
  const newId=qid(updated,meta.subjectCode||'GEN');await setDoc(doc(db,'questionBank',newId),{...updated,questionId:newId},{merge:true});if(newId!==id)await deleteDoc(doc(db,'questionBank',id));
  $('questionDialog').close();await loadAll();show('Question updated ✅');
}

function selectedGeneralIds(){return [...document.querySelectorAll('.generalCheck:checked')].map(x=>x.value)}
function openMove(ids){moveIds=[...new Set(ids)].filter(Boolean);if(!moveIds.length)return show('Questions select cheyyandi.','err');$('moveCountText').textContent=`${moveIds.length} question(s) move cheyyadaniki ready.`;$('moveSubject').value='';$('moveNewSubject').value='';$('moveNewCode').value='';$('moveClass').value='';$('moveLesson').value='';$('moveDialog').showModal();}
async function performMove(){
  let code=codeOf($('moveSubject').value),name='General';const newName=clean($('moveNewSubject').value),newCode=codeOf($('moveNewCode').value);
  if(newName||newCode){if(!newName||!newCode)return show('New subject create cheyyalante name and code rendu enter cheyyandi.','err');const existing=subjects.find(s=>s.code===newCode||norm(s.name)===norm(newName));if(existing){code=existing.code;name=existing.name}else{await saveSubject(newName,newCode);code=newCode;name=newName;}}
  else if(code){const s=subjectByCode(code);if(!s)return show('Subject select cheyyandi.','err');name=s.name;}
  const className=clean($('moveClass').value),lesson=clean($('moveLesson').value);
  for(let i=0;i<moveIds.length;i+=400){const wb=writeBatch(db);moveIds.slice(i,i+400).forEach(id=>{const q=questions.find(x=>x.id===id);if(q)wb.set(doc(db,'questionBank',id),{subject:name,subjectCode:code,className:className||q.className||'',lesson:lesson||q.lesson||'',updatedAt:serverTimestamp()},{merge:true})});await wb.commit();}
  $('moveDialog').close();const count=moveIds.length;moveIds=[];await loadAll();show(`${count} questions moved ✅`);
}
async function deleteQuestions(ids){
  ids=[...new Set(ids)].filter(Boolean);if(!ids.length)return show('Questions select cheyyandi.','err');if(!confirm(`${ids.length} question(s) permanent ga delete cheyyala?`))return;
  for(let i=0;i<ids.length;i+=400){const wb=writeBatch(db);ids.slice(i,i+400).forEach(id=>wb.delete(doc(db,'questionBank',id)));await wb.commit();}await loadAll();show(`${ids.length} questions deleted ✅`);
}

onAuthStateChanged(auth,u=>{if(!u)location.href='login.html';else loadAll().catch(e=>show(e.message,'err'))});
$('logout').onclick=()=>signOut(auth);
$('refreshBtn').onclick=()=>loadAll();
$('subjectForm').onsubmit=async e=>{e.preventDefault();try{await saveSubject($('subjectName').value,$('subjectCode').value);$('subjectName').value='';$('subjectCode').value='';await loadAll();show('Subject saved ✅')}catch(err){show(err.message,'err')}};
$('subjectCode').oninput=e=>e.target.value=codeOf(e.target.value);
$('parseBtn').onclick=()=>{const meta=getSubjectMeta($('subjectSelect').value);parsed=parseQuestions($('rawBits').value,meta.subject);if(!parsed.length)return show('Questions detect avvaledu.','err');renderPreview();show(`${parsed.length} questions ready.`)};
$('clearBtn').onclick=()=>{parsed=[];$('rawBits').value='';renderPreview()};
$('saveBtn').onclick=async()=>{const meta=getSubjectMeta($('subjectSelect').value),className=clean($('className').value),lesson=clean($('lesson').value),difficulty=$('difficulty').value||'Not Selected',existing=new Set(questions.map(signature)),local=new Set();const fresh=parsed.filter(q=>{const k=signature(q);if(existing.has(k)||local.has(k)||issuesFor(q).length)return false;local.add(k);return true});if(!fresh.length)return show('New valid questions levu.','warn');$('saveBtn').disabled=true;try{for(let i=0;i<fresh.length;i+=400){const wb=writeBatch(db);fresh.slice(i,i+400).forEach(q=>{const id=qid(q,meta.subjectCode||'GEN');wb.set(doc(db,'questionBank',id),{...q,questionId:id,subject:meta.subject,subjectCode:meta.subjectCode,className,lesson,difficulty,source:'Question Bank',createdAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:false})});await wb.commit();}parsed=[];$('rawBits').value='';renderPreview();await loadAll();show(`${fresh.length} questions saved ✅`)}catch(e){show(e.message,'err')}finally{$('saveBtn').disabled=false}};
$('generalSearch').oninput=renderGeneral;$('generalSelectAll').onclick=()=>document.querySelectorAll('.generalCheck').forEach(x=>x.checked=true);$('generalClear').onclick=()=>document.querySelectorAll('.generalCheck').forEach(x=>x.checked=false);$('generalMove').onclick=()=>openMove(selectedGeneralIds());$('generalDelete').onclick=()=>deleteQuestions(selectedGeneralIds());
$('browseSubject').onchange=()=>{selectedLesson='';page=1;renderSubjectQuestions()};$('browseSearch').oninput=()=>{page=1;renderSubjectQuestions()};$('prevPage').onclick=()=>{if(page>1){page--;renderSubjectQuestions()}};$('nextPage').onclick=()=>{page++;renderSubjectQuestions()};
if($('clearSubjectFilter')) $('clearSubjectFilter').onclick=()=>{$('browseSubject').value='';$('browseSearch').value='';selectedLesson='';page=1;renderSubjectQuestions()};
$('questionEditForm').onsubmit=e=>{e.preventDefault();saveEditedQuestion().catch(err=>show(err.message,'err'))};$('moveForm').onsubmit=e=>{e.preventDefault();performMove().catch(err=>show(err.message,'err'))};

document.querySelectorAll('.dialogClose').forEach(b=>b.onclick=()=>b.closest('dialog').close());
