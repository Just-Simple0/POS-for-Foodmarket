import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  doc,
  getDoc,
  collection,
  getDocs,
  query,
  where,
  limit,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

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

// ---------------- favicon ----------------
function ensureFavicon() {
  const head = document.head || document.getElementsByTagName("head")[0];
  const pngHref = window.FAVICON_HREF || "./js/components/favicon.png";
  const appleHref = window.APPLE_TOUCH_ICON_HREF || pngHref;

  let linkIcon = document.querySelector('link[rel="icon"]');
  if (!linkIcon) {
    linkIcon = document.createElement("link");
    linkIcon.rel = "icon";
    linkIcon.type = "image/png";
    linkIcon.sizes = "512x512";
    linkIcon.href = pngHref;
    head.appendChild(linkIcon);
  } else {
    linkIcon.href = pngHref;
  }

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

// ---------------- Turnstile Script ----------------
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
    setTimeout(finalize, 5000);
  });
  return turnstileReadyPromise;
}

// ---------------- Header (TDS 리팩토링) ----------------
export function loadHeader(containerID = null) {
  ensureFavicon();
  ensureTurnstileScript();

  let isDark = false;
  try {
    const saved = localStorage.getItem("theme");
    const prefers =
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    isDark = saved ? saved === "dark" : prefers;
    document.documentElement.classList.toggle("dark", isDark);
  } catch {}

  const initialIconClass = isDark ? "fa-sun" : "fa-moon";

  const headerHTML = `
    <header class="sticky top-0 z-[900] w-full bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 transition-all duration-200">
      <div class="max-w-[1920px] mx-auto px-4 sm:px-6 h-[64px] flex items-center justify-between gap-4">
        
        <div class="flex items-center gap-8 h-full">
          <a href="dashboard.html" class="flex items-center gap-1 group no-underline whitespace-nowrap shrink-0">
            <span class="text-2xl font-extrabold text-primary tracking-tighter group-hover:opacity-80 transition-opacity">POS</span>
            <span class="text-lg font-bold text-slate-800 dark:text-slate-200 tracking-tight mt-0.5">System</span>
          </a>

          <nav class="hidden md:flex items-center gap-1 h-full overflow-hidden">
            <a href="dashboard.html" class="nav-link px-3.5 py-2 rounded-xl text-[15px] font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-all no-underline whitespace-nowrap">대시보드</a>
            <a href="provision.html" class="nav-link px-3.5 py-2 rounded-xl text-[15px] font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-all no-underline whitespace-nowrap">제공등록</a>
            <a href="customers.html" class="nav-link px-3.5 py-2 rounded-xl text-[15px] font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-all no-underline whitespace-nowrap">이용자 관리</a>
            <a href="products.html" class="nav-link px-3.5 py-2 rounded-xl text-[15px] font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-all no-underline whitespace-nowrap">상품 관리</a>
            <a href="statistics.html" class="nav-link px-3.5 py-2 rounded-xl text-[15px] font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-all no-underline whitespace-nowrap">통계</a>
            <a href="admin.html" id="nav-admin" class="hidden nav-link px-3.5 py-2 rounded-xl text-[15px] font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-all no-underline whitespace-nowrap">관리자</a>
          </nav>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <div class="hidden lg:flex flex-col items-end mr-1 leading-tight">
            <span id="user-name-header" class="text-[14px] font-bold text-slate-900 dark:text-slate-100 whitespace-nowrap">사용자</span>
            <span id="admin-badge-header" class="hidden badge badge-xs badge-weak-primary uppercase tracking-wide">ADMIN</span>
          </div>

          <div class="flex items-center gap-1">
            <a href="mypage.html" class="w-9 h-9 flex items-center justify-center rounded-full text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all shrink-0" title="마이페이지"><i class="fas fa-user-cog text-lg"></i></a>
            <button id="theme-toggle" class="btn w-9 h-9 flex items-center justify-center rounded-full text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all bg-transparent cursor-pointer shrink-0" title="테마 변경"><i class="fas ${initialIconClass} text-lg"></i></button>
            <div class="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1"></div>
            <button id="logout-btn-header" class="btn btn-xs btn-light-weak font-bold whitespace-nowrap">로그아웃</button>
          </div>
        </div>
      </div>

      <div class="md:hidden border-t border-slate-100 dark:border-slate-800 overflow-x-auto no-scrollbar bg-white/50 dark:bg-slate-900/50">
        <nav class="flex px-4 py-2 gap-2 min-w-max">
          <a href="dashboard.html" class="mobile-nav-link px-3 py-1.5 rounded-lg text-sm font-bold text-slate-500 dark:text-slate-400 no-underline whitespace-nowrap">대시보드</a>
          <a href="provision.html" class="mobile-nav-link px-3 py-1.5 rounded-lg text-sm font-bold text-slate-500 dark:text-slate-400 no-underline whitespace-nowrap">제공등록</a>
          <a href="customers.html" class="mobile-nav-link px-3 py-1.5 rounded-lg text-sm font-bold text-slate-500 dark:text-slate-400 no-underline whitespace-nowrap">이용자 관리</a>
          <a href="products.html" class="mobile-nav-link px-3 py-1.5 rounded-lg text-sm font-bold text-slate-500 dark:text-slate-400 no-underline whitespace-nowrap">상품 관리</a>
          <a href="statistics.html" class="mobile-nav-link px-3 py-1.5 rounded-lg text-sm font-bold text-slate-500 dark:text-slate-400 no-underline whitespace-nowrap">통계</a>
          <a href="admin.html" id="mobile-nav-admin" class="hidden mobile-nav-link px-3 py-1.5 rounded-lg text-sm font-bold text-slate-500 dark:text-slate-400 no-underline whitespace-nowrap">관리자</a>
        </nav>
      </div>
    </header>
  `;

  const container = containerID
    ? document.getElementById(containerID)
    : document.body;
  if (containerID && container) container.outerHTML = headerHTML;
  else document.body.insertAdjacentHTML("afterbegin", headerHTML);

  const path = window.location.pathname.split("/").pop();
  const setActive = (selector) => {
    document.querySelectorAll(selector).forEach((link) => {
      if (link.getAttribute("href") === path) {
        link.classList.add(
          "text-primary",
          "dark:text-primary-400",
          "bg-primary-50",
          "dark:bg-primary-500/10"
        );
        link.classList.remove(
          "text-slate-500",
          "dark:text-slate-400",
          "hover:bg-slate-100",
          "dark:hover:bg-slate-800"
        );
      }
    });
  };
  setActive(".nav-link");
  setActive(".mobile-nav-link");

  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    const root = document.documentElement;
    const isDarkNow = root.classList.toggle("dark");
    localStorage.setItem("theme", isDarkNow ? "dark" : "light");
    const icon = document.querySelector("#theme-toggle i");
    if (icon)
      icon.className = isDarkNow ? "fas fa-sun text-lg" : "fas fa-moon text-lg";
  });

  onAuthStateChanged(auth, async (user) => {
    const MODAL_UID_KEY = "admin:newAcct:uid";
    const prevUid = sessionStorage.getItem(MODAL_UID_KEY);
    if (!user) {
      if (prevUid)
        sessionStorage.removeItem(`admin:newAcct:checked:${prevUid}`);
      sessionStorage.removeItem(MODAL_UID_KEY);
      window.location.href = "index.html";
    } else {
      if (prevUid !== user.uid) {
        if (prevUid)
          sessionStorage.removeItem(`admin:newAcct:checked:${prevUid}`);
        sessionStorage.setItem(MODAL_UID_KEY, user.uid);
      }
      const nameEl = document.getElementById("user-name-header");
      if (nameEl) {
        nameEl.textContent = user.displayName || "사용자";
        nameEl.title = user.email;
      }
      checkAdminRole(user);
      document
        .getElementById("logout-btn-header")
        ?.addEventListener("click", async () => {
          await signOut(auth);
          window.location.href = "index.html";
        });
    }
  });
}

