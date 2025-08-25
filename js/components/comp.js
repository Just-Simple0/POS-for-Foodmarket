import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  doc,
  getDoc,
  onSnapshot,
  collection,
  query,
  orderBy,
  limit,
  getDocs,
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

// ---------------- Turnstile: 스크립트 자동 로드 + 준비 보장 ----------------
let turnstileReadyPromise = null;
async function ensureTurnstileScript() {
  if (typeof window === "undefined") return false;
  if (window.turnstile) return true;
  if (turnstileReadyPromise) return turnstileReadyPromise;
  turnstileReadyPromise = new Promise((resolve) => {
    const finalize = () => resolve(!!window.turnstile);
    const existing = document.querySelector("script[data-turnstile]");
    if (!existing) {
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
      s.async = true;
      s.defer = true;
      s.setAttribute("data-turnstile", "");
      s.onload = finalize;
      s.onerror = () => resolve(false);
      (document.head || document.documentElement).appendChild(s);
    } else {
      if (window.turnstile) resolve(true);
      else existing.addEventListener("load", finalize, { once: true });
    }
    // 5초 타임아웃(네트워크 문제 대비)
    setTimeout(finalize, 5000);
  });
  return turnstileReadyPromise;
}

export function loadHeader(containerID = null) {
  ensureFavicon();
  ensureTurnstileScript();

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
          <a href="admin.html" id="nav-admin" style="display: none">관리자</a>
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
      const navAdmin = document.getElementById("nav-admin");

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

      const isAdmin = role === "admin";
      if (badgeEl) badgeEl.style.display = isAdmin ? "inline-block" : "none";
      if (navAdmin) navAdmin.style.display = isAdmin ? "inline-block" : "none";
      // 페이지 가드: admin.html에 접근했는데 admin이 아니면 대시보드로
      try {
        const path = (
          window.location.pathname.split("/").pop() || ""
        ).toLowerCase();
        if (path === "admin.html" && !isAdmin) {
          showToast("관리자만 접근할 수 있습니다.", true);
          window.location.href = "dashboard.html";
        }
      } catch {}

      // ✅ 실시간 역할 변경 반영: users/{uid}.role subscribe
      try {
        onSnapshot(doc(db, "users", user.uid), async (snap) => {
          if (!snap.exists()) return;
          const r = String(snap.data()?.role || "user").toLowerCase();
          if (badgeEl)
            badgeEl.style.display = r === "admin" ? "inline-block" : "none";
          const isAdmin2 = r === "admin";
          if (badgeEl)
            badgeEl.style.display = isAdmin2 ? "inline-block" : "none";
          if (navAdmin)
            navAdmin.style.display = isAdmin2 ? "inline-block" : "none";
          try {
            await user.getIdToken(true);
          } catch {}
        });
      } catch (e) {
        console.warn("[header] role watch failed:", e);
      }

      notifyNewAccountsOnceOnLogin(user, role);

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
 * Turnstile 모달을 띄워 토큰을 받는다(보이는 위젯).
 * @param {{action?: string, title?: string, subtitle?: string}} opts
 * @returns {Promise<string|null>}
 */
export async function openCaptchaModal(opts = {}) {
  const {
    action = "secure_action",
    title = "보안 확인",
    subtitle = "봇이 아님을 확인해 주세요.",
  } = opts;
  const ready = await ensureTurnstileScript();
  if (!ready || !window.turnstile) return null;
  const sitekey = window.CF_TURNSTILE_SITEKEY;
  if (!sitekey || sitekey === "auto") return null;

  const theme = opts.theme || window.CF_TURNSTILE_THEME || "light"; // "light" | "dark" | "auto"
  const size = opts.size || window.CF_TURNSTILE_SIZE || "normal"; // "normal" | "compact"
  const appearance =
    opts.appearance || window.CF_TURNSTILE_APPEARANCE || "always"; // "always" | "interaction-only"

  const overlay = document.createElement("div");
  overlay.id = "cf-turnstile-modal";
  overlay.className = "modal";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("tabindex", "-1");

  const content = document.createElement("div");
  content.className = "modal-content captcha-modal";
  content.innerHTML = `
    <h2>${title}</h2>
    <p class="hint">${subtitle}</p>
    <div id="cf-turnstile-slot" style="display:flex;justify-content:center;margin:12px 0;"></div>
    <div class="modal-buttons" style="justify-content:flex-end">
      <button type="button" id="cf-cancel" class="btn btn-ghost" aria-label="취소">취소</button>
    </div>
  `;
  overlay.appendChild(content);
  document.body.appendChild(overlay);

  const lastFocus = document.activeElement;
  content.focus();
  const escHandler = (e) => {
    if (e.key === "Escape") cleanup(null);
  };
  document.addEventListener("keydown", escHandler);

  return await new Promise((resolve) => {
    let widgetId = null;
    const slot = content.querySelector("#cf-turnstile-slot");
    const cancelBtn = content.querySelector("#cf-cancel");
    cancelBtn.addEventListener("click", () => cleanup(null));
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) cleanup(null);
    });
    function cleanup(val) {
      try {
        if (widgetId != null) window.turnstile.remove(widgetId);
      } catch {}
      document.removeEventListener("keydown", escHandler);
      overlay.remove();
      if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
      resolve(val);
    }

    try {
      widgetId = window.turnstile.render(slot, {
        sitekey,
        action,
        theme,
        size,
        appearance,
        callback: (token) => cleanup(token),
        "error-callback": () => cleanup(null),
      });
    } catch {
      cleanup(null);
    }
  });
}

