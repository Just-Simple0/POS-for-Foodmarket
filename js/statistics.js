import { db, auth } from "./components/firebase-config.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  deleteDoc,
  updateDoc,
  query,
  where,
  Timestamp,
  documentId,
  orderBy,
  startAt,
  endAt,
  startAfter,
  endBefore,
  limit,
  limitToLast,
  getCountFromServer,
  runTransaction,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
  increment,
  deleteField,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  showToast,
  renderCursorPager,
  makeSectionSkeleton,
  openConfirm,
  withLoading,
  setBusy,
  renderEmptyState,
  logEvent,
} from "./components/comp.js";

// ✅ 관리자 즉시 반영(제공 수정/삭제/생명사랑 삭제)은 utils/adminProvisionOps.js로 통일
import {
  adminApplyProvisionEdit,
  adminDeleteProvision,
  adminUnsetLifeloveForProvision,
} from "./utils/adminProvisionOps.js";

import { createApprovalRequest } from "./utils/approval.js";

// ===== Debug helpers =====
function logFirebaseError(err, context = "") {
  try {
    const code = err?.code || "";
    const msg = err?.message || String(err);
    console.error(`[FirebaseError] ${context}`.trim(), { code, msg, err });
    if (err?.stack) console.error(err.stack);

    // Optional: show details inside the edit modal (if present)
    const box = document.getElementById("prov-edit-debug");
    const pre = document.getElementById("prov-edit-debug-pre");
    if (box && pre) {
      pre.textContent = JSON.stringify(
        {
          context,
          code,
          message: msg,
        },
        null,
        2,
      );
      box.classList.remove("hidden");
    }
  } catch (_) {
    console.error(err);
  }
}

// daterangepicker는 #start-date-input에만 붙어 있음.
// start/end 둘 다 start-date-input의 picker에서 가져와야 함.
function getCurrentProvisionRange() {
  const startEl = $("#start-date-input");
  const picker = startEl?.data?.("daterangepicker");
  if (picker?.startDate && picker?.endDate) {
    return { start: picker.startDate.toDate(), end: picker.endDate.toDate() };
  }

  // Fallback: input 값(YYYY.MM.DD) 파싱
  const parse = (v) => {
    if (!v) return null;
    const m = String(v).match(/^(\d{4})\.(\d{2})\.(\d{2})$/);
    if (!m) return null;
    const dt = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      0,
      0,
      0,
      0,
    );
    return isNaN(dt.getTime()) ? null : dt;
  };

  const s = parse(startEl?.val?.());
  const e = parse($("#end-date-input")?.val?.());
  const today = new Date();
  return { start: s || today, end: e || s || today };
}

/**
 * 통합 검색 UI 초기화
 * - 탭/기간/연도/분기 변경 시 검색어가 남아있으면 "데이터가 없다고 오해"하기 쉬움
 * - 검색 에러 UI도 같이 내려서 UX 일관성 유지
 */
function clearUnifiedSearchInputs() {
  const g = document.getElementById("global-search");
  const f = document.getElementById("field-search");
  if (g) g.value = "";
  if (f) f.value = "";

  // 에러 UI/상태도 함께 초기화
 try {
    toggleSearchError("global-search-group", false);
    toggleSearchError("field-search-group", false);
  } catch (_) {}
}

/* =====================================================
 * KST / Business Day Helpers
 * - KST로 날짜 키(YYYYMMDD) 및 start/end 경계를 통일
 * - 영업일: 주말 + 공휴일 + 근로자의날(5/1) 제외
 *   공휴일은 Nager.Date API (KR) 사용 + localStorage 캐시(30일)
 * ===================================================== */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WORKERS_DAY_MMDD = "05-01";
const HOLIDAY_CACHE_PREFIX = "kr_holidays_";

function toKstDateParts(date) {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  return {
    y: k.getUTCFullYear(),
    m: k.getUTCMonth() + 1,
    d: k.getUTCDate(),
    dow: k.getUTCDay(), // 0=Sun..6=Sat (KST 기준)
  };
}

function kstStartOfDay(date) {
  const { y, m, d } = toKstDateParts(date);
  // KST 00:00:00.000 => UTC ms
  const utcMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - KST_OFFSET_MS;
  return new Date(utcMs);
}

function kstEndOfDay(date) {
  const start = kstStartOfDay(date);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

function addDaysKst(date, deltaDays) {
  // KST 날짜 단위 이동(정오 기준으로 안전 이동)
  const { y, m, d } = toKstDateParts(date);
  const utcBase = Date.UTC(y, m - 1, d, 12, 0, 0, 0) - KST_OFFSET_MS;
  return new Date(utcBase + deltaDays * 24 * 60 * 60 * 1000);
}

function toDayNumberKst(date) {
  const { y, m, d } = toKstDateParts(date);
  return y * 10000 + m * 100 + d;
}

function isWeekendKst(date) {
  const { dow } = toKstDateParts(date);
  return dow === 0 || dow === 6;
}

function isWorkersDayKst(date) {
  const { m, d } = toKstDateParts(date);
  const mmdd = `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return mmdd === WORKERS_DAY_MMDD;
}

function ymd8FromParts({ y, m, d }) {
  return `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
}

async function fetchHolidaySetKr(year) {
  const key = `${HOLIDAY_CACHE_PREFIX}${year}`;
  const cached = (() => {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  })();

  const now = Date.now();
  if (
    cached &&
    Array.isArray(cached.set) &&
    now - Number(cached.fetchedAt || 0) < 30 * 24 * 60 * 60 * 1000
  ) {
    return new Set(cached.set);
  }

  const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/KR`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`holiday api ${res.status}`);
    const arr = await res.json();
    const set = (Array.isArray(arr) ? arr : [])
      .map((x) => String(x?.date || "").replace(/-/g, ""))
      .filter((s) => /^\d{8}$/.test(s));

    // 근로자의 날은 공휴일 API에 없을 수 있으므로 강제 포함
    const merged = Array.from(new Set([...set, `${year}0501`]));
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ fetchedAt: now, set: merged }),
      );
    } catch {}
    return new Set(merged);
  } catch (e) {
    if (cached && Array.isArray(cached.set)) return new Set(cached.set);
    return new Set([`${year}0501`]); // 마지막 fallback
  }
}

async function isBusinessDayKst(date) {
  if (isWeekendKst(date)) return false;
  if (isWorkersDayKst(date)) return false;
  const { y } = toKstDateParts(date);
  const holidays = await fetchHolidaySetKr(y);
  const ymd8 = ymd8FromParts(toKstDateParts(date));
  return !holidays.has(ymd8);
}

async function nearestPrevBusinessDayKst(date) {
  // date가 비영업일이면 가장 가까운 이전 영업일을 반환(비영업일이면 포함X)
  let cur = new Date(date);
  if (await isBusinessDayKst(cur)) return cur;
  for (let i = 0; i < 370; i++) {
    cur = addDaysKst(cur, -1);
    if (await isBusinessDayKst(cur)) return cur;
  }
  return cur;
}

async function prevBusinessDayKst(date) {
  // date 이전(포함X) 가장 가까운 이전 영업일
  let cur = new Date(date);
  for (let i = 0; i < 370; i++) {
    cur = addDaysKst(cur, -1);
    if (await isBusinessDayKst(cur)) return cur;
  }
  return cur;
}

/* =====================================================
 * State & Config
 * ===================================================== */
let allProvisionData = [];
let provisionData = [];
let visitData = [];
let lifeData = [];
let provisionPageRaw = []; // ✅ 서버 페이징 모드: 현재 페이지 원본 데이터(필터/정렬 전)

let provisionCurrentPage = 1;
let visitCurrentPage = 1;
let lifeCurrentPage = 1;
let itemsPerPage = 20;

let isAdmin = false; // 관리자 여부
let currentProvSort = { field: "date", dir: "asc" }; // 정렬 상태 기본값

// ===== Utils =====
function formatDateTime(dateObj) {
  const yyyy = dateObj.getFullYear();
  const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
  const dd = String(dateObj.getDate()).padStart(2, "0");
  const hh = String(dateObj.getHours()).padStart(2, "0");
  const min = String(dateObj.getMinutes()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd} ${hh}:${min}`;
}

function formatDate(dateObj) {
  const yyyy = dateObj.getFullYear();
  const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
  const dd = String(dateObj.getDate()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd}`;
}

function normalize(str) {
  return (
    str
      ?.toString()
      .toLowerCase()
      .replace(/[\s\-]/g, "") || ""
  );
}

// ===== Provision/Visit Key Helpers (same rule as provision.js) =====
function toDayNumber(d) {
  // ✅ KST 기준 YYYYMMDD로 통일
  return toDayNumberKst(d);
}
function toDateKey(dayNum) {
  const y = Math.floor(dayNum / 10000);
  const m = Math.floor((dayNum % 10000) / 100);
  const d = dayNum % 100;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function toPeriodKey(date) {
  const { y, m } = toKstDateParts(date);
  const startY = m >= 3 ? y : y - 1;
  const endY = startY + 1;
  return `${String(startY).slice(2)}-${String(endY).slice(2)}`;
}

function fmtYMD(s) {
  if (!s) return "";
  try {
    const iso = String(s).replace(/\./g, "-");
    const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  } catch {}
  return String(s);
}
function computeLastVisit(c) {
  const v = c?.visits;
  if (!v || typeof v !== "object") return "";
  let latest = "";
  for (const k of Object.keys(v)) {
    const arr = Array.isArray(v[k]) ? v[k] : [];
    for (const s of arr) {
      if (!s) continue;
      const iso = String(s).replace(/\./g, "-");
      if (!latest || iso > latest) latest = iso;
    }
  }
  return latest ? fmtYMD(latest) : "";
}
function lastVisitDisplay(data) {
  return fmtYMD(data?.lastVisit) || computeLastVisit(data) || "-";
}

function getCurrentPeriodKey() {
  const date = new Date();
  const { y: year, m: month } = toKstDateParts(date);
  let startYear = month >= 3 ? year : year - 1;
  let endYear = startYear + 1;
  return `${String(startYear).slice(2)}-${String(endYear).slice(2)}`;
}

function getFiscalPeriodKeys(n = 6) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const { y, m } = toKstDateParts(today);
    const year = y - i;
    const startYear = m >= 3 ? year : year - 1;
    const endYear = startYear + 1;
    out.push(`${String(startYear).slice(2)}-${String(endYear).slice(2)}`);
  }
  return [...new Set(out)];
}

function debounce(fn, ms = 220) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ===== Customer Lookup (Provision Edit Modal) =====
// - IndexedDB support cache 우선 검색 → 없으면 서버 prefix 검색
// - provision.html에서 사용하는 UI/모달과 동일한 id를 그대로 사용
const IDB_NAME = "pos_customers";
const IDB_STORE = "support_only"; // customers.js/provision.js와 동일

function openIDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return reject(new Error("indexedDB not supported"));
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const dbi = req.result;
      if (!dbi.objectStoreNames.contains(IDB_STORE)) {
        const st = dbi.createObjectStore(IDB_STORE, { keyPath: "id" });
        st.createIndex("nameLower", "nameLower", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function searchCacheByNamePrefix(prefix, max = 20) {
  const dbi = await openIDB();
  const tx = dbi.transaction(IDB_STORE, "readonly");
  const st = tx.objectStore(IDB_STORE);
  const idx = st.index("nameLower");
  const range = IDBKeyRange.bound(prefix, prefix + "￿");
  return await new Promise((resolve) => {
    const out = [];
    idx.openCursor(range).onsuccess = (e) => {
      const cur = e.target.result;
      if (cur && out.length < max) {
        out.push(cur.value);
        cur.continue();
      } else resolve(out);
    };
  });
}

const SUPPORT_CACHE_SYNC_KEY = "support_cache_synced_at";
const SUPPORT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let __supportCacheSyncPromise = null;

async function idbCountSupportCache(dbi) {
  return await new Promise((resolve, reject) => {
    const tx = dbi.transaction(IDB_STORE, "readonly");
    const st = tx.objectStore(IDB_STORE);
    const req = st.count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  });
}

async function idbClearSupportCache(dbi) {
  return await new Promise((resolve, reject) => {
    const tx = dbi.transaction(IDB_STORE, "readwrite");
    const st = tx.objectStore(IDB_STORE);
    st.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("idb clear failed"));
  });
}

async function idbPutManySupportCache(dbi, items) {
  if (!items || items.length === 0) return;
  return await new Promise((resolve, reject) => {
    const tx = dbi.transaction(IDB_STORE, "readwrite");
    const st = tx.objectStore(IDB_STORE);
    for (const it of items) st.put(it);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("idb put failed"));
  });
}

function pickSupportCacheShape(id, data) {
  const name = data?.name || "";
  const nameLower = data?.nameLower || normalize(name);
  return {
    id,
    name,
    birth: data?.birth || "",
    gender: data?.gender || "",
    status: data?.status || "",
    region1: data?.region1 || "",
    address: data?.address || "",
    phone: data?.phone || "",
    type: data?.type || "",
    category: data?.category || "",
    note: data?.note || "",
    lastVisit: data?.lastVisit || "",
    visits: data?.visits || null,
    nameLower,
  };
}

async function syncSupportCacheFromServerOnce() {
  const dbi = await openIDB();
  await idbClearSupportCache(dbi);

  const PAGE = 500;
  let lastDoc = null;
  let total = 0;

  while (true) {
    const base = [
      where("status", "==", "지원"),
      orderBy("nameLower"),
      limit(PAGE),
    ];
    const qy = lastDoc
      ? query(collection(db, "customers"), ...base, startAfter(lastDoc))
      : query(collection(db, "customers"), ...base);

    const snap = await getDocs(qy);
    if (snap.empty) break;

    const items = snap.docs.map((d) => pickSupportCacheShape(d.id, d.data()));
    await idbPutManySupportCache(dbi, items);
    total += items.length;

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE) break;
  }

  localStorage.setItem(SUPPORT_CACHE_SYNC_KEY, String(Date.now()));
  return total;
}

async function ensureSupportCacheFresh() {
  if (__supportCacheSyncPromise) return __supportCacheSyncPromise;

  const lastSynced = Number(localStorage.getItem(SUPPORT_CACHE_SYNC_KEY) || 0);
  const now = Date.now();
  const stale = !lastSynced || now - lastSynced > SUPPORT_CACHE_TTL_MS;

  let dbi;
  try {
    dbi = await openIDB();
  } catch (e) {
    console.warn("openIDB failed:", e);
    return;
  }

  let count = 0;
  try {
    count = await idbCountSupportCache(dbi);
  } catch (e) {
    console.warn("idbCountSupportCache failed:", e);
    count = 0;
  }

  if (count > 0 && !stale) return;

  __supportCacheSyncPromise = (async () => {
    try {
      const total = await syncSupportCacheFromServerOnce();
      if (count === 0 && total > 0 && typeof showToast === "function") {
        showToast(`이용자 캐시 ${total}명 동기화 완료`);
      }
    } catch (e) {
      console.warn("ensureSupportCacheFresh sync failed:", e);
    } finally {
      __supportCacheSyncPromise = null;
    }
  })();

  return __supportCacheSyncPromise;
}

async function serverSearchByNamePrefix(prefix, max = 20) {
  const base = collection(db, "customers");
  const qy = query(
    base,
    where("status", "==", "지원"),
    orderBy("nameLower"),
    startAt(prefix),
    endAt(prefix + ""),
    limit(max),
  );
  const snap = await getDocs(qy);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// duplicate modal state
let selectedCandidate = null;
let dupActiveIndex = -1;
let dupKeyHandler = null;

function showDuplicateSelection(rows) {
  const duplicateModal = document.getElementById("duplicate-modal");
  const duplicateList = document.getElementById("duplicate-list");
  const confirmBtn = document.getElementById("confirm-duplicate");
  const closeBtn = document.getElementById("close-duplicate-modal");
  const infoEl = document.getElementById("selected-info");
  if (!duplicateModal || !duplicateList || !confirmBtn || !closeBtn || !infoEl)
    return;

  duplicateList.innerHTML = "";
  selectedCandidate = null;
  confirmBtn.disabled = true;

  const items = [];
  rows.forEach((row, i) => {
    const data = row;
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="dup-name text-slate-900 dark:text-slate-100"><strong>${
        data.name
      }</strong></div>
      <div class="dup-sub text-slate-500 dark:text-slate-400">
        ${data.birth || "생년월일 없음"} | ${data.phone || "전화번호 없음"}
      </div>
    `;
    li.classList.add("duplicate-item");
    li.tabIndex = -1;

    const selectThis = () => {
      document
        .querySelectorAll(".duplicate-item")
        .forEach((el) => el.classList.remove("selected"));
      li.classList.add("selected");

      document
        .querySelectorAll(".duplicate-item i")
        .forEach((icon) => icon.remove());

      const icon = document.createElement("i");
      icon.className =
        "fas fa-square-check text-blue-600 dark:text-blue-400 mr-2";
      li.prepend(icon);

      selectedCandidate = { id: data.id, ...data };
      infoEl.innerHTML = `
        <div class="bg-slate-50 dark:bg-slate-900 rounded-xl p-4 border border-slate-200 dark:border-slate-700 mt-2 shadow-sm">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-5">
            <div class="flex flex-col sm:col-span-2 mb-2">
              <span class="font-bold text-slate-500 dark:text-slate-400 mb-1">주소</span>
              <span class="text-slate-900 dark:text-slate-200 break-keep">${
                data.address || "-"
              }</span>
            </div>
            <div class="flex flex-col mb-2">
              <span class="font-bold text-slate-500 dark:text-slate-400 mb-1">성별</span>
              <span class="text-slate-900 dark:text-slate-200">${
                data.gender || "-"
              }</span>
            </div>
            <div class="flex flex-col mb-2">
              <span class="font-bold text-slate-500 dark:text-slate-400 mb-1">최근 방문일자</span>
              <span class="text-slate-900 dark:text-slate-200">${
                lastVisitDisplay(data) || "-"
              }</span>
            </div>
            <div class="flex flex-col sm:col-span-2">
              <span class="font-bold text-slate-500 dark:text-slate-400 mb-1">비고</span>
              <span class="text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-700/50 px-2 py-1.5 rounded border border-slate-100 dark:border-slate-600/50 text-xs leading-relaxed">
                ${data.note || "-"}
              </span>
            </div>
          </div>
        </div>
      `;
      infoEl.classList.remove("hidden");
      confirmBtn.disabled = false;
      dupActiveIndex = i;
      li.focus();
    };

    li.addEventListener("click", selectThis);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter") selectThis();
    });
    duplicateList.appendChild(li);
    items.push(li);
  });

  if (items.length > 0) {
    items[0].click();
    dupActiveIndex = 0;
  }

  duplicateModal.classList.remove("hidden");

  const clearModal = () => {
    duplicateModal.classList.add("hidden");
    duplicateList.innerHTML = "";
    infoEl.classList.add("hidden");
    infoEl.innerHTML = "";
    selectedCandidate = null;
    dupActiveIndex = -1;
    if (dupKeyHandler) {
      document.removeEventListener("keydown", dupKeyHandler, true);
      dupKeyHandler = null;
    }
  };

  closeBtn.onclick = () => {
    clearModal();
    const inp = document.getElementById("prov-customer-search");
    if (inp) inp.focus();
  };

  if (dupKeyHandler)
    document.removeEventListener("keydown", dupKeyHandler, true);
  dupKeyHandler = (e) => {
    if (duplicateModal.classList.contains("hidden")) return;
    const max = items.length - 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      dupActiveIndex = dupActiveIndex < max ? dupActiveIndex + 1 : 0;
      items[dupActiveIndex].click();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      dupActiveIndex = dupActiveIndex > 0 ? dupActiveIndex - 1 : max;
      items[dupActiveIndex].click();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeBtn.click();
    } else if (e.key === "Enter") {
      if (!confirmBtn.disabled) {
        e.preventDefault();
        e.stopPropagation();
        confirmBtn.click();
      }
    }
  };
  document.addEventListener("keydown", dupKeyHandler, true);
}