async function checkAdminRole(user) {
  let role = "user";
  try {
    const token = await user.getIdTokenResult(true);
    role = (token?.claims?.role || "user").toLowerCase();
    if (role === "user") {
      const usnap = await getDoc(doc(db, "users", user.uid));
      if (usnap.exists()) role = (usnap.data()?.role || "user").toLowerCase();
    }
  } catch (e) {
    console.warn(e);
  }

  const isAdmin = role === "admin";
  ["admin-badge-header", "nav-admin", "mobile-nav-admin"].forEach((id) => {
    document.getElementById(id)?.classList.toggle("hidden", !isAdmin);
  });

  if (window.location.pathname.endsWith("admin.html") && !isAdmin) {
    showToast("관리자만 접근할 수 있습니다.", true);
    window.location.href = "dashboard.html";
  }
  if (isAdmin) scheduleAdminPendingNotify(user, "admin");
}

// ---------------- Footer (TDS 리팩토링) ----------------
export function loadFooter(containerID = null) {
  if (document.getElementById("app-footer")) return;
  const footerHTML = `
    <footer id="app-footer" class="mt-auto py-8 px-8 bg-white dark:bg-slate-900 border-t border-slate-100 dark:border-slate-800 text-slate-400 text-xs text-center font-medium">
      <div class="max-w-[1920px] mx-auto flex flex-col sm:flex-row justify-between items-center gap-2">
        <div>&copy; 2025 POS System by JustSimple. All rights reserved.</div>
        <div>문의 : <a href="mailto:ktw021030@gmail.com" class="text-slate-500 hover:text-primary underline">ktw021030@gmail.com</a></div>
      </div>
    </footer>
  `;
  const container = containerID
    ? document.getElementById(containerID)
    : document.body;
  container.insertAdjacentHTML("beforeend", footerHTML);
}

