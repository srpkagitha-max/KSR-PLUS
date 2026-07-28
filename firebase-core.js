import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js';
import { getFirestore, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js';

if(!window.KSR_FIREBASE_CONFIG || window.KSR_FIREBASE_CONFIG.apiKey?.startsWith('PASTE')){
  alert('Firebase config paste cheyyali: firebase-config.js file open chesi keys replace cheyyandi.');
}
export const app = initializeApp(window.KSR_FIREBASE_CONFIG);
export const db = getFirestore(app);
export { serverTimestamp };