function bindProvisionEditCustomerLookup() {
  const lookupBtn = document.getElementById("prov-lookup-btn");
  const lookupInput = document.getElementById("prov-customer-search");
  const groupEl = document.getElementById("prov-lookup-group");
  const errorEl = document.getElementById("prov-lookup-error");
  const confirmBtn = document.getElementById("confirm-duplicate");
  const duplicateModal = document.getElementById("duplicate-modal");

  if (!lookupBtn || !lookupInput || !groupEl || !errorEl) return;

  const clearError = () => {
    groupEl.classList.remove("is-error");
    errorEl.classList.add("hidden");
  };

  lookupInput.addEventListener("input", clearError);

  lookupInput.addEventListener("keydown", (e) => {
    if (duplicateModal && !duplicateModal.classList.contains("hidden")) return;
    if (e.key === "Enter") {
      e.preventDefault();
      lookupBtn.click();
    }
  });

  lookupBtn.addEventListener("click", async () => {
    const raw = lookupInput.value.trim();
    clearError();

    if (!raw) {
      groupEl.classList.add("is-error");
      errorEl.textContent = "이름을 입력하세요.";
      errorEl.classList.remove("hidden");
      return;
    }

    try {
      const key = normalize(raw);
      await ensureSupportCacheFresh();
      let rows = await searchCacheByNamePrefix(key, 20);
      if (!rows || rows.length === 0)
        rows = await serverSearchByNamePrefix(key, 20);

      if (!rows.length) {
        groupEl.classList.add("is-error");
        errorEl.textContent = "해당 이용자를 찾을 수 없습니다.";
        errorEl.classList.remove("hidden");
        lookupInput.focus();
        return;
      }
      showDuplicateSelection(rows);
    } catch (err) {
      console.error(err);
      groupEl.classList.add("is-error");
      errorEl.textContent = "조회 중 오류가 발생했습니다.";
      errorEl.classList.remove("hidden");
    }
  });

  // confirm 버튼 동작: 선택된 이용자를 수정 모달 입력값에 반영
  confirmBtn?.addEventListener("click", () => {
    if (!selectedCandidate) return showToast("이용자를 선택하세요.", true);

    const newIdEl = document.getElementById("prov-edit-new-customer-id");
    const newBirthEl = document.getElementById("prov-edit-new-customer-birth");
    const nameEl = document.getElementById("prov-edit-name");

    if (newIdEl) newIdEl.value = selectedCandidate.id;
    if (newBirthEl) newBirthEl.value = selectedCandidate.birth || "";
    if (nameEl) nameEl.value = selectedCandidate.name || "";

    document.getElementById("duplicate-modal")?.classList.add("hidden");
    document.getElementById("duplicate-list")?.replaceChildren();
    const infoEl = document.getElementById("selected-info");
    if (infoEl) {
      infoEl.classList.add("hidden");
      infoEl.innerHTML = "";
    }
    selectedCandidate = null;
    dupActiveIndex = -1;

    lookupInput.value = "";
    lookupInput.focus();

    if (dupKeyHandler) {
      document.removeEventListener("keydown", dupKeyHandler, true);
      dupKeyHandler = null;
    }
  });
}

// ===== Auth & Role =====
async function applyRoleFromUser(user) {
  if (!user) {
    isAdmin = false;
  } else {
    const token = await user.getIdTokenResult().catch(() => null);
    const role = token?.claims?.role || "pending";
    isAdmin = role === "admin";
  }
}

// ===== Pager Renderer (renderCursorPager Wrapper) =====
function renderSimplePager(containerId, current, totalPages, onMove) {
  const el = document.getElementById(containerId);
  if (!el) return;

  renderCursorPager(
    el,
    {
      current,
      pagesKnown: totalPages,
      hasPrev: current > 1,
      hasNext: current < totalPages,
    },
    {
      goFirst: () => onMove(1),
      goPrev: () => onMove(Math.max(1, current - 1)),
      goPage: (n) => onMove(n),
      goNext: () => onMove(Math.min(totalPages, current + 1)),
      goLast: () => onMove(totalPages),
    },
    { window: 5 },
  );
}

// ===== Error Toggle Helper =====
function toggleSearchError(groupId, show, msg = "검색 결과가 없습니다.") {
  const group = document.getElementById(groupId);
  if (!group) return;
  const errText = group.querySelector(".field-error-text");
  if (show) {
    group.classList.add("is-error");
    if (errText) {
      errText.textContent = msg;
      errText.classList.remove("hidden");
    }
  } else {
    group.classList.remove("is-error");
    if (errText) errText.classList.add("hidden");
  }
}

/* =====================================================
 * Provision Logic (Server Pagination + Sorting + CRUD)
 * ===================================================== */
let provCursor = {
  startTs: null,
  endTs: null,
  firstDoc: null,
  lastDoc: null,
  serverMode: false,
  page: 1,
  totalPages: 1,
  hasNext: false,
};

// ===== Provision Search Mode (A안) =====
// - 기본: serverMode=true (현재 페이지에서만 렌더/정렬)
// - 검색 버튼/Enter 실행 시: 기간 내 데이터를 1000개 단위로 로드하면서(더보기) client filtering
// - Export는 제한 없이 기간 내 전체를 끝까지 로드 후(검색이면 검색결과 전체) 저장
const PROV_SEARCH_BATCH = 1000;
let __provRangeKey = "";
let __provSearchMode = false;
let __provAllLoaded = false;
let __provLastDocForRange = null;
let __provLoadMorePromise = null;