// ---------------- Global Loading (TDS 리팩토링) ----------------
let __loadingHost = null;
function ensureLoadingHost() {
  if (__loadingHost) return __loadingHost;
  const host = document.createElement("div");
  host.id = "app-loading";
  host.className = "loading-overlay";
  host.innerHTML = `
    <div class="loading-box">
      <div class="tds-spinner"></div>
      <div class="loading-text">데이터를 불러오고 있습니다</div>
    </div>
  `;
  document.body.appendChild(host);
  __loadingHost = host;
  return host;
}

export function showLoading(text = "데이터 불러오는 중…") {
  const host = ensureLoadingHost();
  const txt = host.querySelector(".loading-text");
  if (txt) txt.textContent = text;
  host.classList.add("is-active");
  document.body.setAttribute("data-loading", "true");
}

export function hideLoading() {
  document.getElementById("app-loading")?.classList.remove("is-active");
  document.body.removeAttribute("data-loading");
}

export async function withLoading(task, text) {
  showLoading(text);
  try {
    return await task();
  } finally {
    hideLoading();
  }
}

export function setBusy(el, busy = true) {
  if (!el) return;
  if (busy) {
    el.classList.add("opacity-70", "pointer-events-none");
    if (!el.dataset.orgText) el.dataset.orgText = el.innerHTML;
    el.innerHTML = `<div class="tds-spinner !w-4 !h-4 !border-2 mr-2"></div>${el.dataset.orgText}`;
  } else {
    el.classList.remove("opacity-70", "pointer-events-none");
    if (el.dataset.orgText) {
      el.innerHTML = el.dataset.orgText;
      delete el.dataset.orgText;
    }
  }
}

