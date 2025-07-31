import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export function loadHeader(pageTitle = "POS System", containerID = null) {
  const headerHTML = `
    <header>
      <div class="header-top">
        <h1 id="page-title">${pageTitle}</h1>
        <div class="user-info">
          <span id="user-name-header">
          <i class="fas fa-circle-user"></i> 직원</span>
          <span id="admin-badge-header" class="admin-badge-header" style="display: none;">
            <i class="fas fa-crown"></i>
          </span>
          <div class="user-actions">
            <a href="mypage.html" class="small-btn" id="mypage-btn">
              <i class="fas fa-user-cog"></i> 마이페이지
            </a>
            <button id="logout-btn-header" class="small-btn">
              <i class="fas fa-sign-out-alt"></i> 로그아웃
            </button>
          </div>
        </div>
      </div>

      <div class="header-bottom">
        <nav class="main-nav">
          <a href="dashboard.html">대시보드</a>
          <a href="provision.html">제공등록</a>
          <a href="customers.html">이용자 관리</a>
          <a href="products.html">상품 관리</a>
          <a href="statistics.html">통계</a>
        </nav>
      </div>
    </header>
  `;
  const container = containerID
    ? document.getElementById(containerID)
    : document.body;
  container.insertAdjacentHTML("afterbegin", headerHTML);

  // 사용자 상태 확인 및 로그아웃 처리
  onAuthStateChanged(auth, async (user) => {
    const nameEl = document.getElementById("user-name-header");
    if (user) {
      if (nameEl) {
        const name = user.displayName || "사용자";
        const email = user.email || user.uid;
        nameEl.innerHTML = `${name} (${email})`;
      }

      const badgeEl = document.getElementById("admin-badge-header");
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
      nameEl.innerHTML = `
          <i class="fas fa-circle-user"></i> 로그인이 되지 않았습니다.`;
      // 로그인 안된 경우
      // alert("로그인이 필요합니다. 로그인 화면으로 돌아갑니다.");
      // window.location.href = "index.html";
    }
  });

  const path = window.location.pathname.split("/").pop();
  const navLinks = document.querySelectorAll("nav a");
  navLinks.forEach((link) => {
    if (link.getAttribute("href") == path) {
      link.classList.add("active");
    }
  });
}

export function loadFooter(containerID = null) {
  const footerHTML = `
    <footer>
      <div class="footer-left">&copy; 2025 POS System by JustSimple. All rights reserved.</div>
      <div class="footer-right">
        문의 : <a href="mailto:ktw021030@gmail.com">ktw021030@gmail.com</a>
      </div>
    </footer>
  `;
  const container = containerID
    ? document.getElementById(containerID)
    : document.body;
  container.insertAdjacentHTML("beforeend", footerHTML);
}
