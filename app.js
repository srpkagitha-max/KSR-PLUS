import './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js';
import { getFirestore, doc, setDoc, getDoc, addDoc, collection, getDocs, query, where, orderBy, serverTimestamp, updateDoc, deleteDoc, writeBatch, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js';

const cfg = window.KSR_FIREBASE_CONFIG;
if(!cfg || !cfg.apiKey){ alert('Firebase config missing. Please upload firebase-config.js correctly.'); }
export const app = initializeApp(cfg);
export const auth = getAuth(app);
export const db = getFirestore(app);
export { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, doc, setDoc, getDoc, addDoc, collection, getDocs, query, where, orderBy, serverTimestamp, updateDoc, deleteDoc, writeBatch, onSnapshot };
export function $(id){return document.getElementById(id)}
export function show(msg,type='ok'){const m=$('msg'); if(m){m.className='msg '+(type==='err'?'err':type==='warn'?'warn':'ok');m.textContent=msg;}}
export function esc(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