// ---------------- Skeletons (TDS 리팩토링) ----------------
export function makeSectionSkeleton(container, rows = 5) {
  if (!container) return () => {};
  if (container.tagName === "TBODY") {
    const addedRows = [];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < rows; i++) {
      const tr = document.createElement("tr");
      tr.className =
        "animate-pulse border-b border-slate-50 dark:border-slate-800 last:border-0";
      tr.innerHTML = `<td colspan="100" class="p-0"><div class="h-14 flex items-center gap-4 px-4 w-full"><div class="h-4 bg-slate-100 dark:bg-slate-700 rounded w-[10%]"></div><div class="h-4 bg-slate-100 dark:bg-slate-700 rounded flex-1"></div><div class="h-4 bg-slate-100 dark:bg-slate-700 rounded w-[15%]"></div></div></td>`;
      frag.appendChild(tr);
      addedRows.push(tr);
    }
    container.appendChild(frag);
    return () => addedRows.forEach((tr) => tr.remove());
  }
  const wrap = document.createElement("div");
  wrap.className =
    "w-full h-full z-10 bg-white/90 dark:bg-slate-900/90 backdrop-blur-[1px] flex flex-col overflow-hidden rounded-lg";
  wrap.innerHTML = `<div class="w-full flex flex-col">${Array(rows)
    .fill(
      `<div class="h-14 flex items-center gap-4 px-4 border-b border-slate-50 dark:border-slate-800"><div class="h-4 bg-slate-100 dark:bg-slate-700 rounded animate-pulse w-[10%]"></div><div class="h-4 bg-slate-100 dark:bg-slate-700 rounded animate-pulse flex-1"></div></div>`
    )
    .join("")}</div>`;
  const originalPos = container.style.position;
  if (getComputedStyle(container).position === "static")
    container.style.position = "relative";
  container.appendChild(wrap);
  return () => {
    wrap.remove();
    container.style.position = originalPos;
  };
}

export function makeGridSkeleton(container, count = 8) {
  if (!container) return () => {};
  const frag = document.createDocumentFragment();
  const addedNodes = [];
  for (let i = 0; i < count; i++) {
    const card = document.createElement("div");
    card.className = "card animate-pulse flex flex-col gap-4";
    card.innerHTML = `<div class="flex justify-between gap-2"><div class="h-6 bg-slate-100 dark:bg-slate-700 rounded w-3/5"></div><div class="h-5 bg-slate-100 dark:bg-slate-700 rounded w-12"></div></div><div class="space-y-2 mt-1"><div class="h-4 bg-slate-100 dark:bg-slate-700 rounded w-1/2"></div><div class="h-4 bg-slate-100 dark:bg-slate-700 rounded w-2/3"></div></div>`;
    frag.appendChild(card);
    addedNodes.push(card);
  }
  container.appendChild(frag);
  return () => addedNodes.forEach((node) => node.remove());
}

export function makeWidgetSkeleton(container) {
  if (!container) return () => {};
  const wrap = document.createElement("div");
  wrap.className =
    "absolute inset-0 z-10 bg-white/90 dark:bg-slate-900/90 backdrop-blur-[1px] p-6 flex flex-col gap-6 rounded-[24px] overflow-hidden";
  wrap.innerHTML = `<div class="flex items-center gap-3"><div class="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse"></div><div class="h-6 w-32 bg-slate-100 dark:bg-slate-800 rounded animate-pulse"></div></div><div class="h-32 w-full bg-slate-50 dark:bg-slate-800/50 rounded-xl animate-pulse"></div>`;
  const originalPos = getComputedStyle(container).position;
  if (originalPos === "static") container.style.position = "relative";
  container.appendChild(wrap);
  return () => {
    wrap.remove();
    if (originalPos === "static") container.style.position = "";
  };
}