function getProvRangeKey() {
  const s = provCursor?.startTs?.toMillis?.() || "";
  const e = provCursor?.endTs?.toMillis?.() || "";
  return `${s}_${e}`;
}

function resetProvisionRangeCache() {
  __provRangeKey = getProvRangeKey();
  __provSearchMode = false;
  __provAllLoaded = false;
  __provLastDocForRange = null;
  __provLoadMorePromise = null;
  allProvisionData = [];
  provisionData = [];
  provisionCurrentPage = 1;
}

function ensureProvLoadMoreUI(show) {
  const section = document.getElementById("provision-section");
  if (!section) return;

  let wrap = document.getElementById("prov-load-more-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "prov-load-more-wrap";
    wrap.className = "mt-3 flex justify-center";
    section.appendChild(wrap);
  }

  if (!show) {
    wrap.innerHTML = "";
    return;
  }

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className =
    "btn btn-light px-4 py-2 rounded-xl";
  btn.innerHTML = `<i class="fas fa-plus mr-2 text-xs"></i>더 불러오기 (1000건)`;
  btn.addEventListener("click", async () => {
    await withLoading(async () => {
      await loadMoreProvisionRange(PROV_SEARCH_BATCH);
      filterAndRender();
    }, "제공 내역 추가 로딩 중…");
  });
  wrap.replaceChildren(btn);
}

async function loadMoreProvisionRange(batch = PROV_SEARCH_BATCH) {
  if (__provAllLoaded) return;
  if (__provLoadMorePromise) return __provLoadMorePromise;

  __provLoadMorePromise = (async () => {
    const base = [
      where("timestamp", ">=", provCursor.startTs),
      where("timestamp", "<=", provCursor.endTs),
      orderBy("timestamp", "asc"),
      limit(batch),
    ];
    const qy = __provLastDocForRange
      ? query(
          collection(db, "provisions"),
          ...base,
          startAfter(__provLastDocForRange),
        )
      : query(collection(db, "provisions"), ...base);

    const snap = await getDocs(qy);
    if (snap.empty) {
      __provAllLoaded = true;
      return;
    }

    const docs = snap.docs;
    allProvisionData.push(...docs.map(processProvisionDoc));
    __provLastDocForRange = docs[docs.length - 1];
    if (docs.length < batch) __provAllLoaded = true;
  })();

  try {
    await __provLoadMorePromise;
  } finally {
    __provLoadMorePromise = null;
  }
}

function isProvisionClientFilteringOn() {
  const g = document.getElementById("global-search")?.value?.trim();
  const f = document.getElementById("field-search")?.value?.trim();
  return !!(g || f);
}

// [추가/수정] 클라이언트 정렬 함수 (customers.js 스타일)
function sortProvisionData(data) {
  const { field, dir } = currentProvSort;
  return [...data].sort((a, b) => {
    let valA = a[field];
    let valB = b[field];

    // 1. 날짜 비교 (Firestore Timestamp 또는 문자열)
    if (field === "date") {
      const timeA = a.rawTimestamp
        ? a.rawTimestamp.toMillis()
        : new Date(a.date).getTime();
      const timeB = b.rawTimestamp
        ? b.rawTimestamp.toMillis()
        : new Date(b.date).getTime();
      return dir === "asc" ? timeA - timeB : timeB - timeA;
    }

    // 2. 문자열/숫자 비교
    // null/undefined 안전 처리
    valA = (valA || "").toString().toLowerCase().trim();
    valB = (valB || "").toString().toLowerCase().trim();

    if (valA < valB) return dir === "asc" ? -1 : 1;
    if (valA > valB) return dir === "asc" ? 1 : -1;
    return 0;
  });
}

// [추가] 정렬 아이콘 UI 업데이트
function updateProvSortIcons() {
  document
    .querySelectorAll("#provision-table thead th[data-sort]")
    .forEach((th) => {
      const field = th.dataset.sort;
      const icon = th.querySelector("i");
      if (!icon) return;

      if (currentProvSort.field === field) {
        // 선택된 열: 파란색 + 방향 표시
        icon.className =
          currentProvSort.dir === "asc"
            ? "fas fa-sort-up text-blue-500"
            : "fas fa-sort-down text-blue-500";
      } else {
        // 선택 안 된 열: 회색 기본
        icon.className = "fas fa-sort text-slate-300";
      }
    });
}

// 데이터 로드
// Data Fetching: Provision (Fetch All & Client Side Handling)
async function loadProvisionHistoryByRange(startDate, endDate) {
  // 메모리 페이징 상태 초기화(legacy)
  allProvisionData = [];
  provisionData = [];
  provisionPageRaw = [];
  provisionCurrentPage = 1;

  // 서버 페이징 커서 초기화
  provCursor.firstDoc = null;
  provCursor.lastDoc = null;
  provCursor.page = 1;
  provCursor.totalPages = 1;
  provCursor.hasNext = false;

  // ✅ 날짜 범위 → KST day boundary로 Timestamp 변환
  const start = kstStartOfDay(new Date(startDate));
  const end = kstEndOfDay(new Date(endDate));

  provCursor.startTs = Timestamp.fromDate(start);
  provCursor.endTs = Timestamp.fromDate(end);

   // ✅ 기본은 서버 페이징 모드
  provCursor.serverMode = true;

  // ✅ 기간 변경 시 검색 모드/캐시 리셋
  resetProvisionRangeCache();

  // 스켈레톤
  const tbody = document.querySelector("#provision-table tbody");
  const cleanup = makeSectionSkeleton(tbody, 10);

  // 최소 로딩 시간
  const MIN_LOADING_TIME = 500;

  try {
    // 1) 카운트(총 페이지 계산) + 최소 지연
    await Promise.all([
      (async () => {
        try {
          await computeProvisionTotalPages();
        } catch (e) {
          console.warn("count failed, fallback totalPages=1:", e);
          provCursor.totalPages = 1;
        }
      })(),
      new Promise((resolve) => setTimeout(resolve, MIN_LOADING_TIME)),
    ]);

    // 2) 첫 페이지 로드(렌더는 loadProvisionPage → filterAndRender가 처리)
    await loadProvisionPage("init");
  } catch (e) {
    console.error(e);
    showToast("제공 내역 로드 실패", true);
  } finally {
    cleanup();
  }
}

function processProvisionDoc(doc) {
  const d = doc.data();
  const items = (d.items || []).map((i) => ({
    name: i.name,
    quantity: Number(i.quantity),
    price: Number(i.price),
    total: Number(i.quantity) * Number(i.price),
  }));
  return {
    id: doc.id,
    rawTimestamp: d.timestamp,
    date: formatDateTime(d.timestamp.toDate()), // YYYY.MM.DD HH:mm
    customerId: d.customerId || "",
    name: d.customerName,
    birth: d.customerBirth,
    items: items,
    itemsText: items.map((i) => `${i.name}(${i.quantity})`).join(", "),
    handler: d.handledBy,
    totalPrice: d.total || items.reduce((a, b) => a + b.total, 0),
    lifelove: !!d.lifelove,
    quarterKey: d.quarterKey || "",
  };
}

