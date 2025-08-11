import { auth, db } from "./components/firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

document.addEventListener("DOMContentLoaded", () => {
  const searchInput = document.getElementById("global-search");
  if (searchInput) {
    searchInput.focus();
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        document.getElementById("search-btn")?.click();
      }
    });
  }
  const nameEl = document.getElementById("user-name");
  const emailEl = document.getElementById("user-email");
  const loginEl = document.getElementById("user-last-login");
  const badgeEl = document.getElementById("admin-badge");
  const adminSection = document.getElementById("admin-settings");
  const logoutBtn = document.getElementById("logout-btn");

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      // 사용자 정보 표시
      nameEl.textContent = user.displayName || "직원";
      emailEl.textContent = user.email;
      const lastLogin = new Date(user.metadata.lastSignInTime);
      loginEl.textContent = lastLogin.toLocaleString("ko-KR");

      // Firestore에서 관리자 여부 확인
      const docRef = doc(db, "admin_users", user.email);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists() && docSnap.data().role === "admin") {
        badgeEl.style.display = "inline-block";
        adminSection.style.display = "block";
      }

      // 로그아웃 처리
      logoutBtn.addEventListener("click", async () => {
        await signOut(auth);
        window.location.href = "index.html";
      });
    } else {
      // 비로그인 시 리디렉션
      // window.location.href = "index.html";
    }
  });
});