// ---------------- Pager ----------------
export function renderCursorPager(container, state, handlers, options = {}) {
  if (!container) return;
  const windowSize = options.window ?? 5;
  const { current, pagesKnown, hasPrev, hasNext } = state;
  const { goFirst, goPrev, goPage, goNext, goLast } = handlers;

  let start = Math.max(1, current - Math.floor(windowSize / 2));
  let end = Math.min(pagesKnown, start + windowSize - 1);
  if (end - start + 1 < windowSize) start = Math.max(1, end - windowSize + 1);

  // [변경] 클래스 문자열 하드코딩 제거 -> 'pagination-btn' 사용
  const mkBtn = (icon, disabled, act, aria) =>
    `<button class="pagination-btn" ${
      disabled ? "disabled" : ""
    } data-act="${act}" aria-label="${aria}">${icon}</button>`;

  // 구조는 유지하되 클래스는 간결해짐
  let html = `<div class="flex items-center justify-center gap-1 w-full">`;

  html += mkBtn(
    '<i class="fas fa-angle-double-left"></i>',
    !hasPrev,
    "first",
    "처음"
  );
  html += mkBtn('<i class="fas fa-angle-left"></i>', !hasPrev, "prev", "이전");

  html += `<div class="flex gap-1">`;
  for (let n = start; n <= end; n++) {
    // [변경] 활성 상태일 때 'active' 클래스만 추가 (CSS가 알아서 스타일링함)
    const activeClass = n === current ? " active" : "";
    html += `<button class="pagination-btn${activeClass}" data-page="${n}">${n}</button>`;
  }
  html += `</div>`;

  html += mkBtn('<i class="fas fa-angle-right"></i>', !hasNext, "next", "다음");
  if (typeof goLast === "function") {
    html += mkBtn(
      '<i class="fas fa-angle-double-right"></i>',
      !hasNext,
      "last",
      "마지막"
    );
  }

  html += `</div>`;
  container.innerHTML = html;

  // 이벤트 리스너 연결 (기존 유지)
  container
    .querySelector('[data-act="first"]')
    ?.addEventListener("click", () => goFirst?.());
  container
    .querySelector('[data-act="prev"]')
    ?.addEventListener("click", () => goPrev?.());
  container
    .querySelectorAll("[data-page]")
    ?.forEach((el) =>
      el.addEventListener("click", () =>
        goPage?.(Number(el.getAttribute("data-page")))
      )
    );
  container
    .querySelector('[data-act="next"]')
    ?.addEventListener("click", () => goNext?.());
  container
    .querySelector('[data-act="last"]')
    ?.addEventListener("click", () => goLast?.());
}

export function initPageSizeSelect(selectEl, onChange) {
  if (selectEl)
    selectEl.addEventListener("change", () =>
      onChange?.(Number(selectEl.value) || 25)
    );
}

// ---------------- Turnstile / Captcha (TDS 리팩토링) ----------------
export async function getTurnstileToken(action = "secure_action") {
  try {
    const ready = await ensureTurnstileScript();
    if (!ready || !window.turnstile) return null;
    const sitekey = window.CF_TURNSTILE_SITEKEY;
    if (!sitekey || sitekey === "auto") return null;
    let host = document.getElementById("cf-turnstile-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "cf-turnstile-host";
      host.className = "fixed top-[-9999px] left-[-9999px]";
      document.body.appendChild(host);
    }
    return await new Promise((resolve) =>
      window.turnstile.render(host, {
        sitekey,
        action,
        callback: (token) => resolve(token),
        "error-callback": () => resolve(null),
      })
    );
  } catch {
    return null;
  }
}

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

  // [추가] 현재 시스템이 다크모드인지 확인
  const isDarkMode = document.documentElement.classList.contains("dark");
  const turnstileTheme = isDarkMode ? "dark" : "light";

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay z-[2000]";
  overlay.innerHTML = `
    <div class="modal-content max-w-sm text-center">
      <div class="p-8 pb-0 text-center"><h4 class="text-[20px] font-bold text-slate-900 dark:text-white leading-tight">${title}</h4></div>
      <div class="p-8 text-center text-[15px] text-slate-600 dark:text-slate-400 leading-relaxed">
        ${subtitle}
        <div id="cf-turnstile-slot" class="flex justify-center my-4 min-h-[65px]"></div>
      </div>
      <div class="p-6 pt-0 flex gap-3">
        <button type="button" id="cf-cancel" class="btn btn-md btn-light flex-1 !rounded-2xl">취소</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  return await new Promise((resolve) => {
    let widgetId = null;
    const cleanup = (val) => {
      if (widgetId)
        try {
          window.turnstile.remove(widgetId);
        } catch {}
      overlay.remove();
      resolve(val);
    };

    overlay
      .querySelector("#cf-cancel")
      .addEventListener("click", () => cleanup(null));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup(null);
    });

    try {
      widgetId = window.turnstile.render(
        overlay.querySelector("#cf-turnstile-slot"),
        {
          sitekey,
          action,
          theme: turnstileTheme, // [수정] 테마에 따라 'dark' 또는 'light' 적용
          callback: (t) => cleanup(t),
          "error-callback": () => cleanup(null),
        }
      );
    } catch {
      cleanup(null);
    }
  });
}

// ---------------- Toast (Stacked TDS) ----------------
export function showToast(message, isError = false) {
  let container = document.getElementById("tds-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "tds-toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = `toast-panel ${isError ? "toast-error" : "toast-success"}`;
  toast.innerHTML = `<i class="fas ${
    isError ? "fa-circle-exclamation" : "fa-check-circle"
  }"></i><span>${message}</span>`;
  container.prepend(toast);
  setTimeout(() => {
    toast.classList.add("toast-out");
    setTimeout(() => {
      toast.remove();
      if (container.children.length === 0) container.remove();
    }, 450);
  }, 3500);
}