// ===== Approval Payload Helpers (Admin UI friendly) =====
function ymdFromTimestamp(ts) {
  try {
    const d = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
    if (!d) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}.${m}.${dd}`;
  } catch {
    return "";
  }
}
function buildProvisionApprovalPayload(row, extra = {}) {
  const dateYMD = row?.rawTimestamp
    ? ymdFromTimestamp(row.rawTimestamp)
    : (row?.date || "").split(" ")[0] || "";
  const target = `${dateYMD} / ${row?.name || "-"}${row?.birth ? `(${row.birth})` : ""}`;
  // ✅ Admin 승인요청 표시에 쓰일 요약 문구(요구사항 포맷 고정)
  // - 제공 수정: "수정: 이용자 -> BBB | 처리자 -> email"
  // - 제공 삭제: "제공 삭제: 제공일자 / AAA(생년월일)"
  let summary = target;

  const action = extra?.action || "";
  if (action === "delete") {
    summary = `제공 삭제: ${target}`;
  } else if (action === "update") {
    const parts = [];
    const oldHandler = row?.handler || row?.handledBy || "";
    const requestedHandler = (extra?.requestedHandler ?? "").trim();
    const handlerChanged =
      requestedHandler && requestedHandler !== String(oldHandler || "").trim();

    const oldCustomerId = extra?.oldCustomerId || row?.customerId || "";
    const newCustomerId = extra?.newCustomerId || "";
    const customerChanged = newCustomerId && newCustomerId !== oldCustomerId;

    if (customerChanged) {
      const nm = (extra?.newCustomerName || "").trim() || "-";
      parts.push(`이용자 → ${nm}`);
    }
    if (handlerChanged) {
      parts.push(`처리자 → ${requestedHandler}`);
    }

    summary = parts.length ? `수정: ${parts.join(" | ")}` : `수정: ${target}`;
  }

  return {
    displayTarget: target,
    displaySummary: summary,
    provisionId: row?.id,
    providedAt: row?.date || "",
    day: row?.rawTimestamp ? row.rawTimestamp : null,
    customerId: row?.customerId || "",
    customerName: row?.name || "",
    customerBirth: row?.birth || "",
    itemsText: row?.itemsText || "",
    totalPrice: row?.totalPrice ?? null,
    handledBy: row?.handler || "",
    quarterKey: row?.quarterKey || "",
    lifelove: !!row?.lifelove,
    ...extra,
  };
}
function buildLifeApprovalPayload(row, extra = {}) {
  const dateYMD = (row?.providedAt || "").split(" ")[0] || "";
  const target = `${dateYMD} / ${row?.name || "-"}${row?.birth ? `(${row.birth})` : ""}`;

  const action = extra?.action || "";
  const summary =
    action === "lifelove_delete" ? `생명사랑 제공 삭제: ${target}` : target;
  return {
    displayTarget: target,
    displaySummary: summary,
    provId: row?.provId,
    customerId: row?.customerId,
    quarterKey: row?.quarterKey,
    ...extra,
  };
}

async function computeProvisionTotalPages() {
  const q = query(
    collection(db, "provisions"),
    where("timestamp", ">=", provCursor.startTs),
    where("timestamp", "<=", provCursor.endTs),
  );
  const snap = await getCountFromServer(q);
  provCursor.totalPages = Math.max(
    1,
    Math.ceil(snap.data().count / itemsPerPage),
  );
}

async function loadProvisionPage(dir) {
  const base = [
    where("timestamp", ">=", provCursor.startTs),
    where("timestamp", "<=", provCursor.endTs),
  ];

  let q;

  // ✅ ASC(오래된순) 기준 페이징
  if (dir === "init") {
    q = query(
      collection(db, "provisions"),
      ...base,
      orderBy("timestamp", "asc"),
      limit(itemsPerPage),
    );
    provCursor.page = 1;
  } else if (dir === "next") {
    if (!provCursor.lastDoc) return;
    q = query(
      collection(db, "provisions"),
      ...base,
      orderBy("timestamp", "asc"),
      startAfter(provCursor.lastDoc),
      limit(itemsPerPage),
    );
  } else if (dir === "prev") {
    if (!provCursor.firstDoc) return;
    q = query(
      collection(db, "provisions"),
      ...base,
      orderBy("timestamp", "asc"),
      endBefore(provCursor.firstDoc),
      limitToLast(itemsPerPage),
    );
  } else if (dir === "last") {
    q = query(
      collection(db, "provisions"),
      ...base,
      orderBy("timestamp", "asc"),
      limitToLast(itemsPerPage),
    );
    provCursor.page = provCursor.totalPages;
  } else {
    return;
  }

  const snap = await getDocs(q);
  const docs = snap.docs;

  // 현재 페이지 원본 캐시
  provisionPageRaw = docs.map(processProvisionDoc);

  // 커서 갱신
  if (docs.length > 0) {
    provCursor.firstDoc = docs[0];
    provCursor.lastDoc = docs[docs.length - 1];
  } else {
    provCursor.firstDoc = null;
    provCursor.lastDoc = null;
  }

  // 페이지 번호 갱신
  if (dir === "next")
    provCursor.page = Math.min(provCursor.page + 1, provCursor.totalPages);
  if (dir === "prev") provCursor.page = Math.max(provCursor.page - 1, 1);

  // 렌더/검색/정렬(현재 페이지 내)은 통합 렌더러가 처리
  filterAndRender();
}

// 수정 핸들러
function handleProvisionEdit(row) {
  const modal = document.getElementById("provision-edit-modal");

  // reset debug box
  const dbg = document.getElementById("prov-edit-debug");
  const dbgPre = document.getElementById("prov-edit-debug-pre");
  if (dbg) dbg.classList.add("hidden");
  if (dbgPre) dbgPre.textContent = "";

  document.getElementById("prov-edit-id").value = row.id;
  document.getElementById("prov-edit-old-customer-id").value =
    row.customerId || "";
  document.getElementById("prov-edit-new-customer-id").value = "";
  document.getElementById("prov-edit-new-customer-birth").value = "";
  const nameEl = document.getElementById("prov-edit-name");
  if (nameEl) nameEl.value = row.name || "";
  document.getElementById("prov-edit-handler").value = row.handler || "";

  // lookup input reset
  const lookupInput = document.getElementById("prov-customer-search");
  if (lookupInput) lookupInput.value = "";

  if (row.rawTimestamp) {
    const d = row.rawTimestamp.toDate();
    const pad = (n) => (n < 10 ? "0" + n : n);
    const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    document.getElementById("prov-edit-date").value = iso;
  }
  modal.classList.remove("hidden");
}

// 삭제 핸들러
async function handleProvisionDelete(id) {
  if (isAdmin) {
    const ok = await openConfirm({
      title: "삭제 확인",
      message: "정말 이 내역을 삭제하시겠습니까?",
      variant: "danger",
      confirmText: "삭제",
    });
    if (!ok) return;

    try {
      await withLoading(async () => {
        await adminDeleteProvision(id);
        // 상단 카드 즉시 갱신 (stats_daily / provisions 합계)
        invalidateTopStatisticsCaches();
        await renderTopStatistics();
        await calculateMonthlyVisitRate();
        // 새로고침
        const { start, end } = getCurrentProvisionRange();
        await loadProvisionHistoryByRange(start, end);
      }, "삭제 진행 중…");

      showToast("삭제되었습니다.");
    } catch (e) {
      logFirebaseError(e, "adminDeleteProvision");
      showToast(
        `삭제 실패${e?.code ? ` (${e.code})` : ""}: ${e?.message || e}`,
        true,
      );
    }
  } else {
    const ok = await openConfirm({
      title: "삭제 승인 요청",
      message: "관리자 승인이 필요합니다. 삭제 승인을 요청할까요?",
      variant: "warn",
      defaultFocus: "cancel",
    });
    if (!ok) return;

    try {
      const row =
        provisionData?.find((x) => x.id === id) ||
        provisionPageRaw?.find((x) => x.id === id) ||
        null;
      const payload = buildProvisionApprovalPayload(row || { id }, {
        action: "delete",
      });
      await withLoading(
        () =>
          createApprovalRequest({
            type: "provision_delete",
            targetId: id,
            payload,
          }),
        "삭제 승인 요청 전송 중…",
      );
      showToast("삭제 승인 요청이 전송되었습니다.");
      await logEvent("approval_request", {
        approvalType: "provision_delete",
        targetId: id,
        target: payload.displayTarget || null,
        summary: payload.displaySummary || null,
      });
    } catch (e) {
      logFirebaseError(e, "approvals:create provision_delete");
      showToast(
        `요청 실패${e?.code ? ` (${e.code})` : ""}: ${e?.message || e}`,
        true,
      );
    }
  }
}

/* =====================================================
 * Other Tabs Logic (Visit & Life)
 * ===================================================== */
async function loadVisitLogTable(periodKey) {
  // [수정] 스켈레톤 타겟을 tbody로 지정하여 검색창/헤더 유지
  const tbody = document.querySelector("#visit-log-table tbody");
  const cleanup = makeSectionSkeleton(tbody, 10);

  try {
    const q = query(
      collection(db, "visits"),
      where("periodKey", "==", periodKey),
      orderBy("day", "asc"),
    );

    // [수정] 최소 지연 시간 (0.5초) 적용
    const MIN_LOADING_TIME = 500;

    // 데이터 로드(getDocs)와 타이머를 병렬 실행
    const [snap] = await Promise.all([
      getDocs(q),
      new Promise((resolve) => setTimeout(resolve, MIN_LOADING_TIME)),
    ]);

    const byCust = {};
    const ids = new Set();

    snap.forEach((d) => {
      const v = d.data();
      if (!byCust[v.customerId]) {
        byCust[v.customerId] = new Set();
        ids.add(v.customerId);
      }
      const ds = String(v.day).replace(/(\d{4})(\d{2})(\d{2})/, "$1.$2.$3");
      byCust[v.customerId].add(ds);
    });

    // 고객 정보 매핑 (여기는 별도 타이머 없이 이어서 실행)
    const custMap = await fetchCustomersBatched([...ids]);

    visitData = Object.entries(byCust).map(([id, dates]) => ({
      name: custMap[id]?.name || "-",
      birth: custMap[id]?.birth || "-",
      dates: [...dates].sort().join(", "), // 날짜 목록 자체는 오름차순 유지
    }));

    visitCurrentPage = 1;

    // [수정] renderVisitTable 직접 호출 -> filterAndRender 호출 (정렬 적용 위해)
    filterAndRender();
  } catch (e) {
    console.error(e);
  } finally {
    cleanup();
  }
}

// [추가] 방문 기록 정렬 상태 (기본: 이름 오름차순)
let currentVisitSort = { field: "name", dir: "asc" };

function sortVisitData(data) {
  const { field, dir } = currentVisitSort;
  return [...data].sort((a, b) => {
    let valA = a[field] || "";
    let valB = b[field] || "";

    // 1. 최근 방문일 기준 정렬 (dates 필드일 때)
    if (field === "dates") {
      // "2023.01.01, 2023.05.05" -> ["2023.01.01", "2023.05.05"] -> "2023.05.05"
      // 값이 없으면 "" 처리
      const getLastDate = (str) => {
        if (!str) return "";
        const arr = str.split(", ");
        return arr[arr.length - 1]; // 가장 마지막(최신) 날짜 추출
      };

      valA = getLastDate(valA);
      valB = getLastDate(valB);

      // 날짜 문자열(YYYY.MM.DD)은 문자열 비교만으로도 시간순 정렬이 정확히 됨
      if (valA < valB) return dir === "asc" ? -1 : 1;
      if (valA > valB) return dir === "asc" ? 1 : -1;
      return 0;
    }

    // 2. 나머지(이름, 생년월일) 문자열 비교
    valA = String(valA).toLowerCase();
    valB = String(valB).toLowerCase();

    if (valA < valB) return dir === "asc" ? -1 : 1;
    if (valA > valB) return dir === "asc" ? 1 : -1;
    return 0;
  });
}

// [추가] 방문 기록 정렬 아이콘 업데이트
function updateVisitSortIcons() {
  document
    .querySelectorAll("#visit-log-table thead th[data-sort]")
    .forEach((th) => {
      const field = th.dataset.sort;
      const icon = th.querySelector("i");
      if (!icon) return;

      if (currentVisitSort.field === field) {
        icon.className =
          currentVisitSort.dir === "asc"
            ? "fas fa-sort-up text-blue-500"
            : "fas fa-sort-down text-blue-500";
      } else {
        icon.className = "fas fa-sort text-slate-300";
      }
    });
}

async function loadLifeTable() {
  const year = document.getElementById("life-year-select")?.value;
  const q = document.getElementById("life-quarter-select")?.value;
  if (!year || !q) return;

  const key = `${year}-${q}`;
  const tbody = document.querySelector("#life-table tbody");
  const cleanup = makeSectionSkeleton(tbody, 10);

  try {
    const q1 = query(
      collection(db, "provisions"),
      where("lifelove", "==", true),
      where("quarterKey", "==", key),
    );

    const MIN_LOADING_TIME = 500;
    const [snap] = await Promise.all([
      getDocs(q1),
      new Promise((resolve) => setTimeout(resolve, MIN_LOADING_TIME)),
    ]);

    // ✅ 중복 제공을 확인할 수 있도록 "provision 문서 단위"로 그대로 표시
    const ids = new Set();
    snap.forEach((d) => d.data()?.customerId && ids.add(d.data().customerId));
    const custMap = await fetchCustomersBatched([...ids]);

    lifeData = snap.docs.map((docSnap) => {
      const p = docSnap.data() || {};
      const c = custMap[p.customerId] || {};
      const providedAt = p.timestamp?.toDate
        ? formatDateTime(p.timestamp.toDate())
        : "";

      return {
        provId: docSnap.id,
        customerId: p.customerId || "",
        quarterKey: p.quarterKey || key,
        providedAt,
        name: c.name || p.customerName || "-",
        birth: c.birth || p.customerBirth || "-",
        gender: c.gender || p.customerGender || "",
        userType: c.type || "",
        userClass: c.category || "",
      };
    });

    lifeCurrentPage = 1;
    filterAndRender(); // 통합 렌더링 사용
  } catch (e) {
    console.error(e);
  } finally {
    cleanup();
  }
}

// [추가] 생명사랑 해제 핸들러
async function handleLifeDelete(row) {
  if (isAdmin) {
    const ok = await openConfirm({
      title: "생명사랑 내역 삭제",
      message: `[${row.name}] 님의 이번 분기 생명사랑 제공내역을<br>삭제하시겠습니까?`,
      variant: "danger",
      confirmText: "삭제",
    });
    if (!ok) return;

    try {
      if (!row?.provId) {
        showToast("대상(provId)을 찾을 수 없습니다.", true);
        return;
      }
      await adminUnsetLifeloveForProvision({
        provId: row.provId,
        customerId: row.customerId,
        quarterKey: row.quarterKey,
      });

      showToast("삭제되었습니다.");
      loadLifeTable(); // 목록 새로고침
    } catch (e) {
      console.error(e);
      showToast("삭제 실패: " + e.message, true);
    }
  } else {
    // 관리자가 아니면 승인 요청
    const ok = await openConfirm({
      title: "삭제 승인 요청",
      message: "관리자 승인이 필요합니다. 삭제 승인을 요청할까요?",
      variant: "warn",
      defaultFocus: "cancel",
    });
    if (!ok) return;

    try {
      const payload = buildLifeApprovalPayload(row, {
        action: "lifelove_delete",
      });
      await withLoading(
        () =>
          createApprovalRequest({
            type: "lifelove_delete",
            targetId: row.provId,
            payload,
          }),
        "삭제 승인 요청 전송 중…",
      );
      showToast("삭제 승인 요청이 전송되었습니다.");
      await logEvent("approval_request", {
        approvalType: "lifelove_delete",
        targetId: row.provId,
        target: payload.displayTarget || null,
        summary: payload.displaySummary || null,
      });
    } catch (e) {
      showToast("요청 실패", true);
    }
  }
}

// [추가] 생명사랑 정렬 상태
let currentLifeSort = { field: "name", dir: "asc" };

// [추가] 생명사랑 정렬 함수
function sortLifeData(data) {
  const { field, dir } = currentLifeSort;
  return [...data].sort((a, b) => {
    let valA = a[field] || "";
    let valB = b[field] || "";

    valA = String(valA).toLowerCase();
    valB = String(valB).toLowerCase();

    if (valA < valB) return dir === "asc" ? -1 : 1;
    if (valA > valB) return dir === "asc" ? 1 : -1;
    return 0;
  });
}

// [추가] 생명사랑 아이콘 업데이트
function updateLifeSortIcons() {
  document.querySelectorAll("#life-table thead th[data-sort]").forEach((th) => {
    const field = th.dataset.sort;
    const icon = th.querySelector("i");
    if (!icon) return;

    if (currentLifeSort.field === field) {
      icon.className =
        currentLifeSort.dir === "asc"
          ? "fas fa-sort-up text-blue-500"
          : "fas fa-sort-down text-blue-500";
    } else {
      icon.className = "fas fa-sort text-slate-300";
    }
  });
}

async function fetchCustomersBatched(ids) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += 10) chunks.push(ids.slice(i, i + 10));
  for (const chunk of chunks) {
    const snap = await getDocs(
      query(collection(db, "customers"), where(documentId(), "in", chunk)),
    );
    snap.forEach((d) => (out[d.id] = d.data()));
  }
  return out;
}

/* =====================================================
 * Renderers (Table & Empty State)
 * ===================================================== */
function renderProvisionTable(data) {
  const tbody = document.querySelector("#provision-table tbody");
  tbody.innerHTML = "";

  const isServer = !!provCursor.serverMode;

  // 1) Empty State
  if (!data || data.length === 0) {
    renderEmptyState(
      tbody,
      "조건에 맞는 제공 내역이 없습니다.",
      "fa-box-open",
      "검색어를 변경하거나 조회 기간을 수정해보세요.",
    );

    // ✅ serverMode면 pager는 전체 페이지 기준 유지
    if (isServer) {
      renderSimplePager(
        "provision-pagination",
        provCursor.page,
        provCursor.totalPages,
        (n) => {
          const last = provCursor.totalPages;
          const cur = provCursor.page;

          // ✅ extremes first
          if (n === 1) return loadProvisionPage("init");
          if (n === last) return loadProvisionPage("last");

          // ✅ adjacent page only
          if (n === cur + 1) return loadProvisionPage("next");
          if (n === cur - 1) return loadProvisionPage("prev");

          // ✅ 점프(직접 입력 등)는 Firestore cursor 특성상 비용/복잡도 큼 → 안내
          showToast(
            "서버 페이징에서는 1페이지/끝페이지/이전/다음만 지원합니다.",
            true,
          );
        },
      );
    } else {
      renderSimplePager("provision-pagination", 1, 1, () => {});
    }
    // 검색 모드 더보기 버튼 상태
    ensureProvLoadMoreUI(__provSearchMode && !__provAllLoaded);
    return;
  }

  // 2) Pagination Slicing
  let pageData = data;

  if (!isServer) {
    // 메모리 페이징(기존)
    const totalItems = data.length;
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    const start = (provisionCurrentPage - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    pageData = data.slice(start, end);

    renderSimplePager(
      "provision-pagination",
      provisionCurrentPage,
      totalPages,
      (n) => {
        provisionCurrentPage = n;
        renderProvisionTable(data);
      },
    );
  }

  // 3) Row Rendering
  pageData.forEach((r) => {
    const row = r;
    const items = Array.isArray(row.items) ? row.items : [];

    // [계산] 총 수량 및 총 금액 미리 계산
    const totalQty = items.reduce(
      (acc, cur) => acc + (Number(cur.quantity) || 0),
      0,
    );
    // row.totalPrice가 있으면 쓰고, 없으면 items 합계 사용
    const grandTotal =
      row.totalPrice ||
      items.reduce((acc, cur) => acc + (Number(cur.total) || 0), 0);

    items.forEach((item, index) => {
      const tr = document.createElement("tr");
      const isFirst = index === 0;

      const borderClass = isFirst
        ? "border-t border-slate-100 dark:border-slate-700"
        : "border-none";
      tr.className =
        "hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors " +
        borderClass;

      // 숫자 포맷
      const qty = item.quantity ? Number(item.quantity).toLocaleString() : "0";
      const price = item.price ? Number(item.price).toLocaleString() : "0";
      const total = item.total ? Number(item.total).toLocaleString() : "0";
      const lifeBadge =
        isFirst && row.lifelove
          ? `<span class="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200"><i class="fas fa-leaf text-[10px]"></i>생명사랑</span>`
          : "";

      // 메타 데이터 (첫 줄만)
      const dateHtml = isFirst
        ? `<span class="font-bold text-slate-700 dark:text-slate-300 text-[13px]">${row.date}${lifeBadge}</span>`
        : "";
      const nameHtml = isFirst
        ? `<span class="font-bold text-slate-900 dark:text-white">${row.name || "-"}</span>`
        : "";
      const birthHtml = isFirst
        ? `<span class="text-slate-500">${row.birth || "-"}</span>`
        : "";
      const handlerHtml = isFirst
        ? `<span class="badge badge-xs badge-weak-grey">${row.handler || "-"}</span>`
        : "";

      // 관리 버튼
      let actionHtml = "";
      if (isFirst) {
        actionHtml = `
          <div class="flex justify-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button class="btn btn-ghost w-8 h-8 rounded-lg p-0 text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/30 transition-colors btn-edit-prov" title="수정">
              <i class="fas fa-pen text-xs"></i>
            </button>
            <button class="btn btn-ghost w-8 h-8 rounded-lg p-0 text-rose-500 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-900/30 transition-colors btn-del-prov" title="삭제">
              <i class="fas fa-trash text-xs"></i>
            </button>
          </div>
        `;
        tr.classList.add("group");
      }

      tr.innerHTML = `
        <td class="align-top py-3 whitespace-nowrap">${dateHtml}</td>
        <td class="align-top py-3 whitespace-nowrap">${nameHtml}</td>
        <td class="align-top py-3 whitespace-nowrap">${birthHtml}</td>
        <td class="py-3 text-slate-700 dark:text-slate-300 font-medium whitespace-nowrap">${item.name || "-"}</td>
        <td class="py-3 text-right text-slate-600 dark:text-slate-400 whitespace-nowrap">${qty}</td>
        <td class="py-3 text-right text-slate-400 text-xs whitespace-nowrap">${price}</td>
        <td class="py-3 text-right font-bold text-slate-700 dark:text-slate-300 whitespace-nowrap">${total}</td>
        <td class="align-top py-3 whitespace-nowrap text-center">${handlerHtml}</td>
        <td class="align-top py-3 whitespace-nowrap text-center">${actionHtml}</td>
      `;

      if (isFirst) {
        tr.querySelector(".btn-edit-prov")?.addEventListener("click", () =>
          handleProvisionEdit(row),
        );
        tr.querySelector(".btn-del-prov")?.addEventListener("click", () =>
          handleProvisionDelete(row.id),
        );
      }
      tbody.appendChild(tr);
    });

    // 3-2) [추가] 소계(Total) 행 렌더링
    // 모든 아이템 출력 후 마지막에 한 줄 추가
    const sumTr = document.createElement("tr");
    // 배경색을 약간 다르게 하여 구분감 주기
    sumTr.className =
      "bg-slate-50 dark:bg-slate-700/50 border-b border-slate-200 dark:border-slate-600 font-bold text-slate-800 dark:text-slate-100";

    sumTr.innerHTML = `
      <td></td> <td></td> <td></td> <td class="px-3 py-2 text-sm text-right">소계</td> <td class="px-3 py-2 text-sm text-right">${totalQty.toLocaleString()}</td> <td></td> <td class="px-3 py-2 text-sm text-right">${Number(grandTotal).toLocaleString()}</td> <td></td> <td></td> `;
    tbody.appendChild(sumTr);
  });

  // ✅ serverMode pager는 여기서 렌더
  if (isServer) {
    renderSimplePager(
      "provision-pagination",
      provCursor.page,
      provCursor.totalPages,
      (n) => {
        if (n === 1) loadProvisionPage("init");
        else if (n === provCursor.totalPages) loadProvisionPage("last");
        else if (n > provCursor.page) loadProvisionPage("next");
        else if (n < provCursor.page) loadProvisionPage("prev");
      },
    );
  }

  // 검색 모드 더보기 버튼 상태
  ensureProvLoadMoreUI(__provSearchMode && !__provAllLoaded);
}

function renderVisitTable(data) {
  const tbody = document.querySelector("#visit-log-table tbody");
  tbody.innerHTML = "";

  // [수정] Empty State 중앙화
  if (!data || data.length === 0) {
    renderEmptyState(
      tbody,
      "조건에 맞는 방문 기록이 없습니다.",
      "fa-user-slash",
      "검색어를 변경하거나 조회 기간을 수정해보세요.",
    );
    renderSimplePager("visit-pagination", 1, 1, () => {});
    return;
  }

  const start = (visitCurrentPage - 1) * itemsPerPage;
  const pageData = data.slice(start, start + itemsPerPage);

  pageData.forEach((row) => {
    const tr = document.createElement("tr");
    tr.className =
      "hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors";

    // 방문일자 배지화
    const datesArr = (row.dates || "").split(", ");
    // 너무 많으면 줄여서 표시 (예: 5개 + 더보기)
    let datesHtml = datesArr
      .map(
        (d) =>
          `<span class="inline-flex px-2 py-0.5 rounded-md bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 text-xs font-medium mr-1 mb-1">${d}</span>`,
      )
      .join("");

    tr.innerHTML = `
      <td class="font-bold text-slate-900 dark:text-white whitespace-nowrap">${row.name}</td>
      <td class="text-slate-500 whitespace-nowrap">${row.birth}</td>
      <td class="whitespace-nowrap leading-6 min-w-[900px]">${datesHtml}</td>
    `;
    tbody.appendChild(tr);
  });

  const totalPages = Math.ceil(data.length / itemsPerPage);
  renderSimplePager("visit-pagination", visitCurrentPage, totalPages, (n) => {
    visitCurrentPage = n;
    renderVisitTable(data);
  });
}

function renderLifeTable(data) {
  const tbody = document.querySelector("#life-table tbody");
  tbody.innerHTML = "";

  // [수정] Empty State 중앙화
  if (!data || data.length === 0) {
    renderEmptyState(
      tbody,
      "생명사랑 제공 내역이 없습니다.",
      "fa-heartbeat",
      "검색어를 변경하거나 조회 기간을 수정해보세요.",
    );
    renderSimplePager("life-pagination", 1, 1, () => {});
    return;
  }

  const start = (lifeCurrentPage - 1) * itemsPerPage;
  const pageData = data.slice(start, start + itemsPerPage);

  pageData.forEach((row) => {
    const tr = document.createElement("tr");
    tr.className =
      "hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors group"; // group 추가

    // [추가] 삭제 버튼
    const actionHtml = `
      <div class="flex justify-center opacity-0 group-hover:opacity-100 transition-opacity">
        <button class="btn btn-ghost w-8 h-8 rounded-lg p-0 text-rose-500 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-900/30 transition-colors btn-del-life" title="생명사랑 해제">
          <i class="fas fa-trash text-xs"></i>
        </button>
      </div>
    `;

    tr.innerHTML = `
      <td class="whitespace-nowrap py-3">
        <div class="flex flex-col leading-tight">
          <span class="font-bold text-slate-900 dark:text-white">${row.name}</span>
          ${
            row.providedAt
              ? `<span class="text-xs text-slate-400 dark:text-slate-500 mt-1">${row.providedAt}</span>`
              : ""
          }
        </div>
      </td>
      <td class="text-slate-500 whitespace-nowrap py-3">${row.birth}</td>
      <td class="whitespace-nowrap py-3"><span class="text-sm text-slate-600 dark:text-slate-400">${row.gender || "-"}</span></td>
      <td class="whitespace-nowrap py-3"><span class="badge badge-sm badge-weak-primary">${row.userType || "-"}</span></td>
      <td class="whitespace-nowrap py-3"><span class="badge badge-sm badge-weak-success">${row.userClass || "-"}</span></td>
      <td class="whitespace-nowrap py-3 text-center">${actionHtml}</td>
    `;

    // 이벤트 연결
    tr.querySelector(".btn-del-life")?.addEventListener("click", () =>
      handleLifeDelete(row),
    );

    tbody.appendChild(tr);
  });

  const totalPages = Math.ceil(data.length / itemsPerPage);
  renderSimplePager("life-pagination", lifeCurrentPage, totalPages, (n) => {
    lifeCurrentPage = n;
    renderLifeTable(data); // 정렬된 데이터 유지
  });
}

/* =====================================================
 * Event Binding & Init
 * ===================================================== */
function bindProvisionEvents() {
  // Sort Headers Click Event
  document
    .querySelectorAll("#provision-table thead th[data-sort]")
    .forEach((th) => {
      th.addEventListener("click", () => {
        const field = th.dataset.sort;

        // 정렬 방향 토글
        if (currentProvSort.field === field) {
          currentProvSort.dir = currentProvSort.dir === "asc" ? "desc" : "asc";
        } else {
          currentProvSort.field = field;
          currentProvSort.dir = "asc";
        }

        // [핵심] 정렬 -> 필터 -> 렌더링 파이프라인 재실행
        // (현재 페이지는 1페이지로 리셋하거나 유지할 수 있음. 보통 정렬 바뀌면 1페이지로 감)
        // filterAndRender 내부에서 provisionCurrentPage 로직 확인 필요
        filterAndRender();
      });
    });

  // ... (기존 수정/삭제 모달 이벤트 핸들러 유지) ...
  // Edit Save, Modal Close 등 기존 코드 그대로 사용
  document
    .getElementById("prov-edit-save")
    ?.addEventListener("click", async () => {
      const modal = document.getElementById("provision-edit-modal");
      const id = document.getElementById("prov-edit-id")?.value;
      const handler =
        document.getElementById("prov-edit-handler")?.value?.trim() || "";
      const oldCustomerId =
        document.getElementById("prov-edit-old-customer-id")?.value || "";
      const newCustomerId =
        document.getElementById("prov-edit-new-customer-id")?.value || "";
      const newCustomerBirth =
        document.getElementById("prov-edit-new-customer-birth")?.value || "";
      const newCustomerName =
        document.getElementById("prov-edit-name")?.value || "";

      if (!id) return showToast("대상을 찾을 수 없습니다.", true);

      // 변경 사항이 전혀 없으면 종료
      const baseRow =
        provisionData?.find((x) => x.id === id) ||
        provisionPageRaw?.find((x) => x.id === id) ||
        null;

      const oldHandler = String(
        baseRow?.handler || baseRow?.handledBy || "",
      ).trim();
      const oldBirth = String(
        baseRow?.birth || baseRow?.customerBirth || "",
      ).trim();

      const hasCustomerChange =
        !!newCustomerId && newCustomerId !== oldCustomerId;

      // 같은 이용자를 다시 선택한 경우(예: 생년월일 보정 등)만 변경으로 취급
      const hasCustomerReselectSame =
        !!newCustomerId &&
        newCustomerId === oldCustomerId &&
        !!newCustomerBirth &&
        String(newCustomerBirth).trim() !== oldBirth;

      const hasHandlerChange =
        !!handler && String(handler).trim() !== oldHandler;

      if (!hasCustomerChange && !hasCustomerReselectSame && !hasHandlerChange) {
        return showToast("변경 내용이 없습니다.", true);
      }

      // 일반 사용자 → 승인 요청
      if (!isAdmin) {
        const ok = await openConfirm({
          title: "수정 승인 요청",
          message: "관리자 승인이 필요합니다. 수정 승인을 요청할까요?",
          variant: "warn",
          defaultFocus: "cancel",
        });
        if (!ok) return;

        try {
          const payload = {
            ...buildProvisionApprovalPayload(baseRow || { id }, {
              action: "update",
              requestedHandler: handler,
              oldCustomerId,
              newCustomerId,
              newCustomerName,
              newCustomerBirth,
            }),
            // admin apply 편의 필드
            handler,
            oldCustomerId,
            newCustomerId,
            newCustomerName,
            newCustomerBirth,
          };
          await withLoading(
            () =>
              createApprovalRequest({
                type: "provision_update",
                targetId: id,
                payload,
              }),
            "수정 승인 요청 전송 중…",
          );
          showToast("수정 승인 요청이 전송되었습니다.");
          await logEvent("approval_request", {
            approvalType: "provision_update",
            targetId: id,
            target: payload.displayTarget || null,
            summary: payload.displaySummary || null,
          });
          modal?.classList.add("hidden");
        } catch (e) {
          logFirebaseError(e, "approvals:create provision_update");
          showToast(
            `요청 실패${e?.code ? ` (${e.code})` : ""}: ${e?.message || e}`,
            true,
          );
        }
        return;
      }

      // 관리자 → 즉시 반영
      try {
        await withLoading(async () => {
          await adminApplyProvisionEdit({
            provisionId: id,
            handler,
            oldCustomerId,
            newCustomerId,
            newCustomerName,
            newCustomerBirth,
          });

          invalidateTopStatisticsCaches();
          await renderTopStatistics();
          await calculateMonthlyVisitRate();

          // 새로고침
          const { start, end } = getCurrentProvisionRange();
          await loadProvisionHistoryByRange(start, end);
        }, "수정 내용을 반영 중…");

        showToast("수정 저장 완료");
        modal?.classList.add("hidden");
      } catch (e) {
        logFirebaseError(e, "adminApplyProvisionEdit");
        showToast(
          `수정 실패${e?.code ? ` (${e.code})` : ""}: ${e?.message || e}`,
          true,
        );
      }
    });

  document.getElementById("prov-edit-close")?.addEventListener("click", () => {
    document.getElementById("provision-edit-modal").classList.add("hidden");
  });
}

function bindVisitEvents() {
  // Visit Table Header Click
  document
    .querySelectorAll("#visit-log-table thead th[data-sort]")
    .forEach((th) => {
      th.addEventListener("click", () => {
        const field = th.dataset.sort;
        if (currentVisitSort.field === field) {
          currentVisitSort.dir =
            currentVisitSort.dir === "asc" ? "desc" : "asc";
        } else {
          currentVisitSort.field = field;
          currentVisitSort.dir = "asc";
        }
        // 정렬 상태 변경 후 재렌더링
        filterAndRender();
      });
    });
}

function bindLifeEvents() {
  // 헤더 정렬 클릭
  document.querySelectorAll("#life-table thead th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const field = th.dataset.sort;
      if (currentLifeSort.field === field) {
        currentLifeSort.dir = currentLifeSort.dir === "asc" ? "desc" : "asc";
      } else {
        currentLifeSort.field = field;
        currentLifeSort.dir = "asc";
      }
      filterAndRender(); // 통합 렌더링 호출
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  onAuthStateChanged(auth, async (user) => {
    await applyRoleFromUser(user);
    const today = moment();
    renderTopStatistics();
    calculateMonthlyVisitRate();
    loadProvisionHistoryByRange(today.toDate(), today.toDate());
    loadVisitLogTable(getCurrentPeriodKey());
    updateFieldOptions("provision");
  });

  const startDateInput = $("#start-date-input");
  const endDateInput = $("#end-date-input");
  const today = moment();

  const ranges = {
    오늘: [moment(), moment()],
    어제: [moment().subtract(1, "days"), moment().subtract(1, "days")],
    "최근 7일": [moment().subtract(6, "days"), moment()],
    "이번 달": [moment().startOf("month"), moment().endOf("month")],
    "지난 달": [
      moment().subtract(1, "month").startOf("month"),
      moment().subtract(1, "month").endOf("month"),
    ],
  };

  const pickerOptions = {
    autoApply: true,
    autoUpdateInput: false,
    ranges: ranges,
    alwaysShowCalendars: true,
    showDropdowns: true,
    opens: "left",
    locale: {
      format: "YYYY.MM.DD",
      separator: " ~ ",
      applyLabel: "확인",
      cancelLabel: "취소",
      fromLabel: "From",
      toLabel: "To",
      customRangeLabel: "직접 선택",
      weekLabel: "주",
      daysOfWeek: ["일", "월", "화", "수", "목", "금", "토"],
      monthNames: [
        "1월",
        "2월",
        "3월",
        "4월",
        "5월",
        "6월",
        "7월",
        "8월",
        "9월",
        "10월",
        "11월",
        "12월",
      ],
      firstDay: 0,
    },
    startDate: today,
    endDate: today,
  };

  startDateInput.daterangepicker(pickerOptions);
  endDateInput.on("click", () => startDateInput.data("daterangepicker").show());

  startDateInput.on("apply.daterangepicker", function (ev, picker) {
    const s = picker.startDate.format("YYYY.MM.DD");
    const e = picker.endDate.format("YYYY.MM.DD");
    startDateInput.val(s);
    endDateInput.val(e);

    // ✅ 기간 변경 시 검색창 초기화(검색어 때문에 "0건"으로 오해 방지)
    clearUnifiedSearchInputs();
    loadProvisionHistoryByRange(
      picker.startDate.toDate(),
      picker.endDate.toDate(),
    );
  });

  startDateInput.val(today.format("YYYY.MM.DD"));
  endDateInput.val(today.format("YYYY.MM.DD"));

  // Tab & Filters
  const tabBtns = document.querySelectorAll(".tab-item");
  const sections = {
    provision: document.getElementById("provision-section"),
    visit: document.getElementById("visit-log-section"),
    life: document.getElementById("life-section"),
  };
  const filters = {
    provision: document.getElementById("filter-provision"),
    visit: document.getElementById("filter-visit"),
    life: document.getElementById("filter-life"),
  };

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      tabBtns.forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");

      // 섹션 및 필터 토글
      Object.keys(sections).forEach((k) => sections[k].classList.add("hidden"));
      Object.keys(filters).forEach(
        (k) => filters[k] && filters[k].classList.add("hidden"),
      );

      sections[target].classList.remove("hidden");
      if (filters[target]) filters[target].classList.remove("hidden");

      // [추가] 탭 변경 시 검색창 및 에러 상태 초기화
      const gSearch = document.getElementById("global-search");
      const fSearch = document.getElementById("field-search");
      const exactChk = document.getElementById("exact-match");

      if (gSearch) gSearch.value = "";
      if (fSearch) fSearch.value = "";
      if (exactChk) exactChk.checked = false;

      // 에러 메시지 숨김 (toggleSearchError 함수 재사용)
      toggleSearchError("global-search-group", false);
      toggleSearchError("field-search-group", false);

      // 필드 옵션 업데이트 (이 과정에서 select 박스도 초기화됨)
      updateFieldOptions(target);

      // 각 탭별 데이터 로드 (초기화된 상태로 로드)
      if (target === "provision") {
        // Provision 탭으로 돌아올 때 현재 검색 조건 없이 페이징 유지 혹은 초기화
        // 여기서는 필터가 비워졌으므로 전체 목록을 다시 보여주게 됩니다.
        if (provCursor.serverMode) {
          // 서버 모드일 경우 검색어 없이 현재 페이지 리로드 (또는 1페이지로 리셋)
          // 여기선 필터링 없이 렌더링만 호출하면 filterAndRender 내부에서 빈 값을 읽어 전체 목록을 표시함
          filterAndRender();
        } else {
          renderProvisionTable(provisionData);
        }
      } else if (target === "visit") {
        loadVisitLogTable(document.getElementById("fiscal-year-select")?.value);
      } else if (target === "life") {
        loadLifeTable();
      }
    });
  });

  // Select Filters
  const fiscalSel = document.getElementById("fiscal-year-select");
  if (fiscalSel) {
    getFiscalPeriodKeys(6).forEach((k) => {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = k;
      fiscalSel.appendChild(o);
    });
    fiscalSel.addEventListener("change", () =>
      {
        // ✅ 조회기간 변경 시 검색창 초기화
        clearUnifiedSearchInputs();
        loadVisitLogTable(fiscalSel.value);
      },

    );
  }

  const lifeYearSel = document.getElementById("life-year-select");
  const lifeQuarterSel = document.getElementById("life-quarter-select");
  if (lifeYearSel) {
    const curY = new Date().getFullYear();
    for (let y = curY; y >= curY - 5; y--) {
      const o = document.createElement("option");
      o.value = y;
      o.textContent = y;
      lifeYearSel.appendChild(o);
    }
    lifeYearSel.value = curY;
    const m = new Date().getMonth() + 1;
    const q = m <= 3 ? "Q1" : m <= 6 ? "Q2" : m <= 9 ? "Q3" : "Q4";
    if (lifeQuarterSel) lifeQuarterSel.value = q;

   // ✅ 연도/분기 변경 시 검색창 초기화(남아있는 검색어로 0건 오해 방지)
    lifeYearSel.addEventListener("change", () => {
      clearUnifiedSearchInputs();
      loadLifeTable();
    });
    lifeQuarterSel.addEventListener("change", () => {
      clearUnifiedSearchInputs();
      loadLifeTable();
    });
  }

  // Page Size
  document
    .getElementById("item-count-select")
    ?.addEventListener("change", (e) => {
      itemsPerPage = parseInt(e.target.value, 10);
      const activeTab = document.querySelector(".tab-item.is-active")?.dataset
        .tab;
      if (activeTab === "provision") {
        if (provCursor.serverMode) {
          provCursor.page = 1;
          provCursor.firstDoc = null;
          provCursor.lastDoc = null;
          computeProvisionTotalPages().then(() => loadProvisionPage("init"));
        } else {
          provisionCurrentPage = 1;
          renderProvisionTable(provisionData);
        }
      } else if (activeTab === "visit") {
        visitCurrentPage = 1;
        renderVisitTable(visitData);
      } else {
        lifeCurrentPage = 1;
        renderLifeTable(lifeData);
      }
    });

  // Search
  const debouncedFilter = debounce(filterAndRender, 220);
  document.getElementById("global-search")?.addEventListener("input", (e) => {
    toggleSearchError("global-search-group", false);
    debouncedFilter();
  });
  document.getElementById("field-search")?.addEventListener("input", (e) => {
    toggleSearchError("field-search-group", false);
    debouncedFilter();
  });
  document
    .getElementById("btn-run-search")
    ?.addEventListener("click", runProvisionSearchIfNeeded);
  document
    .getElementById("btn-run-field-search")
    ?.addEventListener("click", runProvisionSearchIfNeeded);
  document
    .getElementById("exact-match")
    ?.addEventListener("change", filterAndRender);
  document
    .getElementById("field-select")
    ?.addEventListener("change", filterAndRender);

  // ✅ Enter로 검색 실행(Provision 탭은 기간 내 검색 A안 적용)
  const onSearchEnter = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runProvisionSearchIfNeeded();
    }
  };
  document
    .getElementById("global-search")
    ?.addEventListener("keydown", onSearchEnter);
  document
    .getElementById("field-search")
    ?.addEventListener("keydown", onSearchEnter);

  document
    .getElementById("toggle-advanced-search")
    ?.addEventListener("click", () => {
      const adv = document.getElementById("advanced-search");
      adv.classList.toggle("hidden");
      const btn = document.getElementById("toggle-advanced-search");
      btn.innerHTML = adv.classList.contains("hidden")
        ? "상세 검색"
        : "상세 검색 닫기";
    });

  // Export & Modal
  document
    .getElementById("export-provision")
    ?.addEventListener("click", exportProvisionRangeExcel);
  document
    .getElementById("export-visit")
    ?.addEventListener("click", () => exportVisitExcel(visitData));
  document
    .getElementById("export-life")
    ?.addEventListener("click", () => exportLifeExcel(lifeData));

  document
    .getElementById("daily-visitors")
    ?.addEventListener("click", () => openMonthlyDailyModal(new Date()));
  document
    .getElementById("monthly-daily-close")
    ?.addEventListener("click", () =>
      document.getElementById("monthly-daily-modal").classList.add("hidden"),
    );
  document
    .getElementById("monthly-daily-prev")
    ?.addEventListener("click", () => moveModalMonth(-1));
  document
    .getElementById("monthly-daily-next")
    ?.addEventListener("click", () => moveModalMonth(1));
  document
    .getElementById("monthly-daily-input")
    ?.addEventListener("change", (e) => {
      const [y, m] = e.target.value.split("-");
      openMonthlyDailyModal(new Date(y, m - 1, 1));
    });
  bindProvisionEvents();
  bindProvisionEditCustomerLookup();
  bindVisitEvents();
  bindLifeEvents();
});

// ===== Provision Search (A안): 기간 내 검색 실행/복귀 =====
async function runProvisionSearchIfNeeded() {
  const activeTab =
    document.querySelector(".tab-item.is-active")?.dataset.tab || "provision";
  if (activeTab !== "provision") {
    filterAndRender();
    return;
  }

  const globalQ = normalize(document.getElementById("global-search")?.value);
  const fieldQ = normalize(document.getElementById("field-search")?.value);
  const hasSearch = !!(globalQ || fieldQ);

  // 기간이 바뀌었는데 rangeKey가 안 맞으면 리셋
  const key = getProvRangeKey();
  if (__provRangeKey && __provRangeKey !== key) {
    resetProvisionRangeCache();
  }

  // 검색 없음: serverMode로 복귀(기존 페이지 기준)
  if (!hasSearch) {
    __provSearchMode = false;
    __provAllLoaded = false;
    __provLastDocForRange = null;
    allProvisionData = [];
    provCursor.serverMode = true;
    ensureProvLoadMoreUI(false);
    // 현재 페이지 기준 렌더
    filterAndRender();
    return;
  }

  // 검색 있음: 기간 내 로드(1000건) 후 client filtering 모드로 전환
  await withLoading(async () => {
    // 최초 진입 시 1000건 로드
    if (!__provSearchMode) {
      __provSearchMode = true;
      provCursor.serverMode = false; // 메모리(로드된 범위) 기반 렌더
      __provRangeKey = key;
      __provAllLoaded = false;
      __provLastDocForRange = null;
      allProvisionData = [];
      provisionCurrentPage = 1;
      await loadMoreProvisionRange(PROV_SEARCH_BATCH);
    }
  }, "선택 기간 내 제공 내역 불러오는 중…");

  provisionCurrentPage = 1;
  filterAndRender();
}

function getProvisionFilteredSorted(list) {
  const globalQ = normalize(document.getElementById("global-search")?.value);
  const fieldQ = normalize(document.getElementById("field-search")?.value);
  const field = document.getElementById("field-select")?.value;
  const exact = document.getElementById("exact-match")?.checked;

  let filtered = (list || []).filter((item) => {
    // Global Search
    const allValues = Object.values(item).flatMap((v) =>
      Array.isArray(v) ? v.map((i) => `${i.name}${i.quantity}`) : String(v),
    );
    const matchGlobal =
      !globalQ || allValues.some((v) => normalize(v).includes(globalQ));

    // Field Search
    let matchField = true;
    if (fieldQ && field) {
      const val = item[field];
      if (val == null) matchField = false;
      else {
        const normalized = normalize(val);
        matchField = exact
          ? normalized === fieldQ
          : normalized.includes(fieldQ);
      }
    }
    return matchGlobal && matchField;
  });

  filtered = sortProvisionData(filtered);
  return filtered;
}

async function exportProvisionRangeExcel() {
  // 기본: 기간 내 전체 데이터 / 검색 중: 기간 내 검색결과 전체
  await withLoading(async () => {
    // 1) 기간 전체를 끝까지 로드(1000 제한 없음)
    const batch = 1000;
    const out = [];
    let lastDoc = null;

    while (true) {
      const base = [
        where("timestamp", ">=", provCursor.startTs),
        where("timestamp", "<=", provCursor.endTs),
        orderBy("timestamp", "asc"),
        limit(batch),
      ];
      const qy = lastDoc
        ? query(collection(db, "provisions"), ...base, startAfter(lastDoc))
        : query(collection(db, "provisions"), ...base);

      const snap = await getDocs(qy);
      if (snap.empty) break;
      const docs = snap.docs;
      out.push(...docs.map(processProvisionDoc));
      lastDoc = docs[docs.length - 1];
      if (docs.length < batch) break;
    }

    // 2) 현재 검색 조건이 있으면 필터 적용
    const hasSearch = isProvisionClientFilteringOn();
    const rows = hasSearch
      ? getProvisionFilteredSorted(out)
      : sortProvisionData(out);

    // 3) 엑셀 생성
    await exportProvisionExcel(rows);
  }, "엑셀 파일 생성 중…");
}

// Core Filter & Sort Logic
function filterAndRender() {
  // 1. 탭 확인
  const activeTab =
    document.querySelector(".tab-item.is-active")?.dataset.tab || "provision";

  // 2. 검색어 가져오기
  const globalInput = document.getElementById("global-search");
  const fieldInput = document.getElementById("field-search");
  const globalQ = normalize(globalInput?.value);
  const fieldSelect = document.getElementById("field-select");
  const field = fieldSelect?.value;
  const fieldQ = normalize(fieldInput?.value);
  const exact = document.getElementById("exact-match")?.checked;

  // 에러 메시지 초기화
  toggleSearchError("global-search-group", false);
  toggleSearchError("field-search-group", false);

  // 3. Provision 탭 로직
  if (activeTab === "provision") {
    const isServer = !!provCursor.serverMode;

    // ✅ 검색 모드(A안): 기간 내(로드된 범위) 데이터에서 필터/정렬
    if (__provSearchMode && !isServer) {
      const filteredSorted = getProvisionFilteredSorted(allProvisionData);
      provisionData = filteredSorted;
      const totalPages = Math.max(
        1,
        Math.ceil(provisionData.length / itemsPerPage),
      );
      if (provisionCurrentPage > totalPages) provisionCurrentPage = 1;
      renderProvisionTable(provisionData);
      updateProvSortIcons();

      // 빈 결과 에러 UI(기존 UX 유지)
      if (provisionData.length === 0 && globalQ) {
        toggleSearchError("global-search-group", true);
      }
      return;
    }

    // ✅ 서버 페이징 모드(기본): 현재 페이지(provisionPageRaw)만 대상으로 필터/정렬
    if (isServer) {
      let filtered = (provisionPageRaw || []).filter((item) => {
        // Global Search
        const allValues = Object.values(item).flatMap((v) =>
          Array.isArray(v) ? v.map((i) => `${i.name}${i.quantity}`) : String(v),
        );
        const matchGlobal =
          !globalQ || allValues.some((v) => normalize(v).includes(globalQ));

        // Field Search
        let matchField = true;
        if (fieldQ && field) {
          const val = item[field];
          if (val == null) matchField = false;
          else {
            const normalized = normalize(val);
            matchField = exact
              ? normalized === fieldQ
              : normalized.includes(fieldQ);
          }
        }
        return matchGlobal && matchField;
      });

      // 정렬(현재 페이지 내 정렬)
      provisionData = sortProvisionData(filtered);

      // 렌더 + 정렬 아이콘
      renderProvisionTable(provisionData);
      updateProvSortIcons();

      // 빈 결과 시 에러 UI(기존 UX 유지)
      if (provisionData.length === 0 && globalQ) {
        toggleSearchError("global-search-group", true);
      }
      return;
    }

    // (구) 메모리 모드 유지(혹시 fallback 필요 시)
    let filtered = allProvisionData.filter((item) => {
      const allValues = Object.values(item).flatMap((v) =>
        Array.isArray(v) ? v.map((i) => `${i.name}${i.quantity}`) : String(v),
      );
      const matchGlobal =
        !globalQ || allValues.some((v) => normalize(v).includes(globalQ));

      let matchField = true;
      if (fieldQ && field) {
        const val = item[field];
        if (val == null) matchField = false;
        else {
          const normalized = normalize(val);
          matchField = exact
            ? normalized === fieldQ
            : normalized.includes(fieldQ);
        }
      }
      return matchGlobal && matchField;
    });

    provisionData = sortProvisionData(filtered);

    const totalPages = Math.max(
      1,
      Math.ceil(provisionData.length / itemsPerPage),
    );
    if (provisionCurrentPage > totalPages) provisionCurrentPage = 1;

    renderProvisionTable(provisionData);
    updateProvSortIcons();
    return;
  }

  // 4. Visit / Life 탭 로직 (기존 유지)
  if (activeTab === "visit") {
    visitCurrentPage = 1;

    let filtered = visitData.filter(
      (v) => !globalQ || normalize(v.name).includes(globalQ),
    );

    filtered = sortVisitData(filtered);
    renderVisitTable(filtered);
    updateVisitSortIcons();

    if (filtered.length === 0 && globalQ) {
      toggleSearchError("global-search-group", true);
    }
  } else {
    lifeCurrentPage = 1;

    let filtered = lifeData.filter((item) => {
      const allValues = Object.values(item).flatMap((v) =>
        Array.isArray(v) ? v.map((i) => `${i.name}${i.quantity}`) : String(v),
      );
      const matchGlobal =
        !globalQ || allValues.some((v) => normalize(v).includes(globalQ));

      let matchField = true;
      if (fieldQ && field) {
        const val = item[field];
        if (val == null) matchField = false;
        else {
          const normalized = normalize(val);
          matchField = exact
            ? normalized === fieldQ
            : normalized.includes(fieldQ);
        }
      }
      return matchGlobal && matchField;
    });

    filtered = sortLifeData(filtered);
    renderLifeTable(filtered);
    updateLifeSortIcons();

    if (filtered.length === 0 && globalQ) {
      toggleSearchError("global-search-group", true);
    }
  }
}

// Field Defs
const FIELD_DEFINITIONS = {
  provision: [
    { value: "", text: "선택 안함" },
    { value: "date", text: "제공일" },
    { value: "name", text: "고객명" },
    { value: "birth", text: "생년월일" },
    { value: "items", text: "가져간 품목" },
    { value: "handler", text: "처리자" },
  ],
  visit: [
    { value: "", text: "선택 안함" },
    { value: "name", text: "고객명" },
    { value: "birth", text: "생년월일" },
    { value: "dates", text: "방문일자 목록" },
  ],
  life: [
    { value: "", text: "선택 안함" },
    { value: "name", text: "성명" },
    { value: "birth", text: "생년월일" },
    { value: "gender", text: "성별" },
    { value: "userType", text: "이용자구분" },
    { value: "userClass", text: "이용자분류" },
  ],
};

function updateFieldOptions(tabName) {
  const select = document.getElementById("field-select");
  if (!select) return;
  const options = FIELD_DEFINITIONS[tabName] || FIELD_DEFINITIONS.provision;
  select.innerHTML = options
    .map((opt) => `<option value="${opt.value}">${opt.text}</option>`)
    .join("");
}

/* =====================================================
 * Top Statistics Helpers
 * ===================================================== */
async function renderTopStatistics() {
  const cardIds = ["daily-visitors", "daily-items", "monthly-visitors"];
  const cleanups = cardIds.map((id) =>
    makeStatCardSkeleton(document.getElementById(id)),
  );

  try {
    const now = new Date();
    // ✅ 영업일 기준: 오늘이 비영업일이면 가장 가까운 이전 영업일 데이터를 "기준일"로 표시
    const refDay = await nearestPrevBusinessDayKst(now);
    const prevDay = await prevBusinessDayKst(refDay);

    const refKey = String(toDayNumber(refDay)); // YYYYMMDD (KST)
    const prevKey = String(toDayNumber(prevDay)); // YYYYMMDD (KST)

    // 1) 방문자(기존 캐시/로직 유지) + 2) 월합계(기존) + 3) stats_daily(오늘/어제) 단건 읽기
    const [tCnt, yCnt, mCnt, tStatsSnap, yStatsSnap] = await Promise.all([
      getDailyVisitorsCount(db, refDay),
      getDailyVisitorsCount(db, prevDay),
      getMonthlyVisitorsFromStatsDaily(refDay),
      getDoc(doc(db, "stats_daily", refKey)),
      getDoc(doc(db, "stats_daily", prevKey)),
    ]);

    // 방문자 카드
    updateCard("#daily-visitors", tCnt, yCnt, "명");

    // 월간 방문자(이 카드는 기존 코드처럼 값만 표시)
    const monthlyEl = document.querySelector("#monthly-visitors .value");
    if (monthlyEl) monthlyEl.textContent = `${mCnt.toLocaleString()}명`;

    // --- itemsTotalQty/topItems20: stats_daily에서 우선 읽고, 없으면 (이행기간) 해당 날짜만 fallback 스캔 ---
    const readItemsFromStats = (snap) => {
      if (!snap || !snap.exists()) return { qty: null, top: [] };
      const data = snap.data() || {};
      const qty =
        typeof data.itemsTotalQty === "number" ? data.itemsTotalQty : null;
      const top = Array.isArray(data.topItems20) ? data.topItems20 : [];
      return { qty, top };
    };

    let { qty: tItems, top: tTop20 } = readItemsFromStats(tStatsSnap);
    let { qty: yItems } = readItemsFromStats(yStatsSnap);

    // fallback 스캔(오늘/어제 중 누락된 쪽만) - provision.js 누적 저장 적용 후엔 거의 실행되지 않음
    const scanItemsTotalQtyByDate = async (d) => {
      const start = kstStartOfDay(d);
      const end = kstEndOfDay(d);

      const snap = await getDocs(
        query(
          collection(db, "provisions"),
          where("timestamp", ">=", Timestamp.fromDate(start)),
          where("timestamp", "<=", Timestamp.fromDate(end)),
        ),
      );

      let sum = 0;
      snap.forEach((docSnap) => {
        const items = docSnap.data()?.items || [];
        for (const it of items) sum += Number(it.quantity || 0);
      });
      return sum;
    };

    try {
      // ✅ undefined 변수(today/yest) 대신 refDay/prevDay 사용
      if (tItems === null) tItems = await scanItemsTotalQtyByDate(refDay);
      if (yItems === null) yItems = await scanItemsTotalQtyByDate(prevDay);
    } catch (e) {
      // fallback도 실패하면 0으로라도 표시
      if (tItems === null) tItems = 0;
      if (yItems === null) yItems = 0;
    }

    // 물품 카드(총 수량 + 전일 대비)
    updateCard("#daily-items", tItems, yItems, "개");
  } catch (e) {
    console.error("Top stats error:", e);
  } finally {
    cleanups.forEach((cleanup) => cleanup && cleanup());
  }
}

async function getDailyVisitorsCount(db, date) {
  const day = toDayNumber(date); // ✅ KST 기준
  try {
    const s = await getDoc(doc(db, "stats_daily", String(day)));
    if (s.exists()) return s.data().uniqueVisitors || 0;
  } catch (e) {}
  return 0;
}

const __statsDailyMonthCache = { key: null, sum: null };

// 상단 카드 월간 합계 캐시 무효화
function invalidateTopStatisticsCaches() {
  __statsDailyMonthCache.key = null;
  __statsDailyMonthCache.sum = null;
}

async function getMonthlyVisitorsFromStatsDaily(baseDate = new Date()) {
  const mkey = `${baseDate.getFullYear()}-${baseDate.getMonth()}`;
  if (
    __statsDailyMonthCache.key === mkey &&
    __statsDailyMonthCache.sum != null
  ) {
    return __statsDailyMonthCache.sum;
  }
  // ✅ KST 기준 월 범위: docId(YYYYMMDD) range query로 합산 (in 10개 반복 제거)
  const { y, m } = toKstDateParts(baseDate);
  const start = toDayNumberKst(
    new Date(Date.UTC(y, m - 1, 1, 12) - KST_OFFSET_MS),
  );
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  const endDate = new Date(Date.UTC(next.y, next.m - 1, 1, 12) - KST_OFFSET_MS);
  const end = toDayNumberKst(addDaysKst(endDate, -1));

  const snap = await getDocs(
    query(
      collection(db, "stats_daily"),
      where(documentId(), ">=", String(start)),
      where(documentId(), "<=", String(end)),
    ),
  );
  let sum = 0;
  snap.forEach((ds) => (sum += Number(ds.data()?.uniqueVisitors || 0)));
  __statsDailyMonthCache.key = mkey;
  __statsDailyMonthCache.sum = sum;
  return sum;
}

function makeStatCardSkeleton(container) {
  if (!container) return null;
  const originalPos = container.style.position;
  if (getComputedStyle(container).position === "static")
    container.style.position = "relative";
  const wrap = document.createElement("div");
  wrap.className =
    "absolute inset-0 z-10 bg-white dark:bg-slate-800 rounded-[inherit] flex flex-col items-center justify-center p-6";
  wrap.innerHTML = `
    <div class="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-700 mb-3 animate-pulse"></div>
    <div class="h-3 w-20 bg-slate-100 dark:bg-slate-700 rounded mb-3 animate-pulse"></div>
    <div class="h-8 w-24 bg-slate-100 dark:bg-slate-700 rounded mb-3 animate-pulse"></div>
    <div class="h-3 w-32 bg-slate-50 dark:bg-slate-700/50 rounded animate-pulse"></div>`;
  container.appendChild(wrap);
  return () => {
    wrap.remove();
    container.style.position = originalPos;
  };
}

function updateCard(sel, val, prev, unit) {
  const el = document.querySelector(sel);
  if (!el) return;
  el.querySelector(".value").textContent = `${val.toLocaleString()}${unit}`;
  const diff = val - prev;
  const pct = prev > 0 ? ((diff / prev) * 100).toFixed(1) : 0;
  const changeEl = el.querySelector(".change");
  if (diff > 0)
    changeEl.innerHTML = `<span class="text-rose-500">▲ ${diff.toLocaleString()}${unit} (${pct}%)</span> 증가`;
  else if (diff < 0)
    changeEl.innerHTML = `<span class="text-blue-500">▼ ${Math.abs(diff).toLocaleString()}${unit} (${Math.abs(pct)}%)</span> 감소`;
  else changeEl.innerHTML = `<span class="text-slate-400">- 변동 없음</span>`;
}

async function calculateMonthlyVisitRate() {
  const now = new Date();
  const mCnt = await getMonthlyVisitorsFromStatsDaily(now);
  const snap = await getCountFromServer(
    query(collection(db, "customers"), where("status", "==", "지원")),
  );
  const total = snap.data().count || 1;
  const rate = ((mCnt / total) * 100).toFixed(1);
  const card = document.getElementById("monthly-visitors");
  if (!card.querySelector(".sub-info")) {
    const p = document.createElement("p");
    p.className = "sub-info text-xs text-slate-500 mt-2 font-medium";
    p.innerHTML = `<i class="fas fa-chart-pie mr-1"></i> 방문률: <span class="text-indigo-600 font-bold">${rate}%</span>`;
    card.appendChild(p);
  }
}

// Modal: Monthly Daily
let __modalMonth = null;
async function openMonthlyDailyModal(date) {
  __modalMonth = new Date(date.getFullYear(), date.getMonth(), 1);
  const mInput = document.getElementById("monthly-daily-input");
  if (mInput)
    mInput.value = `${__modalMonth.getFullYear()}-${String(__modalMonth.getMonth() + 1).padStart(2, "0")}`;
  await refreshMonthlyModal();
  document.getElementById("monthly-daily-modal").classList.remove("hidden");
}

async function moveModalMonth(delta) {
  __modalMonth.setMonth(__modalMonth.getMonth() + delta);
  const mInput = document.getElementById("monthly-daily-input");
  mInput.value = `${__modalMonth.getFullYear()}-${String(__modalMonth.getMonth() + 1).padStart(2, "0")}`;
  await refreshMonthlyModal();
}

async function refreshMonthlyModal() {
  const start = new Date(__modalMonth);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  const ids = [];
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    ids.push(`${y}${m}${day}`);
  }
  let total = 0;
  const dailyCounts = {};
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const snap = await getDocs(
      query(collection(db, "stats_daily"), where(documentId(), "in", batch)),
    );
    snap.forEach((d) => {
      const cnt = d.data().uniqueVisitors || 0;
      dailyCounts[d.id] = cnt;
      total += cnt;
    });
  }
  const tbody = document.querySelector("#monthly-daily-table tbody");
  tbody.innerHTML = "";
  const tempS = new Date(start.getFullYear(), start.getMonth(), 1);
  const tempE = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  for (let d = new Date(tempS); d < tempE; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const key = `${y}${m}${day}`;
    const dayStr = `${y}.${m}.${day}`;
    const cnt = dailyCounts[key] || 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="text-center py-2 border-b border-slate-100 dark:border-slate-700">${dayStr}</td><td class="text-center font-bold text-slate-700 dark:text-slate-300 border-b border-slate-100 dark:border-slate-700">${cnt.toLocaleString()}</td>`;
    tbody.appendChild(tr);
  }
  document.getElementById("monthly-daily-total").textContent =
    total.toLocaleString();
}