// --- 로그인 직후 1회만 새 계정 안내 ---
async function notifyNewAccountsOnceOnLogin(user, role) {
  try {
    if (!user || role !== "admin") return;
    const flagKey = `admin:newAcct:checked:${user.uid}`;
    if (sessionStorage.getItem(flagKey) === "1") return; // 세션 내 1회만
    sessionStorage.setItem(flagKey, "1");
    // 직전 확인 시각(로컬 저장소) — 서버 과금 없음
    const lastKey = `admin:newAcct:lastAt:${user.uid}`;
    const lastAt = Number(localStorage.getItem(lastKey) || 0);

    // 서버 API로 조회(보안 규칙상 client list 금지 → Turnstile 필요)
    const API_BASE =
      location.hostname === "localhost" || location.hostname === "127.0.0.1"
        ? "http://localhost:3000"
        : "https://foodmarket-pos.onrender.com";
    // 토큰 준비
    const idToken = await user.getIdToken(true);
    const ts = await getTurnstileToken("admin_notify");
    const res = await fetch(
      `${API_BASE}/api/admin/new-users-count?since=${encodeURIComponent(
        String(lastAt || 0)
      )}`,
      {
        headers: {
          Authorization: "Bearer " + idToken,
          "x-cf-turnstile-token": ts || "",
        },
      }
    );
    let count = 0;
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      if (j && j.ok) count = Number(j.count || 0);
    } else {
      // 조용히 스킵 (알림 실패는 치명적이지 않음)
      // console.warn("new-users-count failed", await res.text());
    }
    if (count > 0) {
      showToast(
        `새로운 계정 ${count}건이 생성되었습니다. 권한을 설정해주세요.`
      );
    }
    localStorage.setItem(lastKey, String(Date.now()));
  } catch (e) {
    // 알림 실패는 치명적 아님 — 무시
  }
}

/**
 * ⑩ Turnstile 토큰 받기 (옵션)
 * - 전역 window.turnstile 이 로드된 경우에만 토큰을 발급받아 반환
 * - 비활성/미로드 시 null 반환 → 서버에서 off 허용 가능
 */
export async function getTurnstileToken(action = "secure_action") {
  try {
    // 스크립트 준비 보장
    const ready = await ensureTurnstileScript();
    if (!ready || !window.turnstile) return null;
    // ⚠️ sitekey는 반드시 head 등에서 주입되어 있어야 함
    const sitekey = window.CF_TURNSTILE_SITEKEY;
    if (!sitekey || sitekey === "auto") {
      console.warn(
        "[Turnstile] window.CF_TURNSTILE_SITEKEY is missing/invalid"
      );
      return null;
    } // 숨김 호스트 보장
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
        sitekey,
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