// ---------------- Modals (TDS 리팩토링) ----------------
function createModalBase(title, contentHTML, footerHTML) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal-content"><div class="p-8 pb-0 text-center"><h4 class="text-[20px] font-bold text-slate-900 dark:text-white leading-tight">${title}</h4></div><div class="p-8 text-center text-[15px] text-slate-600 dark:text-slate-400 leading-relaxed">${contentHTML}</div><div class="p-6 pt-0 flex gap-3">${footerHTML}</div></div>`;
  return overlay;
}

export function openConfirm(opts = {}) {
  const {
    title = "확인",
    message = "",
    variant = "info",
    confirmText = "확인",
    cancelText = "취소",
  } = opts;
  const confirmBtnClass = variant === "danger" ? "btn-danger" : "btn-primary";

  // [수정] btn-light-weak -> btn-light
  const footer = `
    <button type="button" class="btn btn-md btn-light flex-1 !rounded-2xl" data-act="cancel">${cancelText}</button>
    <button type="button" class="btn btn-md ${confirmBtnClass} flex-1 !rounded-2xl" data-act="confirm">${confirmText}</button>
  `;

  const overlay = createModalBase(title, message, footer);
  document.body.appendChild(overlay);
  return new Promise((resolve) => {
    const cleanup = (val) => {
      overlay.remove();
      resolve(val);
    };
    overlay.addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "confirm") cleanup(true);
      else if (act === "cancel" || e.target === overlay) cleanup(false);
    });
  });
}

export function openAlert(opts = {}) {
  const { title = "알림", message = "", confirmText = "확인" } = opts;
  const footer = `<button type="button" class="btn btn-md btn-primary flex-1 !rounded-2xl" data-act="confirm">${confirmText}</button>`;
  const overlay = createModalBase(title, message, footer);
  document.body.appendChild(overlay);
  return new Promise((resolve) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.closest('[data-act="confirm"]')) {
        overlay.remove();
        resolve();
      }
    });
  });
}

/**
 * 요소를 부드럽게 나타내거나 사라지게 하는 유틸리티
 * @param {HTMLElement} el - 대상 요소
 * @param {boolean} show - true(보임), false(숨김)
 */