/* =====================================================
 * Excel Export
 * ===================================================== */
function styleHeader(row) {
  row.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF475569" },
    };
    cell.font = { name: "Pretendard", color: { argb: "FFFFFFFF" }, bold: true };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = {
      top: { style: "thin" },
      left: { style: "thin" },
      bottom: { style: "thin" },
      right: { style: "thin" },
    };
  });
  row.height = 24;
}

async function exportProvisionExcel(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("제공내역");
  ws.columns = [
    { header: "제공일시", key: "date", width: 18 },
    { header: "고객명", key: "name", width: 12 },
    { header: "생년월일", key: "birth", width: 14 },
    { header: "품목명", key: "item", width: 25 },
    { header: "수량", key: "qty", width: 8 },
    { header: "단가", key: "price", width: 10 },
    { header: "총가격", key: "total", width: 12 },
    { header: "처리자", key: "handler", width: 20 },
  ];
  styleHeader(ws.getRow(1));
  rows.forEach((r) => {
    const items = r.items.length
      ? r.items
      : [{ name: "-", quantity: 0, price: 0, total: 0 }];
    let sumQty = 0,
      sumTotal = 0;
    items.forEach((it, idx) => {
      sumQty += Number(it.quantity);
      sumTotal += Number(it.total);
      const row = ws.addRow({
        date: idx === 0 ? r.date : "",
        name: idx === 0 ? r.name : "",
        birth: idx === 0 ? r.birth : "",
        item: it.name,
        qty: it.quantity,
        price: it.price,
        total: it.total,
        handler: idx === 0 ? r.handler : "",
      });
      row.eachCell((cell, col) => {
        cell.border = {
          top: { style: "thin" },
          left: { style: "thin" },
          bottom: { style: "thin" },
          right: { style: "thin" },
        };
        if ([5, 6, 7].includes(col)) cell.numFmt = "#,##0";
        if (idx === 0 && [1, 2, 3, 8].includes(col))
          cell.alignment = { vertical: "top" };
      });
    });
    const sub = ws.addRow({
      date: "",
      name: "",
      birth: "",
      item: "소계",
      qty: sumQty,
      price: "",
      total: sumTotal,
      handler: "",
    });
    sub.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF1F5F9" },
      };
      cell.font = { bold: true };
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
      if (cell.value === sumTotal || cell.value === sumQty)
        cell.numFmt = "#,##0";
    });
  });
  const buffer = await wb.xlsx.writeBuffer();
  saveAs(new Blob([buffer]), `물품제공내역_${formatDate(new Date())}.xlsx`);
}

