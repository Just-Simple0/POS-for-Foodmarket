// Firebase 설정 (영구 캐시 + 멀티탭)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  memoryLocalCache,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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
// Firestore 오프라인 캐시 + 멀티탭 매니저
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
      // cacheSizeBytes: 50 * 1024 * 1024, // 필요 시 용량 조절
    }),
  });
} catch (e) {
  // Safari 시크릿 모드 등 IndexedDB 불가 환경 → 메모리 캐시로 폴백
  console.warn(
    "[Firestore] persistent cache unavailable; fallback to memory:",
    e?.message || e
  );
  db = initializeFirestore(app, { localCache: memoryLocalCache() });
}

export { app, auth, db };

// (선택) 전역도 열어두고 싶다면:
window.app = app;
window.auth = auth;
window.db = db;
