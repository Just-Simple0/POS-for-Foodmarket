// Firebase 설정 스크립트
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAvou07fLgV405Pa-nkbBoGAksD9gx1ukI",
  authDomain: "pos-for-foodmarket.firebaseapp.com",
  projectId: "pos-for-foodmarket",
  storageBucket: "pos-for-foodmarket.firebasestorage.app",
  messagingSenderId: "112378757029",
  appId: "1:112378757029:web:277e3918a6f62485f1324c",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };
