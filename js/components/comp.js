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
  getDocs,
  query,
  where,
  limit,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// 백엔드 베이스 URL (관리자 API 호출용)
const API_BASE =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://localhost:3000"
    : "https://foodmarket-pos.onrender.com";

let __adminPendingModalInFlight = false;
let __adminNotifyTimer = null;

function scheduleAdminPendingNotify(user, role) {
  if (__adminNotifyTimer) return;
  __adminNotifyTimer = setTimeout(() => {
    __adminNotifyTimer = null;
    notifyNewAccountsOnceOnLogin(user, role);
  }, 50);
}

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
    // === 관리자 요약 모달 세션 플래그 관리 ===
    // 로그아웃→재로그인 시에도 모달이 다시 뜨도록 플래그를 정리한다.
    const MODAL_UID_KEY = "admin:newAcct:uid";
    const prevUid = sessionStorage.getItem(MODAL_UID_KEY);
    if (!user) {
      // 로그아웃: 이전 사용자 플래그 제거
      if (prevUid) {
        sessionStorage.removeItem(`admin:newAcct:checked:${prevUid}`);
      }
      sessionStorage.removeItem(MODAL_UID_KEY);
    } else {
      // 같은 탭에서 페이지 이동/새로고침이면 prevUid === user.uid 이므로 플래그 보존
      // '진짜' 새 로그인(이전 페이지에서 로그아웃 후 다시 로그인) 또는 계정 전환 시에만 초기화
      if (prevUid !== user.uid) {
        if (prevUid) {
          sessionStorage.removeItem(`admin:newAcct:checked:${prevUid}`);
        }
        // 현재 UID의 checked 플래그는 지우지 않는다(페이지 이동시 재노출 방지)
        sessionStorage.setItem(MODAL_UID_KEY, user.uid);
      }
    }

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
          const isAdmin2 = r === "admin";
          if (badgeEl)
            badgeEl.style.display = isAdmin2 ? "inline-block" : "none";
          if (navAdmin)
            navAdmin.style.display = isAdmin2 ? "inline-block" : "none";
          // claims 최신화
          try {
            await user.getIdToken(true);
          } catch {}
          // 🔁 이제 admin으로 관측되면, 세션 1회 알림 재시도
          if (isAdmin2) {
            try {
              scheduleAdminPendingNotify(user, "admin");
            } catch {}
          }
        });
      } catch (e) {
        console.warn("[header] role watch failed:", e);
      }

      // 초기 진입에서도 1회 시도(디바운스 + in-flight 가드로 중복 방지)
      if (user) scheduleAdminPendingNotify(user, role);

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
 * A안 커서 기반 페이지네이터 렌더러
 * - totalCount 없이 현재까지 ‘발견된’ 페이지 범위만 숫자 버튼을 노출
 * - params:
 *   container: HTMLElement (#...pagination)
 *   state: { current:number, pagesKnown:number, hasPrev:boolean, hasNext:boolean }
 *   handlers: { goFirst:fn, goPrev:fn, goPage:(n)=>void, goNext:fn }
 *   options?: { window:number }  // 숫자버튼 표시 개수(기본 5)
 */
export function renderCursorPager(container, state, handlers, options={}) {
  if (!container) return;
  const windowSize = options.window ?? 5;
  const { current, pagesKnown, hasPrev, hasNext } = state;
  const { goFirst, goPrev, goPage, goNext } = handlers;

  // 현재 창 계산
  let start = Math.max(1, current - Math.floor(windowSize/2));
  let end = Math.min(pagesKnown, start + windowSize - 1);
  if (end - start + 1 < windowSize) start = Math.max(1, end - windowSize + 1);

  const btn = (label, disabled, dataAct, aria) =>
    `<button class="pager-btn" ${disabled ? "disabled": ""} data-act="${dataAct||""}" aria-label="${aria||label}">${label}</button>`;

  let html = '';
  html += btn('처음', !hasPrev, 'first', 'first page');
  html += btn('이전', !hasPrev, 'prev', 'previous page');
  html += `<span class="pager-pages">`;
  for (let n = start; n <= end; n++) {
    html += `<button class="pager-num ${n===current?'active':''}" data-page="${n}">${n}</button>`;
  }
  html += `</span>`;
  html += btn('다음', !hasNext, 'next', 'next page');
  // (총페이지 불명 → ‘끝’ 버튼은 생략 혹은 disable 운영을 권장)

  container.innerHTML = html;
  // 이벤트 바인딩
  container.querySelector('[data-act="first"]')?.addEventListener('click', () => goFirst?.());
  container.querySelector('[data-act="prev"]')?.addEventListener('click', () => goPrev?.());
  container.querySelectorAll('.pager-num')?.forEach(el=>{
    el.addEventListener('click', () => {
      const n = Number(el.getAttribute('data-page'));
      if (!Number.isNaN(n)) goPage?.(n);
    });
  });
  container.querySelector('[data-act="next"]')?.addEventListener('click', () => goNext?.());
}

/** 페이지 사이즈 셀렉트 공통 초기화 */
export function initPageSizeSelect(selectEl, onChange) {
  if (!selectEl) return;
  selectEl.addEventListener('change', () => {
    const v = Number(selectEl.value);
    onChange?.(Number.isFinite(v) ? v : 25);
  });
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
  overlay.className = "modal modal--admin-summary";
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

// --- 로그인 직후 1회만: 관리자 대기 요약 모달 ---
async function notifyNewAccountsOnceOnLogin(user, role) {
  try {
    if (!user) return;
    // 초기에 role 인자가 admin이 아닐 수도 있으므로, 한 번 더 claims로 보조 확인
    let isAdmin = role === "admin";
    if (!isAdmin) {
      try {
        const t = await user.getIdTokenResult();
        isAdmin = (t?.claims?.role || "").toLowerCase() === "admin";
      } catch {}
    }
    if (!isAdmin) return;
    const flagKey = `admin:newAcct:checked:${user.uid}`;
    if (sessionStorage.getItem(flagKey) === "1") return; // 세션 내 1회만
    if (__adminPendingModalInFlight) return;
    __adminPendingModalInFlight = true;
    const idToken = await user.getIdToken(true);
    // 서버 먼저 시도 → 없거나 실패하면 Firestore 폴백
    let pendingUsers = 0,
      productPending = 0,
      userPending = 0;
    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${API_BASE}/api/admin/pending-summary`, {
        headers: { Authorization: "Bearer " + idToken },
        signal: controller.signal,
      });
      clearTimeout(to);
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json();
      pendingUsers = Number(j?.pendingUsers || 0);
      productPending = Number(j?.productPending || 0);
      userPending = Number(j?.userPending || 0);
    } catch {
      const fb = await fallbackPendingSummaryFromFirestore();
      pendingUsers = fb.pendingUsers;
      productPending = fb.productPending;
      userPending = fb.userPending;
    }
    const total = pendingUsers + productPending + userPending;
    if (total > 0) {
      openAdminPendingSummaryModal({
        pendingUsers,
        productPending,
        userPending,
      });
      sessionStorage.setItem(flagKey, "1");
    }
  } finally {
    __adminPendingModalInFlight = false;
  }
}

// 관리자 대기 요약 모달
function openAdminPendingSummaryModal({
  pendingUsers = 0,
  productPending = 0,
  userPending = 0,
}) {
  const overlay = document.createElement("div");
  overlay.className = "modal modal--admin-summary";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "admin-pending-title");
  overlay.tabIndex = -1;

  const content = document.createElement("div");
  content.className = "modal-content modal--admin-summary__content";

  const hotUsers = Number(pendingUsers) > 0;
  const hotProd = Number(productPending) > 0;
  const hotCust = Number(userPending) > 0;

  content.innerHTML = `
    <h2 id="admin-pending-title">관리자 확인 필요 항목</h2>
    <div class="mas-divider"></div>
      <ul class="mas-list">
      <li class="mas-item ${hotUsers ? "is-hot" : ""}">
        ${
          hotUsers
            ? `<a class="mas-count-link" href="admin.html#pending-users" aria-label="사용자 권한 설정 대기 ${pendingUsers}건 보기">사용자 권한 설정 대기 건 - ${pendingUsers}개</a>`
            : `<span class="mas-count">${pendingUsers}개</span>`
        }
      </li>
      <li class="mas-item ${hotProd ? "is-hot" : ""}">
        ${
          hotProd
            ? `<a class="mas-count-link" href="admin.html#pending-products" aria-label="물품 등록 / 변경 / 삭제 승인 대기 ${productPending}건 보기">물품 등록 / 변경 / 삭제 대기 건 - ${productPending}개</a>`
            : `<span class="mas-text">물품 등록 / 변경 / 삭제 승인 대기 건 - </span> <span class="mas-count">${productPending}개</span>`
        }
      </li>
      <li class="mas-item ${hotCust ? "is-hot" : ""}">
        ${
          hotCust
            ? `<a class="mas-count-link" href="admin.html#pending-customers" aria-label="이용자 승인 대기 ${userPending}건 보기">이용자 승인 대기 건 - ${userPending}개</a>`
            : `<span class="mas-text">이용자 등록 / 변경 / 삭제 승인 대기 건 - </span><span class="mas-count">${userPending}개</span>`
        }
      </li>
    </ul>
    <div class="mas-buttons">
      <button type="button" class="mas-btn mas-btn-ghost" id="admin-pending-close">닫기</button>
    </div>
  `;
  overlay.appendChild(content);
  document.body.appendChild(overlay);

  const last = document.activeElement;
  content.focus();
  const cleanup = () => {
    overlay.remove();
    if (last && typeof last.focus === "function") last.focus();
  };
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) cleanup();
  });
  overlay
    .querySelector("#admin-pending-close")
    ?.addEventListener("click", cleanup);
  content.querySelectorAll(".mas-count-link").forEach((a) => {
    a.addEventListener("click", () => setTimeout(cleanup, 0));
  });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") {
      cleanup();
      document.removeEventListener("keydown", onEsc);
    }
  });
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

// ------ Firestore 폴백 집계 ------
async function fallbackPendingSummaryFromFirestore() {
  try {
    // 1) pending 사용자 수
    const usersQ = query(
      collection(db, "users"),
      where("role", "==", "pending")
    );
    const usersSnap = await getDocs(usersQ);
    const pendingUsers = usersSnap.size;

    // 2) approvals 미승인 항목 카운트(최대 500건)
    const apprQ = query(
      collection(db, "approvals"),
      where("approved", "==", false),
      limit(500)
    );
    const apprSnap = await getDocs(apprQ);
    let productPending = 0,
      userPending = 0;
    apprSnap.forEach((d) => {
      const t = String(d.data()?.type || "");
      if (t.startsWith("product_")) productPending += 1;
      else if (t.startsWith("customer_")) userPending += 1;
    });
    return { pendingUsers, productPending, userPending };
  } catch {
    return { pendingUsers: 0, productPending: 0, userPending: 0 };
  }
}