export function toggleFade(el, show) {
  if (!el) return;

  if (show) {
    // 1. 나타나기: hidden을 즉시 제거하고 애니메이션 시작
    el.classList.remove("hidden");
    el.classList.remove("animate-fade-out");
    el.classList.add("animate-fade-in");
  } else {
    // 2. 사라지기: 이미 숨겨져 있다면 중단
    if (el.classList.contains("hidden")) return;

    // 이미 사라지는 중이라면 중복 실행 방지
    if (el.classList.contains("animate-fade-out")) return;

    el.classList.remove("animate-fade-in");
    el.classList.add("animate-fade-out");

    // [핵심] CSS 애니메이션 시간(0.2s)만큼 기다린 뒤에 hidden 적용
    setTimeout(() => {
      // 기다리는 동안 다시 show 명령이 들어오지 않았는지 확인
      if (el.classList.contains("animate-fade-out")) {
        el.classList.add("hidden");
        el.classList.remove("animate-fade-out");
      }
    }, 190); // 200ms보다 살짝 짧게 잡아 깜빡임 방지
  }
}

// ---------------- Admin Summary Modal (TDS 리팩토링) ----------------
export function openAdminPendingSummaryModal({
  pendingUsers = 0,
  productPending = 0,
  userPending = 0,
}) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const itemClass =
    "flex justify-between items-center py-3 border-b border-slate-100 dark:border-slate-800 last:border-0";
  const hotClass = "text-danger font-bold hover:underline";

  const content = `
    <div class="flex flex-col mb-2">
      <div class="${itemClass}"><span>사용자 권한 대기</span>${
    pendingUsers > 0
      ? `<a href="admin.html#pending-users" class="${hotClass}">${pendingUsers}건</a>`
      : `<span class="text-slate-400">0건</span>`
  }</div>
      <div class="${itemClass}"><span>물품 승인 대기</span>${
    productPending > 0
      ? `<a href="admin.html#pending-products" class="${hotClass}">${productPending}건</a>`
      : `<span class="text-slate-400">0건</span>`
  }</div>
      <div class="${itemClass}"><span>이용자 승인 대기</span>${
    userPending > 0
      ? `<a href="admin.html#pending-customers" class="${hotClass}">${userPending}건</a>`
      : `<span class="text-slate-400">0건</span>`
  }</div>
    </div>
  `;
  const footer = `<button id="admin-pending-close" class="btn btn-md btn-light flex-1 !rounded-2xl">닫기</button>`;

  const modal = createModalBase("관리자 확인 필요", content, footer);
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector("#admin-pending-close").addEventListener("click", close);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) close();
  });
}

async function notifyNewAccountsOnceOnLogin(user, role) {
  try {
    if (!user) return;
    let isAdmin = role === "admin";
    if (!isAdmin) {
      try {
        const t = await user.getIdTokenResult();
        isAdmin = (t?.claims?.role || "").toLowerCase() === "admin";
      } catch {}
    }
    if (!isAdmin) return;
    const flagKey = `admin:newAcct:checked:${user.uid}`;
    if (sessionStorage.getItem(flagKey) === "1") return;
    if (__adminPendingModalInFlight) return;
    __adminPendingModalInFlight = true;

    const fb = await fallbackPendingSummaryFromFirestore();
    if (fb.pendingUsers + fb.productPending + fb.userPending > 0) {
      openAdminPendingSummaryModal(fb);
      sessionStorage.setItem(flagKey, "1");
    }
  } finally {
    __adminPendingModalInFlight = false;
  }
}

async function fallbackPendingSummaryFromFirestore() {
  try {
    const usersSnap = await getDocs(
      query(collection(db, "users"), where("role", "==", "pending"))
    );
    const apprSnap = await getDocs(
      query(
        collection(db, "approvals"),
        where("approved", "==", false),
        limit(500)
      )
    );
    let pP = 0,
      uP = 0;
    apprSnap.forEach((d) => {
      const t = String(d.data()?.type || "");
      if (t.startsWith("product_")) pP++;
      else if (t.startsWith("customer_")) uP++;
    });
    return {
      pendingUsers: usersSnap.size,
      productPending: pP,
      userPending: uP,
    };
  } catch {
    return { pendingUsers: 0, productPending: 0, userPending: 0 };
  }
}
