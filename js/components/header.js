import { auth, db } from "../firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export function loadHeader(pageTitle = "POS System") {
  const headerHTML = `
    <header>
      <div class="header-top">
        <div class="user-info">
          <i class="fas fa-circle-user"></i>
          <span id="user-name-header">직원</span>
          <span id="admin-badge" class="admin-badge" style="display: none;">
            <i class="fas fa-crown"></i> 관리자
          </span>
          <a href="mypage.html" class="small-btn" id="mypage-link">
            <i class="fas fa-user-cog"></i> 마이페이지
          </a>
          <button id="logout-btn-header" class="small-btn">
            <i class="fas fa-sign-out-alt"></i> 로그아웃
          </button>
        </div>
      </div>

      <div class="header-bottom">
        <h1 id="page-title">POS 대시보드</h1>
        <nav class="main-nav">
          <a href="products.html">상품</a>
          <a href="sales.html">수령</a>
          <a href="customers.html">고객</a>
          <a href="statistics.html">통계</a>
          <a href="dashboard.html">대시보드</a>
        </nav>
      </div>
    </header>
  `;
  document.body.insertAdjacentHTML("afterbegin", headerHTML);

  // 사용자 상태 확인 및 로그아웃 처리
  onAuthStateChanged(auth, async (user) => {
    const nameEl = document.getElementById("user-name-header");
    if (user) {
      if (nameEl) {
        const name = user.displayName || "사용자";
        const email = user.email || user.uid;
        nameEl.innerHTML = `${name} (${email})님, 환영합니다!`;
      }

      const badgeEl = document.getElementById("admin-badge");
      const docRef = doc(db, "admin_users", user.email);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists() && docSnap.data().role === "admin") {
        badgeEl.style.display = "inline-block";
      }

      const logoutBtn = document.getElementById("logout-btn-header");
      if (logoutBtn) {
        logoutBtn.addEventListener("click", async () => {
          await signOut(auth);
          window.location.href = "index.html";
        });
      }
    } else {
      nameEl.innerHTML = `로그인이 되지 않았습니다.`;
      // 로그인 안된 경우
      // alert("로그인이 필요합니다. 로그인 화면으로 돌아갑니다.");
      // window.location.href = "index.html";
    }
  });
}
