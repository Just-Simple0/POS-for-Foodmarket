import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  doc,
  getDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ---------------- favicon (모든 페이지 공통 주입) ----------------
function ensureFavicon() {
  const head = document.head || document.getElementsByTagName("head")[0];
  const pngHref = window.FAVICON_HREF || "/favicon.png"; // 권장: 호스팅 루트에 favicon.png 배치
  const appleHref = window.APPLE_TOUCH_ICON_HREF || pngHref;
  // rel="icon"
  let linkIcon = document.querySelector('link[rel="icon"]');
  if (!linkIcon) {
    linkIcon = document.createElement("link");
    linkIcon.rel = "icon";
    linkIcon.type = "image/png";
    linkIcon.sizes = "512x512";
    linkIcon.href = pngHref;
    head.appendChild(linkIcon);
  } else {
    linkIcon.type = "image/png";
    linkIcon.href = pngHref;
  }
  // rel="apple-touch-icon"
  let linkApple = document.querySelector('link[rel="apple-touch-icon"]');
  if (!linkApple) {
    linkApple = document.createElement("link");
    linkApple.rel = "apple-touch-icon";
    linkApple.href = appleHref;
    head.appendChild(linkApple);
  } else {
    linkApple.href = appleHref;
  }
}

export function loadHeader(containerID = null) {
  ensureFavicon();

  const headerHTML = `
    <header>
      <div class="header-top">
        <h1 id="page-title">POS System</h1>
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
      let role = "user";
      try {
        const token = await user.getIdTokenResult(true);
        if (token?.claims?.role) {
          role = String(token.claims.role).toLowerCase();
        } else {
          // fallback: Firestore 문서(users/{uid}.role)
          const uref = doc(db, "users", user.uid);
          const usnap = await getDoc(uref);
          if (usnap.exists() && usnap.data()?.role) {
            role = String(usnap.data().role).toLowerCase();
          }
        }
      } catch (e) {
        console.warn("[header] role load failed:", e);
      }
      if (badgeEl) {
        badgeEl.style.display = role === "admin" ? "inline-block" : "none";
      }

      // ✅ 실시간 역할 변경 반영: users/{uid}.role subscribe
      try {
        onSnapshot(doc(db, "users", user.uid), async (snap) => {
          if (!snap.exists()) return;
          const r = String(snap.data()?.role || "user").toLowerCase();
          if (badgeEl)
            badgeEl.style.display = r === "admin" ? "inline-block" : "none";
          try {
            await user.getIdToken(true);
          } catch {}
        });
      } catch (e) {
        console.warn("[header] role watch failed:", e);
      }

      const logoutBtn = document.getElementById("logout-btn-header");
      if (logoutBtn) {
        logoutBtn.addEventListener("click", async () => {
          await signOut(auth);
          window.location.href = "index.html";
        });
      }
    } else {
      // nameEl.innerHTML = `
      //     <i class="fas fa-circle-user"></i> 로그인이 되지 않았습니다.`;
      // 로그인 안된 경우
      showToast("로그인이 필요합니다. 로그인 화면으로 돌아갑니다.");
      window.location.href = "index.html";
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

/**
 * ⑩ Turnstile 토큰 받기 (옵션)
 * - 전역 window.turnstile 이 로드된 경우에만 토큰을 발급받아 반환
 * - 비활성/미로드 시 null 반환 → 서버에서 off 허용 가능
 */
export async function getTurnstileToken(action = "secure_action") {
  try {
    if (typeof window === "undefined" || !window.turnstile) return null;
    // 숨김 호스트 보장
    let host = document.getElementById("cf-turnstile-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "cf-turnstile-host";
      host.style.position = "fixed";
      host.style.left = "-9999px";
      host.style.top = "-9999px";
      document.body.appendChild(host);
    }
    return await new Promise((resolve) => {
      window.turnstile.render(host, {
        sitekey: window.CF_TURNSTILE_SITEKEY || "auto",
        callback: (token) => resolve(token),
        "error-callback": () => resolve(null),
        action,
      });
    });
  } catch {
    return null;
  }
}

// 🔔 공통 토스트 메시지 함수
let toastTimeout;

export function showToast(message, isError = false) {
  let toast = document.getElementById("toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    document.body.appendChild(toast);
  }

  toast.innerHTML = message;
  toast.classList.add("show");

  if (isError) {
    toast.classList.add("error");
  } else {
    toast.classList.remove("error");
  }

  // 기존 타이머 제거 (중복 제거 핵심!)
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.remove("show");
  }, 2000);
}