async function exportVisitExcel(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("방문일자");
  ws.columns = [
    { header: "고객명", key: "name", width: 15 },
    { header: "생년월일", key: "birth", width: 15 },
    { header: "방문일자 목록", key: "dates", width: 80 },
  ];
  styleHeader(ws.getRow(1));
  rows.forEach((r) => {
    ws.addRow(r).eachCell((cell) => {
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
      cell.alignment = { wrapText: true, vertical: "middle" };
    });
  });
  const buffer = await wb.xlsx.writeBuffer();
  saveAs(new Blob([buffer]), `방문일자목록_${formatDate(new Date())}.xlsx`);
}

async function exportLifeExcel(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("생명사랑");
  ws.columns = [
    { header: "성명", key: "name", width: 15 },
    { header: "생년월일", key: "birth", width: 15 },
    { header: "성별", key: "gender", width: 10 },
    { header: "이용자구분", key: "userType", width: 20 },
    { header: "이용자분류", key: "userClass", width: 20 },
  ];
  styleHeader(ws.getRow(1));
  rows.forEach((r) => {
    ws.addRow(r).eachCell((cell) => {
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
      cell.alignment = { vertical: "middle", horizontal: "center" };
    });
  });
  const buffer = await wb.xlsx.writeBuffer();
  saveAs(new Blob([buffer]), `생명사랑 현황_${formatDate(new Date())}.xlsx`);
}
