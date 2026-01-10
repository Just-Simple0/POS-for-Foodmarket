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
  const pngHref = window.FAVICON_HREF || "/favicon.png";
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

// ---------------- Header (Dark Mode Supported) ----------------
export function loadHeader(containerID = null) {
  ensureFavicon();
  ensureTurnstileScript();

  // 테마 초기화
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

  // [수정] 다크모드 배경색 및 텍스트 색상 적용
  const headerHTML = `
    <header class="sticky top-0 z-[900] w-full bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 transition-all duration-200 supports-[backdrop-filter]:bg-white/60">
      <div class="max-w-[1920px] mx-auto px-4 sm:px-6 h-[64px] flex items-center justify-between">
        
        <div class="flex items-center gap-8 h-full">
          <a href="dashboard.html" class="flex items-center gap-1 group no-underline whitespace-nowrap">
            <span class="text-2xl font-extrabold text-[#3182f6] dark:text-blue-500 tracking-tighter group-hover:opacity-80 transition-opacity">POS</span>
            <span class="text-lg font-bold text-slate-700 dark:text-slate-200 tracking-tight group-hover:text-slate-900 dark:group-hover:text-white transition-colors mt-0.5">System</span>
          </a>

          <nav class="hidden md:flex items-center gap-1 h-full">
            <a href="dashboard.html" class="nav-link px-3.5 py-2 rounded-[10px] text-[15px] font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-all no-underline whitespace-nowrap overflow-hidden">대시보드</a>
            <a href="provision.html" class="nav-link px-3.5 py-2 rounded-[10px] text-[15px] font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-all no-underline whitespace-nowrap overflow-hidden">제공등록</a>
            <a href="customers.html" class="nav-link px-3.5 py-2 rounded-[10px] text-[15px] font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-all no-underline whitespace-nowrap overflow-hidden">이용자 관리</a>
            <a href="products.html" class="nav-link px-3.5 py-2 rounded-[10px] text-[15px] font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-all no-underline whitespace-nowrap overflow-hidden">상품 관리</a>
            <a href="statistics.html" class="nav-link px-3.5 py-2 rounded-[10px] text-[15px] font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-all no-underline whitespace-nowrap overflow-hidden">통계</a>
            <a href="admin.html" id="nav-admin" class="hidden nav-link px-3.5 py-2 rounded-[10px] text-[15px] font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-all no-underline whitespace-nowrap overflow-hidden">관리자</a>
          </nav>
        </div>

        <div class="flex items-center gap-3">
          <div class="hidden lg:flex flex-col items-end leading-none mr-1">
            <span id="user-name-header" class="text-[14px] font-bold text-slate-800 dark:text-slate-200 mb-0.5 whitespace-nowrap overflow-hidden">사용자</span>
            <span id="admin-badge-header" class="hidden text-[10px] font-bold text-[#3182f6] dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30 px-1.5 py-0.5 rounded uppercase tracking-wide">ADMIN</span>
          </div>

          <div class="flex items-center gap-1.5">
            <a href="mypage.html" class="w-9 h-9 flex items-center justify-center rounded-full text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-all" title="마이페이지">
              <i class="fas fa-user-cog text-lg"></i>
            </a>
            <button id="theme-toggle" class="w-9 h-9 flex items-center justify-center rounded-full text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100 transition-all border-none bg-transparent cursor-pointer" title="테마 변경">
              <i class="fas ${initialIconClass} text-lg"></i>
            </button>
            <div class="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1"></div>
            <button id="logout-btn-header" class="btn btn-dark-weak text-sm font-bold whitespace-nowrap overflow-hidden">
              로그아웃
            </button>
          </div>
        </div>

      </div>
      
      <div class="md:hidden border-t border-slate-100 dark:border-slate-800 overflow-x-auto no-scrollbar">
        <nav class="flex px-4 py-2 gap-2 min-w-max">
          <a href="dashboard.html" class="mobile-nav-link px-3 py-1.5 rounded-lg text-sm font-semibold text-slate-500 dark:text-slate-400 whitespace-nowrap no-underline">대시보드</a>
          <a href="provision.html" class="mobile-nav-link px-3 py-1.5 rounded-lg text-sm font-semibold text-slate-500 dark:text-slate-400 whitespace-nowrap no-underline">제공등록</a>
          <a href="customers.html" class="mobile-nav-link px-3 py-1.5 rounded-lg text-sm font-semibold text-slate-500 dark:text-slate-400 whitespace-nowrap no-underline">이용자 관리</a>
          <a href="products.html" class="mobile-nav-link px-3 py-1.5 rounded-lg text-sm font-semibold text-slate-500 dark:text-slate-400 whitespace-nowrap no-underline">상품 관리</a>
          <a href="statistics.html" class="mobile-nav-link px-3 py-1.5 rounded-lg text-sm font-semibold text-slate-500 dark:text-slate-400 whitespace-nowrap no-underline">통계</a>
          <a href="admin.html" id="mobile-nav-admin" class="hidden mobile-nav-link px-3 py-1.5 rounded-lg text-sm font-semibold text-slate-500 dark:text-slate-400 whitespace-nowrap no-underline">관리자</a>
        </nav>
      </div>
    </header>
  `;

  const container = containerID
    ? document.getElementById(containerID)
    : document.body;
  if (containerID && container) {
    container.outerHTML = headerHTML;
  } else {
    document.body.insertAdjacentHTML("afterbegin", headerHTML);
  }

  // Active Link
  const path = window.location.pathname.split("/").pop();
  const setActive = (selector) => {
    document.querySelectorAll(selector).forEach((link) => {
      if (link.getAttribute("href") === path) {
        // [수정] Active 스타일 다크모드 대응
        link.classList.add(
          "text-[#3182f6]",
          "dark:text-blue-400",
          "bg-blue-50",
          "dark:bg-blue-900/20"
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

  const themeBtn = document.getElementById("theme-toggle");
  themeBtn?.addEventListener("click", () => {
    const root = document.documentElement;
    const isDarkMode = root.classList.contains("dark");
    const nextDark = !isDarkMode;
    root.classList.toggle("dark", nextDark);
    try {
      localStorage.setItem("theme", nextDark ? "dark" : "light");
    } catch {}

    const icon = themeBtn.querySelector("i");
    if (icon) {
      icon.className = nextDark ? "fas fa-sun text-lg" : "fas fa-moon text-lg";
    }
  });

  onAuthStateChanged(auth, async (user) => {
    const MODAL_UID_KEY = "admin:newAcct:uid";
    const prevUid = sessionStorage.getItem(MODAL_UID_KEY);
    if (!user) {
      if (prevUid)
        sessionStorage.removeItem(`admin:newAcct:checked:${prevUid}`);
      sessionStorage.removeItem(MODAL_UID_KEY);
    } else {
      if (prevUid !== user.uid) {
        if (prevUid)
          sessionStorage.removeItem(`admin:newAcct:checked:${prevUid}`);
        sessionStorage.setItem(MODAL_UID_KEY, user.uid);
      }
    }

    const nameEl = document.getElementById("user-name-header");
    if (user) {
      if (nameEl) {
        const name = user.displayName || "사용자";
        nameEl.textContent = name;
        nameEl.title = user.email;
      }
      checkAdminRole(user);
      document
        .getElementById("logout-btn-header")
        ?.addEventListener("click", async () => {
          await signOut(auth);
          window.location.href = "index.html";
        });
    } else {
      showToast("로그인이 필요합니다.");
      window.location.href = "index.html";
    }
  });
}

async function checkAdminRole(user) {
  let role = "user";
  try {
    const token = await user.getIdTokenResult(true);
    role = token?.claims?.role || "user";
    if (role === "user") {
      const usnap = await getDoc(doc(db, "users", user.uid));
      if (usnap.exists()) role = usnap.data()?.role || "user";
    }
  } catch (e) {
    console.warn(e);
  }

  const isAdmin = String(role).toLowerCase() === "admin";
  const badge = document.getElementById("admin-badge-header");
  const nav = document.getElementById("nav-admin");
  const mobileNav = document.getElementById("mobile-nav-admin");

  if (badge) badge.classList.toggle("hidden", !isAdmin);
  if (nav) nav.classList.toggle("hidden", !isAdmin);
  if (mobileNav) mobileNav.classList.toggle("hidden", !isAdmin);

  const path = window.location.pathname.split("/").pop();
  if (path === "admin.html" && !isAdmin) {
    showToast("관리자만 접근할 수 있습니다.", true);
    window.location.href = "dashboard.html";
  }

  if (isAdmin) scheduleAdminPendingNotify(user, "admin");
}

// ---------------- Footer (Dark Mode Supported) ----------------
export function loadFooter(containerID = null) {
  if (document.getElementById("app-footer")) return;

  // [수정] 다크모드 색상 적용
  const footerHTML = `
    <footer id="app-footer" class="mt-auto py-6 px-8 bg-slate-800 dark:bg-slate-950 border-t border-slate-700 dark:border-slate-800 text-slate-400 dark:text-slate-500 text-xs">
      <div class="max-w-[1920px] mx-auto flex flex-col sm:flex-row justify-between items-center gap-2">
        <div>&copy; 2025 POS System by JustSimple. All rights reserved.</div>
        <div class="flex items-center gap-1">
          문의 : <a href="mailto:ktw021030@gmail.com" class="text-slate-300 dark:text-slate-400 hover:text-white dark:hover:text-slate-200 underline transition-colors">ktw021030@gmail.com</a>
        </div>
      </div>
    </footer>
  `;
  const container = containerID
    ? document.getElementById(containerID)
    : document.body;
  container.insertAdjacentHTML("beforeend", footerHTML);
}

// ---------------- Global Loading (Refactored) ----------------
let __loadingHost = null;
function ensureLoadingHost() {
  if (__loadingHost) return __loadingHost;
  const host = document.createElement("div");
  host.id = "app-loading";
  host.setAttribute("aria-hidden", "true");
  host.className = "loading-overlay !z-[2500]"; // tw-input.css 사용

  host.innerHTML = `
    <div class="loading-box">
      <i class="fas fa-circle-notch fa-spin text-3xl text-blue-600 dark:text-blue-500"></i>
      <div class="al-text font-bold text-slate-800 dark:text-white text-base">데이터 불러오는 중…</div>
    </div>
  `;
  document.body.appendChild(host);
  __loadingHost = host;
  return host;
}

export function showLoading(text = "데이터 불러오는 중…") {
  const host = ensureLoadingHost();
  const txt = host.querySelector(".al-text");
  if (txt) txt.textContent = text;
  host.classList.add("is-active");
  document.body.setAttribute("data-loading", "true");
}

export function hideLoading() {
  const host = ensureLoadingHost();
  host.classList.remove("is-active");
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
    el.classList.add("opacity-70", "cursor-wait", "pointer-events-none");
    if (!el.dataset.orgText) el.dataset.orgText = el.innerHTML;
    if (!el.querySelector(".fa-spin")) {
      el.innerHTML = `<i class="fas fa-circle-notch fa-spin mr-2"></i>${el.innerHTML}`;
    }
  } else {
    el.classList.remove("opacity-70", "cursor-wait", "pointer-events-none");
    if (el.dataset.orgText) {
      el.innerHTML = el.dataset.orgText;
      delete el.dataset.orgText;
    }
  }
}

// ---------------- Skeleton (Dark Mode) ----------------
export function makeSectionSkeleton(container, rows = 5) {
  if (!container) return () => {};

  const wrap = document.createElement("div");
  // [수정] 다크모드 대응
  wrap.className =
    "absolute inset-0 z-10 bg-white/90 dark:bg-slate-900/90 backdrop-blur-[1px] flex flex-col overflow-hidden rounded-lg";

  let html = `<div class="w-full h-full flex flex-col">`;
  for (let i = 0; i < rows; i++) {
    html += `
      <div class="flex-1 flex items-center gap-4 px-4 border-b border-slate-50 dark:border-slate-800 last:border-0">
        <div class="h-4 bg-slate-100 dark:bg-slate-700 rounded animate-pulse w-[10%]"></div>
        <div class="h-4 bg-slate-100 dark:bg-slate-700 rounded animate-pulse flex-1"></div>
        <div class="h-4 bg-slate-100 dark:bg-slate-700 rounded animate-pulse w-[15%]"></div>
        <div class="h-4 bg-slate-100 dark:bg-slate-700 rounded animate-pulse w-[10%]"></div>
        <div class="h-4 bg-slate-100 dark:bg-slate-700 rounded animate-pulse w-[10%]"></div>
      </div>
    `;
  }
  html += `</div>`;
  wrap.innerHTML = html;

  const originalPos = container.style.position;
  if (getComputedStyle(container).position === "static")
    container.style.position = "relative";
  container.appendChild(wrap);

  return () => {
    wrap.remove();
    container.style.position = originalPos;
  };
}

// ---------------- Cursor Pager (Refactored) ----------------
export function renderCursorPager(container, state, handlers, options = {}) {
  if (!container) return;
  const windowSize = options.window ?? 5;
  const { current, pagesKnown, hasPrev, hasNext } = state;
  const { goFirst, goPrev, goPage, goNext, goLast } = handlers;

  let start = Math.max(1, current - Math.floor(windowSize / 2));
  let end = Math.min(pagesKnown, start + windowSize - 1);
  if (end - start + 1 < windowSize) start = Math.max(1, end - windowSize + 1);

  const mkBtn = (icon, disabled, act, aria) =>
    `<button class="btn btn-light min-w-[36px] px-2" ${
      disabled ? "disabled" : ""
    } data-act="${act}" aria-label="${aria}">${icon}</button>`;

  let html = `<div class="pager-wrap flex items-center justify-center gap-1.5 flex-wrap mt-6">`;
  html += mkBtn(
    '<i class="fas fa-angle-double-left"></i>',
    !hasPrev,
    "first",
    "처음"
  );
  html += mkBtn('<i class="fas fa-angle-left"></i>', !hasPrev, "prev", "이전");
  html += `<div class="flex gap-1 px-1">`;
  for (let n = start; n <= end; n++) {
    const cls =
      n === current
        ? "btn btn-primary min-w-[36px]"
        : "btn btn-dark-weak min-w-[36px]";
    html += `<button class="${cls}" data-page="${n}">${n}</button>`;
  }
  html += `</div>`;
  html += mkBtn('<i class="fas fa-angle-right"></i>', !hasNext, "next", "다음");
  if (typeof goLast === "function")
    html += mkBtn(
      '<i class="fas fa-angle-double-right"></i>',
      !hasNext,
      "last",
      "마지막"
    );
  html += `</div>`;

  container.innerHTML = html;
  container
    .querySelector('[data-act="first"]')
    ?.addEventListener("click", () => goFirst?.());
  container
    .querySelector('[data-act="prev"]')
    ?.addEventListener("click", () => goPrev?.());
  container.querySelectorAll("[data-page]")?.forEach((el) => {
    el.addEventListener("click", () => {
      const n = Number(el.getAttribute("data-page"));
      if (!Number.isNaN(n)) goPage?.(n);
    });
  });
  container
    .querySelector('[data-act="next"]')
    ?.addEventListener("click", () => goNext?.());
  container
    .querySelector('[data-act="last"]')
    ?.addEventListener("click", () => goLast?.());
}

export function initPageSizeSelect(selectEl, onChange) {
  if (!selectEl) return;
  selectEl.addEventListener("change", () => {
    const v = Number(selectEl.value);
    onChange?.(Number.isFinite(v) ? v : 25);
  });
}

// ---------------- Turnstile / Captcha ----------------
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
    return await new Promise((resolve) => {
      window.turnstile.render(host, {
        sitekey,
        action,
        callback: (token) => resolve(token),
        "error-callback": () => resolve(null),
      });
    });
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

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay z-[2000]";
  overlay.innerHTML = `
    <div class="modal-panel max-w-sm text-center">
      <h3 class="text-lg font-bold text-slate-800 dark:text-white">${title}</h3>
      <p class="text-sm text-slate-500 dark:text-slate-400 mb-4">${subtitle}</p>
      <div id="cf-turnstile-slot" class="flex justify-center my-4 min-h-[65px]"></div>
      <div class="flex justify-end mt-4">
        <button type="button" id="cf-cancel" class="btn btn-dark-weak">취소</button>
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
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) cleanup(null);
    });
    try {
      widgetId = window.turnstile.render(
        overlay.querySelector("#cf-turnstile-slot"),
        {
          sitekey,
          action,
          callback: (token) => cleanup(token),
          "error-callback": () => cleanup(null),
        }
      );
    } catch {
      cleanup(null);
    }
  });
}

// ---------------- Toast (Stacked) ----------------
export function showToast(message, isError = false) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className =
      "fixed top-[80px] left-1/2 -translate-x-1/2 z-[3000] flex flex-col gap-2 items-center w-full max-w-sm pointer-events-none";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  const themeClass = isError ? "toast-error" : "toast-success";
  toast.className = `toast-panel ${themeClass} !relative !right-auto !bottom-auto !inset-auto !transform-none w-auto min-w-[300px] pointer-events-auto opacity-0 -translate-y-4 transition-all duration-300`;
  const icon = isError
    ? '<i class="fas fa-circle-exclamation text-white/90"></i>'
    : '<i class="fas fa-check-circle text-emerald-400"></i>';
  toast.innerHTML = `${icon}<span>${message}</span>`;
  container.prepend(toast);
  while (container.children.length > 5) {
    container.removeChild(container.lastElementChild);
  }
  requestAnimationFrame(() => {
    toast.classList.remove("opacity-0", "-translate-y-4");
    toast.classList.add("opacity-100", "translate-y-0");
  });
  setTimeout(() => {
    toast.classList.remove("opacity-100", "translate-y-0");
    toast.classList.add("opacity-0", "-translate-y-4");
    setTimeout(() => {
      toast.remove();
      if (container.children.length === 0) container.remove();
    }, 300);
  }, 3000);
}

// ---------------- Confirm/Alert (Modal) ----------------
const CM_FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
function cm_trapFocus(modalEl, e) {
  if (e.key !== "Tab") return;
  const els = modalEl.querySelectorAll(CM_FOCUSABLE);
  if (!els.length) return;
  const first = els[0];
  const last = els[els.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) {
      last.focus();
      e.preventDefault();
    }
  } else if (document.activeElement === last) {
    first.focus();
    e.preventDefault();
  }
}

function createModalBase(title, contentHTML, footerHTML, variant = "info") {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.tabIndex = -1;

  const icons = {
    info: '<i class="fas fa-circle-info text-blue-500 text-xl"></i>',
    warn: '<i class="fas fa-triangle-exclamation text-amber-500 text-xl"></i>',
    danger: '<i class="fas fa-circle-exclamation text-rose-500 text-xl"></i>',
  };

  overlay.innerHTML = `
    <div class="modal-panel max-w-sm">
      <div class="flex items-start gap-3 mb-3">
        <div class="mt-0.5 shrink-0">${icons[variant] || icons.info}</div>
        <div>
          <h3 class="text-lg font-bold text-slate-900 dark:text-white leading-tight">${title}</h3>
          <div class="mt-2 text-[15px] text-slate-600 dark:text-slate-300 leading-relaxed break-keep">${contentHTML}</div>
        </div>
      </div>
      <div class="mt-6 flex justify-end gap-2">
        ${footerHTML}
      </div>
    </div>
  `;
  return overlay;
}

export function openConfirm(opts = {}) {
  const {
    title = "확인",
    message = "",
    variant = "info",
    confirmText = "확인",
    cancelText = "취소",
    defaultFocus = "confirm",
  } = opts;
  const confirmBtnClass =
    variant === "danger" ? "btn btn-danger" : "btn btn-primary";
  const footer = `
    <button type="button" class="btn btn-dark-weak" data-act="cancel">${cancelText}</button>
    <button type="button" class="${confirmBtnClass}" data-act="confirm">${confirmText}</button>
  `;
  const overlay = createModalBase(title, message, footer, variant);
  document.body.appendChild(overlay);
  const lastFocus = document.activeElement;
  const confirmBtn = overlay.querySelector('[data-act="confirm"]');
  const cancelBtn = overlay.querySelector('[data-act="cancel"]');
  (defaultFocus === "cancel" ? cancelBtn : confirmBtn)?.focus();

  return new Promise((resolve) => {
    const cleanup = (val) => {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      if (lastFocus?.focus) lastFocus.focus();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Escape") cleanup(false);
      if (e.key === "Tab") cm_trapFocus(overlay, e);
    };
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup(false);
      const act = e.target.closest("button")?.dataset.act;
      if (act === "confirm") cleanup(true);
      if (act === "cancel") cleanup(false);
    });
  });
}

export function openAlert(opts = {}) {
  const {
    title = "알림",
    message = "",
    variant = "info",
    confirmText = "확인",
  } = opts;
  const footer = `
    <button type="button" class="btn btn-primary" data-act="confirm">${confirmText}</button>
  `;
  const overlay = createModalBase(title, message, footer, variant);
  document.body.appendChild(overlay);
  const confirmBtn = overlay.querySelector('[data-act="confirm"]');
  confirmBtn?.focus();

  return new Promise((resolve) => {
    const cleanup = () => {
      overlay.remove();
      resolve();
    };
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cleanup();
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.closest('[data-act="confirm"]'))
        cleanup();
    });
  });
}

// ---------------- Admin Summary Modal ----------------
export function openAdminPendingSummaryModal({
  pendingUsers = 0,
  productPending = 0,
  userPending = 0,
}) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const content = document.createElement("div");
  content.className = "modal-panel max-w-md";

  const itemClass =
    "flex justify-between items-center py-3 border-b border-slate-100 dark:border-slate-700 last:border-0";
  const hotClass = "text-rose-600 dark:text-rose-400 font-bold";
  const hotUsers = Number(pendingUsers) > 0;
  const hotProd = Number(productPending) > 0;
  const hotCust = Number(userPending) > 0;

  content.innerHTML = `
    <h2 class="text-lg font-bold text-slate-800 dark:text-white mb-4 flex items-center gap-2">
      <i class="fas fa-clipboard-list text-blue-500"></i> 관리자 확인 필요
    </h2>
    <div class="flex flex-col mb-6">
      <div class="${itemClass}">
        <span class="text-slate-600 dark:text-slate-300">사용자 권한 대기</span>
        ${
          hotUsers
            ? `<a href="admin.html#pending-users" class="${hotClass} hover:underline">${pendingUsers}건</a>`
            : `<span class="text-slate-400 dark:text-slate-500">0건</span>`
        }
      </div>
      <div class="${itemClass}">
        <span class="text-slate-600 dark:text-slate-300">물품 승인 대기</span>
        ${
          hotProd
            ? `<a href="admin.html#pending-products" class="${hotClass} hover:underline">${productPending}건</a>`
            : `<span class="text-slate-400 dark:text-slate-500">0건</span>`
        }
      </div>
      <div class="${itemClass}">
        <span class="text-slate-600 dark:text-slate-300">이용자 승인 대기</span>
        ${
          hotCust
            ? `<a href="admin.html#pending-customers" class="${hotClass} hover:underline">${userPending}건</a>`
            : `<span class="text-slate-400 dark:text-slate-500">0건</span>`
        }
      </div>
    </div>
    <div class="flex justify-end">
      <button id="admin-pending-close" class="btn btn-dark-weak">닫기</button>
    </div>
  `;

  overlay.appendChild(content);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay
    .querySelector("#admin-pending-close")
    .addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
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
    const total = fb.pendingUsers + fb.productPending + fb.userPending;

    if (total > 0) {
      openAdminPendingSummaryModal(fb);
      sessionStorage.setItem(flagKey, "1");
    }
  } finally {
    __adminPendingModalInFlight = false;
  }
}

async function fallbackPendingSummaryFromFirestore() {
  try {
    const usersQ = query(
      collection(db, "users"),
      where("role", "==", "pending")
    );
    const usersSnap = await getDocs(usersQ);
    const pendingUsers = usersSnap.size;
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
