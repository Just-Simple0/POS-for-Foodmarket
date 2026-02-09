import { db, auth } from "./components/firebase-config.js";
import {
  collection,
  doc,
  addDoc,
  getDocs,
  getDoc,
  updateDoc,
  Timestamp,
  query,
  where,
  orderBy,
  startAt,
  startAfter,
  endAt,
  limit,
  arrayUnion,
  writeBatch,
  serverTimestamp,
  setDoc,
  increment,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  showToast,
  openConfirm,
  toggleFade,
  renderEmptyState,
} from "./components/comp.js";
import { getQuarterKey } from "./utils/lifelove.js";

// ===== 통계용 헬퍼 & 카운터 보조 =====
function toDayNumber(d) {
  const base = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return (
    base.getFullYear() * 10000 + (base.getMonth() + 1) * 100 + base.getDate()
  );
}
function toDateKey(dayNum) {
  const y = Math.floor(dayNum / 10000);
  const m = Math.floor((dayNum % 10000) / 100);
  const d = dayNum % 100;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function toPeriodKey(date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const startY = m >= 3 ? y : y - 1;
  const endY = startY + 1;
  return `${String(startY).slice(2)}-${String(endY).slice(2)}`;
}

// ===== KST 기준 날짜 키 유틸 =====
// 브라우저/서버 런타임 타임존과 무관하게 "한국시간 기준" YYYY-MM-DD를 안정적으로 생성
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
function toKstDateParts(date) {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  return {
    y: k.getUTCFullYear(),
    m: k.getUTCMonth() + 1,
    d: k.getUTCDate(),
  };
}
function toKstDayNumber(date) {
  const { y, m, d } = toKstDateParts(date);
  return y * 10000 + m * 100 + d; // YYYYMMDD (KST)
}
function toKstDateKey(date) {
  const { y, m, d } = toKstDateParts(date);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function toKstMonthKey(date) {
  const { y, m } = toKstDateParts(date);
  return `${y}-${String(m).padStart(2, "0")}`; // YYYY-MM
}
function toKstPeriodKey(date) {
  const { y, m } = toKstDateParts(date);
  const startY = m >= 3 ? y : y - 1;
  const endY = startY + 1;
  return `${String(startY).slice(2)}-${String(endY).slice(2)}`;
}

// 방문/일일 카운터 기록 (규칙 준수: /visits는 허용 키로 '신규 생성'만, 그때만 /stats_daily +1)
async function ensureVisitAndDailyCounter(
  db,
  customerId,
  customerName,
  atDate,
  items = [], // ✅ (추가) 이번 제공 전표의 품목 배열: [{id,name,category,price,quantity}, ...]
) {
  const day = toKstDayNumber(atDate); // 예: 20250915 (KST 기준 YYYYMMDD)
  const dateKey = toDateKey(day); // 예: '2025-09-15'
  const periodKey = toKstPeriodKey(atDate); // 예: '25-26' (KST)
  const visitId = `${dateKey}_${customerId}`; // 1일 1고객 1문서
  const visitRef = doc(db, "visits", visitId);
  const statsRef = doc(db, "stats_daily", String(day)); // 'YYYYMMDD'

  // ✅ itemsTotalQty / top20 갱신을 위해 delta 계산
  const deltasById = new Map(); // productId -> { qty, name, category }
  let qtyDeltaTotal = 0;

  if (Array.isArray(items)) {
    for (const it of items) {
      const pid = it?.id;
      if (!pid) continue;
      const q = Number(it?.quantity || 0);
      if (!Number.isFinite(q) || q === 0) continue;

      qtyDeltaTotal += q;

      const prev = deltasById.get(pid) || {
        qty: 0,
        name: it?.name || "",
        category: it?.category || "",
      };
      prev.qty += q;
      // 이름/카테고리는 비어있으면 채워두기(최신값 우선)
      if (!prev.name && it?.name) prev.name = it.name;
      if (!prev.category && it?.category) prev.category = it.category;
      deltasById.set(pid, prev);
    }
  }

  try {
    await runTransaction(db, async (tx) => {
      // 1) visits: 없을 때만 생성
      const visitSnap = await tx.get(visitRef);
      const created = !visitSnap.exists();

      if (created) {
        tx.set(visitRef, {
          day, // ✅ 규칙 허용 키
          dateKey, // ✅ 규칙 허용 키
          customerId, // ✅ 규칙 허용 키
          customerName: customerName || null, // ✅ 규칙 허용 키
          periodKey, // ✅ 규칙 허용 키
          createdAt: serverTimestamp(), // ✅ 규칙 허용 키
          createdBy: auth?.currentUser?.uid || "unknown", // ✅ createdBy == request.auth.uid 필요
        });
      }

      // 2) stats_daily: itemsTotalQty/top20는 "매 제공"마다 누적(중복 제공 포함)
      //    uniqueVisitors는 "신규 방문 created==true"일 때만 +1
      const statsSnap = await tx.get(statsRef);
      const stats = statsSnap.exists() ? statsSnap.data() || {} : {};

      // 기존 누적값
      const curItemsTotalQty = Number(stats.itemsTotalQty || 0);
      const nextItemsTotalQty = curItemsTotalQty + qtyDeltaTotal;

      // itemStatsById: { [productId]: { qty, name, category } }
      const curMap =
        stats.itemStatsById && typeof stats.itemStatsById === "object"
          ? { ...stats.itemStatsById }
          : {};

      // delta 반영
      for (const [pid, d] of deltasById.entries()) {
        const cur =
          curMap[pid] && typeof curMap[pid] === "object" ? curMap[pid] : {};
        const curQty = Number(cur.qty || 0);
        const nextQty = curQty + Number(d.qty || 0);

        if (!Number.isFinite(nextQty) || nextQty <= 0) {
          delete curMap[pid];
        } else {
          curMap[pid] = {
            qty: nextQty,
            name: d.name || cur.name || "",
            category: d.category || cur.category || "",
          };
        }
      }

      // topItems20 재계산
      const topItems20 = Object.entries(curMap)
        .map(([id, v]) => ({
          id,
          name: v?.name || "",
          category: v?.category || "",
          qty: Number(v?.qty || 0),
        }))
        .filter((x) => Number.isFinite(x.qty) && x.qty > 0)
        .sort((a, b) => b.qty - a.qty)
        .slice(0, 20);

      // 저장(merge)
      const payload = {
        itemsTotalQty: nextItemsTotalQty,
        itemStatsById: curMap,
        topItems20,
        updatedAt: serverTimestamp(), // 규칙: updatedAt == request.time
      };

      if (created) {
        // 신규 방문일 때만 +1
        payload.uniqueVisitors = increment(1);
      }

      tx.set(statsRef, payload, { merge: true });
    });
  } catch (e) {
    console.warn("[visits/stats_daily] ensure failed:", e?.message || e);
  }
}

// 제공 탭 전용 검색/정보
const provLookupInput = document.getElementById("prov-customer-search");
const provLookupBtn = document.getElementById("prov-lookup-btn");
const provisionCustomerInfoDiv = document.getElementById(
  "provision-customer-info",
);
// 교환 탭 전용 검색/정보
const exLookupInput = document.getElementById("ex-customer-search");
const exLookupBtn = document.getElementById("ex-lookup-btn");
const exchangeCustomerInfoDiv = document.getElementById(
  "exchange-customer-info",
);

const productSection = document.getElementById("product-selection");
const submitSection = document.getElementById("submit-section");
const submitBtn = document.getElementById("submit-btn");
const undoBtn = document.getElementById("undo-btn");
const redoBtn = document.getElementById("redo-btn");
const resetProductsBtn = document.getElementById("clear-products-btn");
const resetAllBtn = document.getElementById("clear-all-btn");
const lifeloveCheckbox = document.getElementById("lifelove-checkbox");
const productActionButtons = document.getElementById("product-action-buttons");
const currentUser = auth.currentUser;

// === 방문자 리스트 로컬 보존 유틸 ===
const VISITOR_STORAGE_PREFIX = "fm.visitors";
const PROVISION_DRAFT_PREFIX = "fm.provisionDraft";
function ymdLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function getVisitorKey() {
  const uid =
    (window.auth && auth.currentUser && auth.currentUser.uid) || "local";
  return `${VISITOR_STORAGE_PREFIX}:${uid}:${ymdLocal()}`;
}
function getProvisionKey() {
  const uid =
    (window.auth && auth.currentUser && auth.currentUser.uid) || "local";
  return `${PROVISION_DRAFT_PREFIX}:${uid}:${ymdLocal()}`;
}
// ✅ 오늘 날짜 기준으로 'uid'와 'local' 두 키 모두를 시도
function getKeysToTry(prefix) {
  const date = ymdLocal();
  const uid = (window.auth && auth.currentUser && auth.currentUser.uid) || null;
  const keys = [];
  if (uid) keys.push(`${prefix}:${uid}:${date}`);
  keys.push(`${prefix}:local:${date}`); // 로그인 전/게스트 저장분도 커버
  // 중복 제거
  return [...new Set(keys)];
}

function endOfTodayTs() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
// === 멀티탭 안전 동기화: 세션/버전/타임스탬프 메타 ===
const __TAB_SESSION_ID =
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
let __visitorListUpdatedAt = 0; // 이 탭에서 적용된 최신 updatedAt
const __VISITOR_LS_SCHEMA = 2; // 로컬 캐시 스키마 버전

function __parseVisitorDraftRaw(raw) {
  try {
    const val = JSON.parse(raw);
    // 구버전: 배열만 저장돼 있던 경우
    if (Array.isArray(val)) {
      return { data: val, updatedAt: 0, v: 1, sessionId: null, expiresAt: 0 };
    }
    if (val && typeof val === "object") {
      // v1 호환: savedAt 사용 → updatedAt 대입
      const updatedAt = Number(val.updatedAt || val.savedAt || 0);
      const data = Array.isArray(val.list)
        ? val.list
        : Array.isArray(val.data)
          ? val.data
          : [];
      return {
        data,
        updatedAt,
        v: Number(val.v || 1),
        sessionId: val.sessionId || null,
        expiresAt: Number(val.expiresAt || 0),
      };
    }
  } catch {}
  return { data: [], updatedAt: 0, v: 0, sessionId: null, expiresAt: 0 };
}
function __eqVisitorShallow(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i],
      y = b[i];
    if (!x || !y) return false;
    if (
      x.id !== y.id ||
      x.name !== y.name ||
      x.birth !== y.birth ||
      x.phone !== y.phone
    ) {
      return false;
    }
  }
  return true;
}
function loadVisitorDraft() {
  try {
    let best = { data: [], updatedAt: 0, v: 0, sessionId: null, expiresAt: 0 };
    for (const key of getKeysToTry(VISITOR_STORAGE_PREFIX)) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = __parseVisitorDraftRaw(raw);
      // 만료 처리(있으면)
      if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
        localStorage.removeItem(key);
        continue;
      }
      if ((parsed.updatedAt || 0) > (best.updatedAt || 0)) {
        best = parsed;
      }
    }
    __visitorListUpdatedAt = best.updatedAt || 0;
    return Array.isArray(best.data) ? best.data : [];
  } catch (e) {
    console.warn("loadVisitorDraft failed:", e);
    __visitorListUpdatedAt = 0;
    return [];
  }
}
function saveVisitorDraft(list) {
  try {
    const key = getVisitorKey();
    const prev = __parseVisitorDraftRaw(localStorage.getItem(key));
    // 동일 내용이면 저장 스킵
    if (__eqVisitorShallow(list, prev.data)) return;
    // 더 최신 값이 이미 저장돼 있다면 그보다 큰 updatedAt로 저장
    const now = Date.now();
    const updatedAt = Math.max(now, (prev.updatedAt || 0) + 1);
    const payload = {
      v: __VISITOR_LS_SCHEMA,
      updatedAt,
      sessionId: __TAB_SESSION_ID,
      date: ymdLocal(),
      expiresAt: endOfTodayTs(),
      data: Array.isArray(list) ? list : [],
    };
    localStorage.setItem(key, JSON.stringify(payload));
    __visitorListUpdatedAt = updatedAt;
  } catch (e) {
    console.warn("saveVisitorDraft failed:", e);
  }
}
function clearVisitorDraft() {
  try {
    for (const key of getKeysToTry(VISITOR_STORAGE_PREFIX)) {
      localStorage.removeItem(key);
    }
  } catch {}
  __visitorListUpdatedAt = 0;
}
// --- 제공(선택 고객/장바구니/생명사랑) 보존 ---
function saveProvisionDraft() {
  const payload = {
    v: 1,
    date: ymdLocal(),
    savedAt: Date.now(),
    expiresAt: endOfTodayTs(),
    selectedCustomer: selectedCustomer
      ? {
          id: selectedCustomer.id,
          name: selectedCustomer.name,
          birth: selectedCustomer.birth,
          address: selectedCustomer.address,
          phone: selectedCustomer.phone,
          lastVisit: selectedCustomer.lastVisit,
          note: selectedCustomer.note,
          _lifeloveThisQuarter: !!selectedCustomer._lifeloveThisQuarter,
        }
      : null,
    selectedItems: Array.isArray(selectedItems) ? selectedItems : [],
    lifelove: !!lifeloveCheckbox.checked,
  };
  try {
    if (!payload.selectedCustomer && payload.selectedItems.length === 0) {
      localStorage.removeItem(getProvisionKey());
      return;
    }
    localStorage.setItem(getProvisionKey(), JSON.stringify(payload));
  } catch (e) {
    console.warn("saveProvisionDraft failed:", e);
  }
}

function loadProvisionDraft() {
  try {
    let best = null; // {obj, key}
    for (const key of getKeysToTry(PROVISION_DRAFT_PREFIX)) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const obj = JSON.parse(raw);
      if (obj.expiresAt && Date.now() > obj.expiresAt) {
        localStorage.removeItem(key);
        continue;
      }
      if (!best || (obj.savedAt || 0) > (best.obj?.savedAt || 0)) {
        best = { obj, key };
      }
    }
    return best ? best.obj : null;
  } catch (e) {
    console.warn("loadProvisionDraft failed:", e);
    return null;
  }
}

function clearProvisionDraft() {
  try {
    localStorage.removeItem(getProvisionKey());
  } catch {}
}

async function loadExchangeAutoSave() {
  try {
    const raw = localStorage.getItem(getExAutoSaveKey());
    if (!raw) return;
    const data = JSON.parse(raw);

    // 유효성 검사 (오늘 날짜 데이터인지 등) - 키에 날짜가 포함되어 있으므로 생략 가능하나 안전장치
    if (!data.customer) return;

    // 1단계 복구: 고객
    exchangeSelectedCustomer = data.customer;
    // UI 표시를 위해 교환 탭으로 전환된 것처럼 처리할 수도 있으나,
    // 여기서는 데이터만 로드하고 탭 전환 시 렌더링되도록 함.
    renderExchangeCustomerInfo();

    // 고객이 있으면 히스토리 로드
    if (exchangeSelectedCustomer.id) {
      await loadRecentProvisionsForCustomer(exchangeSelectedCustomer.id);
      exchangeHistorySection?.classList.remove("hidden");
    }

    // 2단계 복구: 영수증
    if (data.provision) {
      exchangeProvision = data.provision;
      exchangeOriginalItems = data.originalItems || [];
      exchangeOriginalTotal = data.originalTotal || 0;
      exchangeBuilder.classList.remove("hidden");
    }

    // 3단계 복구: 장바구니 및 스택
    if (data.currentItems) {
      exchangeItems = data.currentItems;
      exUndoStack = data.undo || [];
      exRedoStack = data.redo || [];
      renderExchangeList(); // 여기서 자동저장이 다시 트리거되지만 데이터는 동일함
    }

    // 교환 탭 UI 활성화 (만약 현재 탭이 교환이라면)
    const isEx =
      document.querySelector(".tab-btn.active")?.dataset.tab === "exchange";
    if (isEx) {
      exchangeSection.classList.remove("hidden");
    }

    console.log(`교환 작업 자동 복구 완료 (Step ${data.step})`);
    if (data.step >= 2) showToast("작업 중이던 교환 내역을 복구했어요.");
  } catch (e) {
    console.warn("Auto-load failed:", e);
    localStorage.removeItem(getExAutoSaveKey());
  }
}

// 스냅샷 찍기 (변경 직전 호출)
function saveExUndoState() {
  exUndoStack.push(JSON.parse(JSON.stringify(exchangeItems)));
  exRedoStack = []; // 새로운 분기 시작 시 Redo 날림
  // 스택 변경도 자동저장 대상
  saveExchangeAutoSave();
}

let selectedCustomer = null;
let selectedItems = [];
let selectedCandidate = null;
let visitorList = []; // ✅ 방문자 리스트
const visitorListEl = document.getElementById("visitor-list");
const visitorListSection = document.getElementById("visitor-list-section");

const HOLD_PREFIX = "provision:hold:";

// ── 상품: 선로딩 제거 → JIT 조회(로컬 캐시로 재조회 최소화)
const productByBarcode = new Map(); // barcode -> {id,name,price,barcode,category}
const productById = new Map(); // id -> product
let nameReqSeq = 0; // 자동완성 최신 응답 가드
let _allProductsCache = null; // 전체 상품 캐시 저장소 (클라이언트 검색용)

// ===== 상품 캐시(영속) : IndexedDB + localStorage =====
const PRODUCT_IDB_NAME = "pos_products";
const PRODUCT_IDB_STORE = "products_cache";
const PRODUCT_CACHE_SYNC_KEY = "products_cache_synced_at";
const PRODUCT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h (원하면 조정)

function openProductIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PRODUCT_IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PRODUCT_IDB_STORE)) {
        db.createObjectStore(PRODUCT_IDB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbReadAllProducts() {
  const dbi = await openProductIDB();
  return await new Promise((resolve, reject) => {
    const tx = dbi.transaction(PRODUCT_IDB_STORE, "readonly");
    const st = tx.objectStore(PRODUCT_IDB_STORE);
    const req = st.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbWriteAllProducts(products) {
  const dbi = await openProductIDB();
  return await new Promise((resolve, reject) => {
    const tx = dbi.transaction(PRODUCT_IDB_STORE, "readwrite");
    const st = tx.objectStore(PRODUCT_IDB_STORE);
    // 전체 덮어쓰기: clear 후 put
    const clearReq = st.clear();
    clearReq.onsuccess = () => {
      for (const p of products) st.put(p);
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("idb write failed"));
  });
}

// ✅ 분류 제한 정책 (읽기 전용): stats/categoryPolicies 문서에서 1회 로드
//   문서 예시: { policies: { "생필품": {mode:"one_per_category",active:true}, "스낵":{mode:"one_per_price",active:true} } }
let categoryPolicies = {}; // { [category]: {mode:'one_per_category'|'one_per_price', active:boolean} }
async function loadCategoryPolicies() {
  try {
    const snap = await getDoc(doc(db, "stats", "categoryPolicies"));
    const data = snap.exists() ? snap.data() : null;
    categoryPolicies = data && data.policies ? data.policies : {};

    // ✅ [핵심 추가] 정책 로딩이 늦게 끝나더라도,
    // 현재 장바구니(selectedItems)가 있으면 즉시 위반 여부를 다시 검사해서 화면에 반영함
    if (selectedItems && selectedItems.length > 0) {
      applyCategoryViolationHighlight();
    }
  } catch (e) {
    console.warn("categoryPolicies load failed:", e);
    categoryPolicies = {};
  }
}

// [유틸] 롱프레스(꾹 누르기) 핸들러
function setupLongPress(btn, action) {
  let pressTimer = null;
  let interval = null;
  let isLongPress = false;

  const start = (e) => {
    // 마우스 왼쪽 클릭만 허용
    if (e.type === "mousedown" && e.button !== 0) return;
    // 터치 시 스크롤 등 기본 동작 방지 (선택)
    // if (e.type === 'touchstart') e.preventDefault();

    // 1. 누르자마자 1회 실행 (즉시 반응)
    action();

    isLongPress = false;
    // 2. 500ms 이상 누르면 연속 동작 시작
    pressTimer = setTimeout(() => {
      isLongPress = true;
      interval = setInterval(() => {
        action(); // 100ms마다 반복 실행
      }, 100);
    }, 500);
  };

  const cancel = (e) => {
    // 타이머 정리
    if (pressTimer) clearTimeout(pressTimer);
    if (interval) clearInterval(interval);
    pressTimer = null;
    interval = null;

    // 롱프레스였다면 클릭 이벤트 전파 막기 (필요 시)
    if (isLongPress && e) {
      // e.preventDefault();
    }
  };

  // 기존 이벤트 리스너 중복 방지 (선택 사항)
  // btn.replaceWith(btn.cloneNode(true)); // 이렇게 하면 기존 리스너가 다 날아가니 주의

  // 마우스/터치 이벤트 바인딩
  btn.addEventListener("mousedown", start);
  btn.addEventListener(
    "touchstart",
    (e) => {
      // 터치 시 브라우저 메뉴 뜨는 것 방지, 그러나 스크롤은 허용해야 할 수도 있음
      // 여기서는 preventDefault 호출 안 함 (상황에 따라 조절)
      start(e);
    },
    { passive: true },
  );

  // 떼거나 벗어나면 중지
  btn.addEventListener("mouseup", cancel);
  btn.addEventListener("mouseleave", cancel);
  btn.addEventListener("touchend", cancel);
}

// 🔁 동명이인 모달 키보드 내비 전역 핸들러 참조
let dupKeyHandler = null;
let dupActiveIndex = -1;
// ✅ 복구 토스트/중복 실행 방지 플래그
let __restoredVisitors = false;
let __restoredProvision = false;

async function tryRestoreDrafts() {
  // 방문자
  const visitors = loadVisitorDraft();
  if (visitors.length && !__restoredVisitors) {
    visitorList = visitors;
    renderVisitorList();
    __restoredVisitors = true;
    if (typeof showToast === "function")
      showToast(`방문자 ${visitorList.length}명이 복구되었어요.`);
  }
  // 제공
  const prov = loadProvisionDraft();
  if (
    prov &&
    (prov.selectedCustomer || (prov.selectedItems ?? []).length > 0) &&
    !__restoredProvision
  ) {
    selectedCustomer = prov.selectedCustomer || null;
    selectedItems = Array.isArray(prov.selectedItems) ? prov.selectedItems : [];
    lifeloveCheckbox.checked = !!prov.lifelove;
    if (selectedCustomer) {
      productSection.classList.remove("hidden");
      submitSection.classList.remove("hidden");
    }
    renderProvisionCustomerInfo();
    renderSelectedList();
    renderVisitorList();
    __restoredProvision = true;
    if (typeof showToast === "function")
      showToast("임시 장바구니가 복구되었어요.");
  }
  await loadExchangeAutoSave();
}

window.addEventListener("DOMContentLoaded", () => {
  // 초기 포커스: 제공 탭 검색창
  provLookupInput?.focus();
  loadCategoryPolicies();
  // 로그인 여부와 무관하게 1차 복구(게스트 키 포함)
  tryRestoreDrafts();
  // 교환 탭 초기 진입 시 섹션 숨김(이용자 선택 후 노출)
  if (exchangeSection) exchangeSection.classList.add("hidden");
});

// ✅ 로그인 상태가 결정되면(uid 키까지) 2차 복구
onAuthStateChanged(auth, () => {
  tryRestoreDrafts();
});

// ✅ 다른 탭/창에서 변경 시 동기화(“더 최신”만 수용)
window.addEventListener("storage", (e) => {
  try {
    if (!e || !e.key) return;
    const activeVisitorKey = getVisitorKey();
    const isVisitorKey = e.key === activeVisitorKey;
    const isProvision =
      e.key.startsWith(`${PROVISION_DRAFT_PREFIX}:`) &&
      e.key.endsWith(`:${ymdLocal()}`);

    if (isVisitorKey) {
      const parsed = __parseVisitorDraftRaw(e.newValue);
      if (!parsed) return;
      // 본인 탭에서 setItem한 경우는 보통 이벤트가 안 오지만, 혹시 sessionId 같으면 무시
      if (parsed.sessionId === __TAB_SESSION_ID) return;
      // 더 최신(updatedAt 큰 값)일 때만 채택
      if ((parsed.updatedAt || 0) <= (__visitorListUpdatedAt || 0)) return;
      visitorList = Array.isArray(parsed.data) ? parsed.data : [];
      __visitorListUpdatedAt = parsed.updatedAt || Date.now();
      renderVisitorList();
      return;
    }

    if (isProvision) {
      const prov = loadProvisionDraft();
      if (prov) {
        selectedCustomer = prov.selectedCustomer || null;
        selectedItems = Array.isArray(prov.selectedItems)
          ? prov.selectedItems
          : [];
        lifeloveCheckbox.checked = !!prov.lifelove;
      } else {
        selectedCustomer = null;
        selectedItems = [];
        lifeloveCheckbox.checked = false;
      }
      renderProvisionCustomerInfo();
      renderSelectedList();
      renderVisitorList();
    }
  } catch (err) {
    console.warn("storage sync error:", err);
  }
});

// ============================================================
// 1. 탭 전환 및 화면 제어 로직 (Refactored)
// ============================================================
const tabBtns = document.querySelectorAll(".tab-item");
const provisionPanel = document.getElementById("provision-panel");
const exchangeSection = document.getElementById("exchange-section");

// [추가됨] 교환 탭 선택 고객 변수 선언
let exchangeSelectedCustomer = null;

// 탭 전환 함수
function showTab(name) {
  const isExchange = name === "exchange";

  // 1. 탭 버튼 상태 업데이트 (ARIA 접근성 포함)
  tabBtns.forEach((btn) => {
    const isActive = btn.dataset.tab === name;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", isActive);
  });

  // 2. 패널 토글 및 애니메이션 재실행
  if (isExchange) {
    provisionPanel.classList.add("hidden");
    exchangeSection.classList.remove("hidden");

    // 교환 탭 포커스 이동
    if (exchangeSelectedCustomer) {
      if (document.getElementById("ex-barcode-input")) {
        document.getElementById("ex-barcode-input").focus();
      }
    } else {
      exLookupInput?.focus();
    }
  } else {
    exchangeSection.classList.add("hidden");
    provisionPanel.classList.remove("hidden");

    // 제공 탭 상태 복구 (방문자 리스트 등)
    if (visitorList && visitorList.length > 0) {
      visitorListSection?.classList.remove("hidden");
    } else {
      visitorListSection?.classList.add("hidden");
    }

    // 선택된 고객이 있으면 상품 입력창 표시
    if (selectedCustomer) {
      productSection?.classList.remove("hidden");
      submitSection?.classList.remove("hidden");
      setTimeout(() => document.getElementById("barcode-input")?.focus(), 50);
    } else {
      productSection?.classList.add("hidden");
      submitSection?.classList.add("hidden");
      provLookupInput?.focus();
    }
  }

  // 3. 전역 조회 컨텍스트 변경
  window.__lookupContext = name;
}

// 탭 버튼 클릭 이벤트 바인딩
tabBtns.forEach((btn) =>
  btn.addEventListener("click", () => showTab(btn.dataset.tab)),
);

// 엔터키 입력 시 검색 버튼 트리거
provLookupInput?.addEventListener("keydown", (e) => {
  if (!duplicateModal.classList.contains("hidden")) return;
  if (e.key === "Enter") {
    e.preventDefault();
    provLookupBtn.click();
  }
});

exLookupInput?.addEventListener("keydown", (e) => {
  if (!duplicateModal.classList.contains("hidden")) return;
  if (e.key === "Enter") {
    e.preventDefault();
    exLookupBtn.click();
  }
});

// ====== 고객 검색: IndexedDB(지원자 캐시) 우선, 0건이면 서버 prefix 쿼리 ======
const IDB_NAME = "pos_customers";
const IDB_STORE = "support_only"; // customers.js와 동일 스토어명 사용
function normalize(str) {
  return (str || "")
    .toString()
    .toLowerCase()
    .replace(/[\s\-]/g, "");
}
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        const st = db.createObjectStore(IDB_STORE, { keyPath: "id" });
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
  const range = IDBKeyRange.bound(prefix, prefix + "\uffff");
  return await new Promise((resolve) => {
    const out = [];
    idx.openCursor(range).onsuccess = (e) => {
      const cur = e.target.result;
      if (cur && out.length < max) {
        out.push(cur.value); // {id,name,birth,phone,...}
        cur.continue();
      } else resolve(out);
    };
  });
}

// ====== 고객 캐시 자동 동기화 (Provision 전용, 초경량) ======
// - customers.html을 한 번도 열지 않은 상태에서 provision부터 진입해도 검색이 되도록 보완
// - 캐시가 비어있거나 오래됐을 때만(기본 24시간) 서버에서 1회 전체 동기화
const SUPPORT_CACHE_SYNC_KEY = "support_cache_synced_at";
const SUPPORT_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
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
    const req = st.clear();
    req.onsuccess = () => {};
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
  // ✅ provision 검색에 필요한 최소 필드 + nameLower(인덱스용) + lastVisit(최근 방문 표시용)
  // (Firestore 문서에 nameLower가 없을 수 있으니 안전하게 보정)
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
    nameLower,
  };
}

async function syncSupportCacheFromServerOnce() {
  const dbi = await openIDB();
  await idbClearSupportCache(dbi);

  const PAGE = 500; // Firestore 한 쿼리당 최대치 (필요시 조정)
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

  if (count > 0 && !stale) return; // ✅ 충분히 신선

  __supportCacheSyncPromise = (async () => {
    try {
      const total = await syncSupportCacheFromServerOnce();
      // 캐시가 비어있던 첫 동기화만 안내(원치 않으면 주석 처리)
      if (count === 0 && total > 0 && typeof showToast === "function") {
        showToast(`이용자 캐시 ${total}명을 동기화 완료했어요.`);
      }
    } catch (e) {
      console.warn("ensureSupportCacheFresh sync failed:", e);
      // 실패해도 기존 폴백(serverSearchByNamePrefix)이 있으니 조용히 넘어감
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
    endAt(prefix + "\uf8ff"),
    limit(max),
  );
  const snap = await getDocs(qy);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
// 어느 탭에서 호출됐는지 구분
let __lookupContext = "provision"; // 'provision' | 'exchange'

provLookupBtn.addEventListener("click", async () => {
  const groupEl = document.getElementById("prov-lookup-group");
  const errorEl = document.getElementById("prov-lookup-error");
  const raw = provLookupInput.value.trim();

  // 초기화: 이전 에러 상태 제거
  groupEl.classList.remove("is-error");
  errorEl.classList.add("hidden");

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
    if (!rows || rows.length === 0) {
      rows = await serverSearchByNamePrefix(key, 20);
    }

    if (!rows.length) {
      // [수정] 토스트 대신 인풋 에러 상태 적용
      groupEl.classList.add("is-error");
      errorEl.textContent = "해당 이용자를 찾을 수 없습니다.";
      errorEl.classList.remove("hidden");
      provLookupInput.focus();
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

// 사용자가 다시 입력을 시작하면 에러 상태 해제
provLookupInput.addEventListener("input", () => {
  const groupEl = document.getElementById("prov-lookup-group");
  const errorEl = document.getElementById("prov-lookup-error");
  groupEl.classList.remove("is-error");
  errorEl.classList.add("hidden");
});

exLookupBtn?.addEventListener("click", async () => {
  __lookupContext = "exchange";
  const raw = exLookupInput.value.trim();
  if (!raw) return showToast("이름을 입력하세요.", true);
  try {
    const key = normalize(raw);
    await ensureSupportCacheFresh();
    let rows = await searchCacheByNamePrefix(key, 20);
    if (!rows || rows.length === 0)
      rows = await serverSearchByNamePrefix(key, 20);
    if (!rows.length) return showToast("해당 이용자를 찾을 수 없어요.", true);
    showDuplicateSelection(rows);
  } catch (err) {
    console.error(err);
    showToast("이용자 조회 중 오류가 발생했어요.", true);
  }
});

function renderProvisionCustomerInfo() {
  if (!selectedCustomer) {
    provisionCustomerInfoDiv.innerHTML = "";
    provisionCustomerInfoDiv.classList.add("hidden");
    return;
  }

  // [TDS] 배지 스타일: 정의된 badge-weak 계열을 활용하여 하드코딩된 색상값 제거
  const lifeBadge = selectedCustomer._lifeloveThisQuarter
    ? '<span class="badge badge-weak-success badge-md font-bold px-3">이번 분기 제공됨</span>'
    : '<span class="badge badge-weak-grey badge-md font-bold px-3">미제공</span>';

  // [TDS] 카드 디자인 리팩토링: .card 클래스와 정돈된 타이포그래피 적용
  provisionCustomerInfoDiv.innerHTML = `
    <div class="card p-6 md:p-8 animate-fade-in">
      <div class="flex justify-between items-start mb-8 border-b border-slate-100 dark:border-slate-700/50 pb-6">
        <div>
          <div class="flex items-center gap-2.5 mb-1">
            <span class="text-3xl font-black text-slate-900 dark:text-white tracking-tight">
              ${selectedCustomer.name ?? "이름 없음"}
            </span>
            <span class="text-[15px] text-slate-400 dark:text-slate-500 font-medium">
              (${selectedCustomer.gender ?? "-"})
            </span>
          </div>
        </div>
        <div class="shrink-0">${lifeBadge}</div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-y-7 gap-x-8">
        <div>
          <span class="block text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-tighter mb-1.5">생년월일</span>
          <span class="text-[16px] text-slate-800 dark:text-slate-200 font-bold">
            ${selectedCustomer.birth ?? "-"}
          </span>
        </div>
        <div>
          <span class="block text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-tighter mb-1.5">전화번호</span>
          <span class="text-[16px] text-slate-800 dark:text-slate-200 font-bold">
            ${selectedCustomer.phone ?? "-"}
          </span>
        </div>
        <div class="sm:col-span-2">
          <span class="block text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-tighter mb-1.5">주소</span>
          <span class="text-[16px] text-slate-800 dark:text-slate-200 font-bold break-keep leading-snug">
            ${selectedCustomer.address ?? "-"}
          </span>
        </div>
      </div>

      <div class="mt-8 pt-8 border-t border-slate-100 dark:border-slate-700/50 grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div class="lg:col-span-1">
          <span class="block text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-tighter mb-1.5">최근 방문</span>
          <span class="text-[18px] text-primary font-black">
            ${lastVisitDisplay(selectedCustomer) || "-"}
          </span>
        </div>
        <div class="lg:col-span-3">
          <span class="block text-[11px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-tighter mb-1.5">비고</span>
          <div class="text-[14px] text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900/40 px-4 py-3 rounded-2xl leading-relaxed border border-slate-100 dark:border-slate-700/50">
            ${selectedCustomer.note || "등록된 특이사항이 없습니다."}
          </div>
        </div>
      </div>
    </div>
  `;
  provisionCustomerInfoDiv.classList.remove("hidden");
}

function renderExchangeCustomerInfo() {
  if (!exchangeSelectedCustomer) {
    exchangeCustomerInfoDiv.innerHTML = "";
    exchangeCustomerInfoDiv.classList.add("hidden");
    return;
  }

  // [수정] 배지 스타일: 다크 모드 대응
  const lifeBadge = exchangeSelectedCustomer._lifeloveThisQuarter
    ? '<span class="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-900/30 px-2.5 py-1 text-xs font-bold text-emerald-700 dark:text-emerald-400 ring-1 ring-inset ring-emerald-600/20 dark:ring-emerald-500/30">이번 분기 제공됨</span>'
    : '<span class="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-700 px-2.5 py-1 text-xs font-bold text-slate-600 dark:text-slate-300 ring-1 ring-inset ring-slate-500/10 dark:ring-slate-600">미제공</span>';

  // [수정] 카드 및 텍스트 다크 모드 적용
  exchangeCustomerInfoDiv.innerHTML = `
    <div class="card p-5 border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm transition-colors duration-200">
      <div class="flex justify-between items-start mb-4 border-b border-slate-100 dark:border-slate-700/50 pb-4">
        <div>
          <div class="flex items-center gap-2 mb-1">
            <span class="text-xl font-extrabold text-slate-900 dark:text-white">${
              exchangeSelectedCustomer.name ?? "이름 없음"
            }</span>
            <span class="text-sm text-slate-500 dark:text-slate-400 font-medium">(${
              exchangeSelectedCustomer.gender ?? "-"
            })</span>
          </div>
        </div>
        <div>${lifeBadge}</div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <div>
          <span class="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase mb-1">생년월일</span>
          <span class="text-base text-slate-800 dark:text-slate-200 font-semibold">${
            exchangeSelectedCustomer.birth ?? "-"
          }</span>
        </div>
        <div>
          <span class="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase mb-1">전화번호</span>
          <span class="text-base text-slate-800 dark:text-slate-200 font-semibold">${
            exchangeSelectedCustomer.phone ?? "-"
          }</span>
        </div>
        <div class="sm:col-span-2">
          <span class="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase mb-1">주소</span>
          <span class="text-base text-slate-800 dark:text-slate-200 font-semibold break-keep">${
            exchangeSelectedCustomer.address ?? "-"
          }</span>
        </div>
      </div>

      <div class="mt-4 pt-4 border-t border-slate-100 dark:border-slate-700/50 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <span class="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase mb-1">최근 방문</span>
          <span class="text-base text-blue-600 dark:text-blue-400 font-bold">${
            lastVisitDisplay(exchangeSelectedCustomer) || "-"
          }</span>
        </div>
        <div>
          <span class="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase mb-1">비고</span>
          <p class="text-sm text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-700/30 px-3 py-2 rounded-lg leading-relaxed border border-slate-100 dark:border-slate-700/50">
            ${exchangeSelectedCustomer.note || "-"}
          </p>
        </div>
      </div>
    </div>
  `;
  exchangeCustomerInfoDiv.classList.remove("hidden");
}

// 동명이인 처리하기
const duplicateModal = document.getElementById("duplicate-modal");
const duplicateList = document.getElementById("duplicate-list");
const closeDuplicateModal = document.getElementById("close-duplicate-modal");

// === 최근 방문일자 표시 유틸 ===
function fmtYMD(dateStr) {
  if (!dateStr) return "";
  const s = String(dateStr);
  const m = s.match(/^(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})/);
  if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  try {
    const d = new Date(s);
    if (!isNaN(d)) {
      const y = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${y}.${mm}.${dd}`;
    }
  } catch {}
  return s;
}
function computeLastVisit(c) {
  const v = c?.visits;
  if (!v || typeof v !== "object") return "";
  let latest = "";
  for (const k of Object.keys(v)) {
    const arr = Array.isArray(v[k]) ? v[k] : [];
    for (const s of arr) {
      if (!s) continue;
      const iso = String(s).replace(/\./g, "-"); // YYYY-MM-DD
      if (!latest || iso > latest) latest = iso;
    }
  }
  return latest ? fmtYMD(latest) : "";
}
function lastVisitDisplay(data) {
  // denormalized 필드 우선, 없으면 rows 안의 visits로 계산(추가 읽기 없음)
  return fmtYMD(data.lastVisit) || computeLastVisit(data) || "-";
}

closeDuplicateModal.addEventListener("click", () => {
  // ✅ 닫기: 모달/검색창/상태 초기화
  duplicateModal.classList.add("hidden");
  duplicateList.innerHTML = "";
  const infoEl = document.getElementById("selected-info");
  infoEl.classList.add("hidden");
  infoEl.innerHTML = "";
  selectedCandidate = null;
  dupActiveIndex = -1;
  // 컨텍스트에 맞는 검색창 초기화/포커스
  if (
    typeof __lookupContext !== "undefined" &&
    __lookupContext === "exchange"
  ) {
    exLookupInput && ((exLookupInput.value = ""), exLookupInput.focus());
  } else {
    provLookupInput && ((provLookupInput.value = ""), provLookupInput.focus());
  }
  if (dupKeyHandler) {
    document.removeEventListener("keydown", dupKeyHandler, true);
    dupKeyHandler = null;
  }
});

function showDuplicateSelection(rows) {
  duplicateList.innerHTML = "";
  selectedCandidate = null;
  const confirmBtn = document.getElementById("confirm-duplicate");
  confirmBtn.disabled = true;

  const items = [];
  rows.forEach((row, i) => {
    const data = row;
    const li = document.createElement("li");

    // [수정] 리스트 아이템 내부 텍스트 다크모드 적용
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
      // [수정] 체크 아이콘 색상 다크모드 대응
      icon.className =
        "fas fa-square-check text-blue-600 dark:text-blue-400 mr-2";
      li.prepend(icon);

      selectedCandidate = { id: data.id, ...data };
      const infoEl = document.getElementById("selected-info");

      // [수정] 상세 정보 카드 디자인: 다크모드 배경, 보더, 텍스트 전면 수정
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

  if (dupKeyHandler) {
    document.removeEventListener("keydown", dupKeyHandler, true);
  }
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
    } else if (e.key === "Enter") {
      if (!confirmBtn.disabled) {
        e.preventDefault();
        e.stopPropagation();
        confirmBtn.click();
        return;
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeDuplicateModal.click();
    }
  };
  document.addEventListener("keydown", dupKeyHandler, true);
}

document
  .getElementById("confirm-duplicate")
  .addEventListener("click", async () => {
    if (duplicateList.classList.contains("hidden")) return;
    if (!selectedCandidate) return showToast("이용자를 선택하세요.", true);
    try {
      // 고객 문서 조회 후 '이번 달 방문' 및 '이번 분기 생명사랑 제공' 상태 확인
      const snap = await getDoc(doc(db, "customers", selectedCandidate.id));
      const data = snap.exists() ? snap.data() : {};
      const now = new Date();
      const currentMonth = toKstMonthKey(now); // YYYY-MM (KST)
      const periodKey = toKstPeriodKey(now); // 예: 24-25 (KST)
      const visitArr = (data.visits && data.visits[periodKey]) || [];
      const alreadyThisMonth =
        Array.isArray(visitArr) &&
        visitArr.some(
          (v) => typeof v === "string" && v.startsWith(currentMonth),
        );
      // 🔁 교환 탭 여부(또는 검색 컨텍스트)
      const isExchangeActive =
        __lookupContext === "exchange" ||
        document.querySelector(".tab-btn.active")?.dataset.tab === "exchange";

      // 교환 탭이면 '이번 달 방문'이어도 리스트에 추가 허용
      const qKey = getQuarterKey(now);
      const alreadyLife = !!(data.lifelove && data.lifelove[qKey]);
      const candidate = {
        ...selectedCandidate,
        ...data,
        _lifeloveThisQuarter: alreadyLife,
      };

      if (isExchangeActive) {
        // ✅ 교환: 제공 상태에 영향 없이 교환 쪽만 설정
        exchangeSelectedCustomer = candidate;
        renderExchangeCustomerInfo();
        loadRecentProvisionsForCustomer(exchangeSelectedCustomer.id);
        document.dispatchEvent(new Event("exchange_customer_switched"));
        saveExchangeAutoSave();
        showToast("교환 대상자가 선택되었어요.");
        // 이용자 선택이 끝났으므로 교환 섹션 표시
        if (exchangeSection) exchangeSection.classList.remove("hidden");
        exchangeHistorySection?.classList.remove("hidden");
      } else {
        // 제공: 기존 로직 유지(이번 달 방문 시 차단)
        if (alreadyThisMonth) {
          showToast("이미 이번 달 방문 처리된 이용자에요.", true);
        } else {
          if (!visitorList.some((v) => v.id === candidate.id)) {
            visitorList.push(candidate);
            renderVisitorList();
            saveVisitorDraft(visitorList);
            showToast("방문자 리스트에 추가되었어요.");
          } else {
            showToast("이미 리스트에 있는 이용자에요.", true);
          }
        }
      }
    } catch (err) {
      console.error(err);
      showToast("이용자 정보 확인 중 오류가 발생했어요.", true);
    } finally {
      // 모달/검색창 초기화
      duplicateModal.classList.add("hidden");
      duplicateList.innerHTML = "";
      const infoEl = document.getElementById("selected-info");
      infoEl.classList.add("hidden");
      infoEl.innerHTML = "";
      selectedCandidate = null;
      dupActiveIndex = -1;
      // 컨텍스트별 입력창 리셋/포커스
      if (__lookupContext === "exchange") {
        exLookupInput.value = "";
        exLookupInput.focus();
      } else {
        provLookupInput.value = "";
        provLookupInput.focus();
      }
      if (dupKeyHandler) {
        document.removeEventListener("keydown", dupKeyHandler, true);
        dupKeyHandler = null;
      }
    }
  });

// ── 상품 JIT 조회 헬퍼
async function findProductByBarcode(code) {
  if (productByBarcode.has(code)) return productByBarcode.get(code);
  const snap = await getDocs(
    query(collection(db, "products"), where("barcode", "==", code), limit(1)),
  );
  if (snap.empty) return null;
  const d = snap.docs[0];
  const p = { id: d.id, ...d.data() };
  productByBarcode.set(p.barcode, p);
  productById.set(p.id, p);
  return p;
}

let __nameAutoTimer = null;

// [추가] 전체 상품 로드 (최초 1회만 서버 통신)
async function ensureAllProductsLoaded() {
  // 이미 로드되었으면 서버 요청 없이 리턴 (비용 절감 핵심)
  if (_allProductsCache !== null) return;

  try {
    // 1) IndexedDB 캐시 우선 로드 (TTL 이내면 서버 스킵)
    const lastSynced = Number(
      localStorage.getItem(PRODUCT_CACHE_SYNC_KEY) || 0,
    );
    const fresh = lastSynced && Date.now() - lastSynced < PRODUCT_CACHE_TTL_MS;
    if (fresh) {
      const cached = await idbReadAllProducts();
      if (cached && cached.length > 0) {
        _allProductsCache = cached;
        // Map 동기화
        cached.forEach((p) => {
          productById.set(p.id, p);
          if (p.barcode) productByBarcode.set(p.barcode, p);
        });
        console.log(`상품 캐시(IDB) 로드: ${cached.length}개`);
        return;
      }
    }

    // 2) 서버에서 전체 로드 (필수불가결 요구사항 유지)
    const qy = query(collection(db, "products"), orderBy("name"));
    const snap = await getDocs(qy);

    _allProductsCache = [];

    snap.docs.forEach((d) => {
      const p = { id: d.id, ...d.data() };
      _allProductsCache.push(p);

      // 기존 Map들에도 동기화하여 바코드 스캔 등 다른 기능 지원
      productById.set(p.id, p);
      if (p.barcode) productByBarcode.set(p.barcode, p);
    });

    console.log(`상품 캐시 로드 완료: ${_allProductsCache.length}개`);

    // 3) 영속 저장
    try {
      await idbWriteAllProducts(_allProductsCache);
      localStorage.setItem(PRODUCT_CACHE_SYNC_KEY, String(Date.now()));
    } catch (e) {
      console.warn("상품 캐시(IDB) 저장 실패:", e);
    }
  } catch (err) {
    console.error("상품 로드 실패:", err);
    _allProductsCache = []; // 실패 시 빈 배열로 초기화
  }
}

// [수정] 상품명 검색 (로컬 캐시 기반: 대소문자 무시, 중간 글자 허용)
async function searchProductsByNamePrefix(keyword) {
  // 1. 데이터가 없으면 로드
  await ensureAllProductsLoaded();

  // 2. 검색어 정규화 (소문자 변환)
  const term = keyword.toLowerCase().trim();
  if (!term) return [];

  // 3. 자바스크립트로 필터링 (최대 10개만 반환)
  const matches = _allProductsCache.filter((p) => {
    const pName = (p.name || "").toLowerCase();
    // 상품명 포함 or 바코드 포함 검색
    return pName.includes(term) || (p.barcode && p.barcode.includes(term));
  });

  return matches.slice(0, 10);
}

let undoStack = [];
let redoStack = [];

undoBtn.addEventListener("click", () => {
  if (undoStack.length > 0) {
    redoStack.push([...selectedItems.map((item) => ({ ...item }))]);
    selectedItems = undoStack.pop();
    renderSelectedList();
  } else {
    showToast("되돌릴 작업이 없어요.", true);
  }
});

redoBtn.addEventListener("click", () => {
  if (redoStack.length > 0) {
    undoStack.push([...selectedItems.map((item) => ({ ...item }))]);
    selectedItems = redoStack.pop();
    renderSelectedList();
  } else {
    showToast("다시 실행할 작업이 없어요.", true);
  }
});

resetProductsBtn.addEventListener("click", () => {
  if (selectedItems.length === 0)
    return showToast("초기화할 물품이 없습니다.", true);

  undoStack.push([...selectedItems.map((item) => ({ ...item }))]);
  redoStack = [];
  selectedItems = [];
  renderSelectedList();
  showToast("물품 목록이 초기화되었어요.");
});

resetAllBtn.addEventListener("click", async () => {
  const ok = await openConfirm({
    title: "전체 초기화",
    message: "전체 초기화를 진행할까요?",
    variant: "warn",
    confirmText: "초기화",
    cancelText: "취소",
  });
  if (!ok) return;
  resetForm({ resetVisitors: true }); // 고객/상품 전체 초기화
  undoStack = [];
  redoStack = [];
  showToast("전체 초기화를 완료했어요.");
});

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "z" && !e.shiftKey) {
    e.preventDefault();
    undoBtn.click();
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    redoBtn.click();
  } else if (
    e.ctrlKey &&
    e.key === "Enter" &&
    !submitSection.classList.contains("hidden")
  ) {
    e.preventDefault();
    submitBtn.click();
  }
});

/* =========================================
   방문자 리스트 렌더링 (TDS 리팩토링 버전)
   ========================================= */
function renderVisitorList() {
  visitorListEl.innerHTML = "";

  // 1. 빈 상태 처리
  if (visitorList.length === 0) {
    visitorListSection.classList.add("hidden");
    try {
      clearVisitorDraft();
    } catch {}

    // 교환 탭이 아닐 경우 정보창 및 상품 섹션 초기화
    if (document.querySelector(".tab-btn.active")?.dataset.tab !== "exchange") {
      selectedCustomer = null;
      productSection.classList.add("hidden");
      submitSection.classList.add("hidden");
      renderProvisionCustomerInfo();
    }
    return;
  }

  // 2. 탭 상태에 따른 노출 제어
  const isExchangeActive =
    document.querySelector(".tab-btn.active")?.dataset.tab === "exchange";
  visitorListSection.classList.toggle("hidden", isExchangeActive);

  // 3. 리스트 아이템 생성
  visitorList.forEach((v) => {
    const hasHold = localStorage.getItem(HOLD_PREFIX + v.id);
    const isActive = selectedCustomer?.id === v.id;
    const li = document.createElement("li");

    // [수정] 패딩을 p-4로 줄이고, 최소 높이를 min-h-[160px] 정도로 컴팩트하게 조정
    li.className =
      "visitor-item group flex flex-col items-center justify-center p-4 py-5 text-center min-h-[160px] relative";
    if (isActive) li.classList.add("active");

    // 보류 배지 (크기를 줄여 우측 상단에 고정)
    const holdBadge = hasHold
      ? `<span class="badge badge-weak-warning badge-xs absolute top-3 right-3">
        <i class="fas fa-pause-circle pr-1"></i> 보류중
        </span>`
      : "";

    // 버튼 구성 (btn-sm을 사용하여 세로 부피 감소)
    let actionBtnHTML = isActive
      ? `<button class="deselect-btn btn btn-dark-weak btn-sm btn-full px-5" data-id="${v.id}">선택 해제</button>`
      : `<button class="select btn btn-primary-weak btn-sm btn-full px-8" data-id="${v.id}">선택</button>`;

    li.innerHTML = `
    ${holdBadge}
    
    <div class="text-xl font-black text-slate-900 dark:text-white mb-1 tracking-tight">
      ${v.name}
    </div>

    <div class="text-[13px] text-slate-400 dark:text-slate-500 font-medium mb-4 flex items-center justify-center gap-1.5">
      <span>${v.birth || "0000.00.00"}</span>
      <span class="text-slate-200 dark:text-slate-700">|</span>
      <span class="truncate max-w-[120px]">${v.phone || "연락처 없음"}</span>
    </div>

    <div class="flex items-center justify-center gap-2 w-full">
      ${actionBtnHTML}
      <button class="remove btn btn-danger-weak btn-sm !w-8 !h-8 !p-0 rounded-xl" data-id="${
        v.id
      }">
        <i class="fas fa-times text-xs"></i>
      </button>
    </div>
  `;

    visitorListEl.appendChild(li);
  });

  try {
    saveVisitorDraft(visitorList);
  } catch {}
}

visitorListEl?.addEventListener("click", async (e) => {
  const actionEl = e.target.closest("[data-id]");
  const id = actionEl?.dataset?.id;
  if (!id) return;
  const idx = visitorList.findIndex((v) => v.id === id);
  if (idx === -1) return;

  // 1. 삭제 버튼 (기존 로직 유지)
  if (e.target.classList.contains("remove") || e.target.closest(".remove")) {
    const targetId =
      e.target.dataset.id || e.target.closest(".remove").dataset.id;

    if (selectedCustomer?.id === targetId && selectedItems.length > 0) {
      const ok = await openConfirm({
        title: "선택 해제",
        message: "현재 장바구니가 있어요. 이 방문자를 리스트에서 제거할까요?",
        variant: "warn",
        confirmText: "제거",
        cancelText: "취소",
      });
      if (!ok) return;
    }
    if (selectedCustomer?.id === targetId) {
      // 선택된 사람 삭제 시 선택 해제 로직 수행
      selectedCustomer = null;
      selectedItems = [];
      renderSelectedList();
      clearProvisionDraft();
      productSection.classList.add("hidden");
      submitSection.classList.add("hidden");
      renderProvisionCustomerInfo();
    }
    localStorage.removeItem(HOLD_PREFIX + targetId);

    visitorList = visitorList.filter((v) => v.id !== targetId);
    renderVisitorList();
    saveVisitorDraft(visitorList);
    return;
  }

  // [추가] 2. 선택 해제 버튼 클릭 시
  if (
    e.target.classList.contains("deselect-btn") ||
    e.target.closest(".deselect-btn")
  ) {
    // 장바구니가 있으면 경고 (선택 사항)
    if (selectedItems.length > 0) {
      const ok = await openConfirm({
        title: "선택 해제",
        message:
          "작성 중인 장바구니가 있어요. 선택을 해제할까요? (내용은 유지됩니다)",
        confirmText: "해제",
        cancelText: "취소",
      });
      if (!ok) return;
    }

    // 선택 해제 수행
    selectedCustomer = null;
    // (선택사항) 장바구니를 비울지, 유지할지 결정. 여기선 UI만 숨김(Draft 유지)
    // selectedItems = []; // 비우고 싶으면 주석 해제

    productSection.classList.add("hidden");
    submitSection.classList.add("hidden");
    renderProvisionCustomerInfo(); // 정보 카드 숨김
    renderVisitorList(); // 버튼 상태 갱신 (다시 '선택'으로)
    clearProvisionDraft();
    return;
  }

  // 3. 선택 버튼 클릭 (기존 로직 + UI 업데이트)
  if (e.target.classList.contains("select") || e.target.closest(".select")) {
    if (
      selectedCustomer &&
      selectedItems.length > 0 &&
      selectedCustomer.id !== id
    ) {
      const ok = await openConfirm({
        title: "방문자 전환",
        message: "현재 장바구니가 있어요. 전환할까요? (보류 저장을 권장해요)",
        variant: "warn",
        confirmText: "전환",
        cancelText: "취소",
      });
      if (!ok) return;
    }
    selectedCustomer = visitorList[idx];

    const _ex =
      document.querySelector(".tab-btn.active")?.dataset.tab === "exchange";
    if (!_ex) {
      productSection.classList.remove("hidden");
      submitSection.classList.remove("hidden");
    }
    renderProvisionCustomerInfo();

    selectedItems = [];
    undoStack = [];
    redoStack = [];
    lifeloveCheckbox.checked = false;

    try {
      const holdRaw = localStorage.getItem(HOLD_PREFIX + selectedCustomer.id);
      if (holdRaw) {
        const okLoad = await openConfirm({
          title: "보류 불러오기",
          message: "이 방문자에 저장된 보류 장바구니가 있어요. 불러올까요?",
          variant: "warn",
          confirmText: "불러오기",
          cancelText: "새로 시작",
        });

        if (okLoad) {
          // 1. 불러오기 선택 시
          try {
            const parsed = JSON.parse(holdRaw);
            if (Array.isArray(parsed)) {
              selectedItems = parsed;
              showToast("보류 장바구니를 불러왔어요.");
            }
          } catch {}
        } else {
          // 2. [추가] 새로 시작 선택 시 -> 기존 보류 데이터 삭제
          localStorage.removeItem(HOLD_PREFIX + selectedCustomer.id);
          showToast("보류 데이터를 삭제하고 새로 시작합니다.");
        }
      }
    } catch {}

    renderSelectedList();
    renderVisitorList(); // Active 상태 갱신
    saveProvisionDraft();

    if (!_ex && typeof barcodeInput !== "undefined" && barcodeInput) {
      try {
        barcodeInput.focus();
      } catch {}
    }
    document.dispatchEvent(new Event("provision_customer_switched"));

    setTimeout(() => scrollToSubmitSection(), 10);
  }
});

const barcodeInput = document.getElementById("barcode-input");
const nameInput = document.getElementById("name-input");
const quantityInput = document.getElementById("quantity-input");
const addProductBtn = document.getElementById("add-product-btn");
const selectedTableBody = document.querySelector("#selected-table tbody");
const totalPointsEl = document.getElementById("total-points");
const warningEl = document.getElementById("point-warning");
const autocompleteList = document.getElementById("autocomplete-list");

let __scrollAfterAdd = false;

// ✅ submit 섹션으로 부드럽게 스크롤
function scrollToSubmitSection(offset = 0) {
  const sec = document.getElementById("submit-section");
  if (!sec) return;
  try {
    // 헤더가 고정된 경우를 고려해 살짝 위로 보정
    const fixedHeader =
      document.querySelector("header.header") ||
      document.getElementById("header-container");
    const headerH = fixedHeader
      ? fixedHeader.getBoundingClientRect().height
      : 0;
    const top =
      sec.getBoundingClientRect().top +
      window.pageYOffset -
      (offset || headerH || 8);
    window.scrollTo({ top, behavior: "smooth" });
  } catch {
    sec.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// ✅ 바코드: Enter → EAN-13 검증 → 존재하면 1개 추가 / 없으면 빠른 등록 유도
barcodeInput.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const code = barcodeInput.value.trim();
  if (!code) return showToast("바코드를 입력하세요.", true);
  if (!isValidEAN13(code)) {
    barcodeInput.value = "";
    barcodeInput.focus();
    return showToast("유효한 바코드가 아니에요.", true);
  }
  // 전량 선로딩 제거: 단건 조회로 대체
  const hit = await findProductByBarcode(code);
  if (hit) {
    addToSelected(hit, parseInt(quantityInput.value) || 1);
    afterAddCleanup();
    return;
  }
  const ok = await openConfirm({
    title: "미등록 바코드",
    message: "해당 바코드의 상품이 없어요. 등록할까요?",
    confirmText: "등록",
    cancelText: "취소",
    variant: "warn",
  });
  if (ok) openQuickCreateModal(code);
});

// ✅ 상품명: Enter → 수량 포커스 / ESC → 자동완성 닫기
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    quantityInput.focus();
  } else if (e.key === "Escape") {
    autocompleteList.classList.add("hidden");
  }
});

quantityInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addProductBtn.click();
  }
});

addProductBtn.addEventListener("click", async () => {
  const q = parseInt(quantityInput.value) || 1;
  const code = barcodeInput.value.trim();
  const nameKey = nameInput.value.trim();
  if (!code && !nameKey)
    return showToast("바코드 또는 상품명을 입력하세요.", true);
  try {
    // 1) 바코드 우선 경로
    if (code) {
      if (!isValidEAN13(code)) {
        barcodeInput.value = "";
        barcodeInput.focus();
        return showToast("유효한 바코드가 아니에요.", true);
      }
      const byCode = await findProductByBarcode(code);
      if (!byCode) {
        const ok = await openConfirm({
          title: "미등록 바코드",
          message: "해당 바코드의 상품이 없어요. 등록할까요?",
          confirmText: "등록",
          cancelText: "취소",
          variant: "warn",
        });
        if (ok) openQuickCreateModal(code);
        return;
      }
      addToSelected(byCode, q);
      afterAddCleanup();
      return;
    }
    // 2) 상품명 보조 경로
    const rows = await searchProductsByNamePrefix(nameKey);
    const picked =
      rows.find(
        (p) => (p.name || "").toLowerCase() === nameKey.toLowerCase(),
      ) || rows[0];
    if (!picked) return showToast("해당 상품을 찾을 수 없어요.", true);
    addToSelected(picked, q);
    afterAddCleanup();
  } catch (err) {
    console.error(err);
    showToast("상품 추가 중 오류가 발생했어요.", true);
  }
});

// ✅ 자동완성은 '상품명' 입력에서만 동작(숫자 13자리=바코드면 자동완성 숨김)
nameInput.addEventListener("input", async () => {
  const keyword = nameInput.value.trim();
  if (__nameAutoTimer) clearTimeout(__nameAutoTimer);
  __nameAutoTimer = setTimeout(async () => {
    if (!keyword || keyword.length < 2 || /^\d{13}$/.test(keyword)) {
      autocompleteList.classList.add("hidden");
      return;
    }
    try {
      const reqId = ++nameReqSeq;
      const rows = await searchProductsByNamePrefix(keyword);
      if (reqId !== nameReqSeq) return; // ⚑ 최신 입력이 아니면 무시
      renderAutocomplete(rows);
    } catch {
      autocompleteList.classList.add("hidden");
    }
  }, 250);
});

function renderAutocomplete(matches) {
  autocompleteList.innerHTML = "";
  if (matches.length === 0) {
    autocompleteList.classList.add("hidden");
    return;
  }
  matches.forEach((product) => {
    const div = document.createElement("div");
    // [수정] 다크모드 대응: 텍스트(흰색), 배경(어두운 슬레이트), 호버(어두운 파랑/회색), 보더
    div.className =
      "px-4 py-3 text-sm text-slate-700 dark:text-slate-200 font-medium cursor-pointer hover:bg-blue-50 dark:hover:bg-slate-700 transition-colors border-b border-slate-50 dark:border-slate-700/50 last:border-none flex justify-between items-center";

    // 가격 텍스트 색상 조정
    div.innerHTML = `<span>${product.name}</span> <span class="text-xs text-slate-400 dark:text-slate-500 font-normal">${product.price}p</span>`;

    div.addEventListener("click", () => {
      nameInput.value = product.name;
      quantityInput.focus();
      autocompleteList.classList.add("hidden");
    });
    autocompleteList.appendChild(div);
  });
  autocompleteList.classList.remove("hidden");
}

// ===== 공통 유틸: 담기, EAN-13, 클린업 =====
function addToSelected(prod, qty) {
  undoStack.push([...selectedItems.map((it) => ({ ...it }))]);
  redoStack = [];
  const ex = selectedItems.find((it) => it.id === prod.id);
  if (ex) {
    ex.quantity = ex.quantity + qty;
    showToast(`${prod.name}의 수량이 ${qty}개 증가했어요.`);
  } else {
    selectedItems.push({
      id: prod.id,
      name: prod.name,
      category: prod.category || "",
      price: prod.price || 0,
      quantity: qty,
    });
  }
  __scrollAfterAdd = true;
  renderSelectedList();
}
function isValidEAN13(code) {
  if (!/^\d{13}$/.test(code)) return false;
  const arr = code.split("").map(Number);
  const check = arr.pop();
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += i % 2 === 0 ? arr[i] : arr[i] * 3;
  const calc = (10 - (sum % 10)) % 10;
  return calc === check;
}
function afterAddCleanup() {
  barcodeInput.value = "";
  nameInput.value = "";
  quantityInput.value = "";
  autocompleteList.classList.add("hidden");
  barcodeInput.focus();
}

// ===== 빠른 등록 모달(HTML 마크업 재사용) =====
const qcModal = document.getElementById("quick-create-modal");
const qcName = document.getElementById("qc-name");
const qcCat = document.getElementById("qc-category");
const qcPrice = document.getElementById("qc-price");
const qcBarcode = document.getElementById("qc-barcode");
const qcSaveBtn = document.getElementById("qc-save");
const qcCloseBtn = document.getElementById("qc-close");

function openQuickCreateModal(prefillBarcode = "") {
  qcName.value = "";
  qcCat.value = "";
  qcPrice.value = "";
  qcBarcode.value = prefillBarcode;
  qcModal.classList.remove("hidden");
  qcModal.setAttribute("aria-hidden", "false");
  setTimeout(() => (qcName.value ? qcPrice : qcName).focus(), 0);
}
function closeQuickCreateModal() {
  qcModal.classList.add("hidden");
  qcModal.setAttribute("aria-hidden", "true");
}
qcCloseBtn?.addEventListener("click", closeQuickCreateModal);
qcModal?.addEventListener("click", (e) => {
  if (e.target === qcModal) closeQuickCreateModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !qcModal.classList.contains("hidden"))
    closeQuickCreateModal();
});

qcSaveBtn?.addEventListener("click", async () => {
  const name = qcName.value.trim();
  const category = qcCat.value.trim();
  const price = parseFloat(qcPrice.value);
  const barcode = qcBarcode.value.trim();
  if (!name || !barcode || !Number.isFinite(price) || price < 0)
    return showToast("상품명/바코드/가격을 확인하세요.", true);
  if (!isValidEAN13(barcode)) {
    barcodeInput.value = "";
    barcodeInput.focus();
    return showToast("유효한 바코드가 아니에요.", true);
  }
  // 0.5 단위 체크(선택)
  if (Math.round(price * 2) !== price * 2)
    return showToast("가격은 0.5 단위로 입력하세요.", true);
  try {
    // 동일 바코드가 이미 있으면 신규 생성 대신 그 상품을 담기
    const exist = await findProductByBarcode(barcode);
    if (exist) {
      addToSelected(exist, parseInt(quantityInput.value) || 1);
      showToast("이미 존재하는 상품이에요. 장바구니에 추가할게요.");
      closeQuickCreateModal();
      afterAddCleanup();
      return;
    }
    const ref = await addDoc(collection(db, "products"), {
      name,
      category,
      price,
      barcode,
      nameLower: normalize(name),
      createdAt: serverTimestamp(),
      lastestAt: serverTimestamp(),
    });
    const prod = { id: ref.id, name, category, price, barcode };
    productById.set(prod.id, prod);
    if (barcode) productByBarcode.set(barcode, prod);
    if (_allProductsCache) {
      _allProductsCache.push(prod);
    }
    addToSelected(prod, parseInt(quantityInput.value) || 1); // 장바구니에도 바로 추가
    showToast("상품이 등록되었어요.");
    closeQuickCreateModal();
    afterAddCleanup();
  } catch (e) {
    console.error(e);
    showToast("상품 등록을 실패했어요.", true);
  }
});

/* =========================
    제한 정책: 검사/강조
   ========================= */
function checkCategoryViolations(items, policies) {
  const violations = []; // {category, mode, limit, price?}
  if (!items?.length) return violations;
  const byCat = new Map();
  for (const it of items) {
    const cat = (it.category || "").trim();
    if (!cat) continue;
    const arr = byCat.get(cat) || [];
    arr.push(it);
    byCat.set(cat, arr);
  }
  for (const [cat, arr] of byCat) {
    const pol = policies?.[cat];
    if (!pol || pol.active === false) continue;
    // 하위호환: one_per_* → limit=1 로 간주
    const mode =
      pol.mode === "one_per_category"
        ? "category"
        : pol.mode === "one_per_price"
          ? "price"
          : pol.mode === "price"
            ? "price"
            : "category";
    const limit =
      Number.isFinite(pol.limit) && pol.limit >= 1 ? Math.floor(pol.limit) : 1;
    if (mode === "category") {
      const total = arr.reduce((a, b) => a + (b.quantity || 0), 0);
      if (total > limit) violations.push({ category: cat, mode, limit });
    } else if (mode === "price") {
      const byPrice = new Map();
      for (const it of arr) {
        const key = String(it.price ?? "");
        byPrice.set(key, (byPrice.get(key) || 0) + (it.quantity || 0));
      }
      for (const [price, cnt] of byPrice) {
        if (cnt > limit) violations.push({ category: cat, mode, limit, price });
      }
    }
  }
  return violations;
}

function applyCategoryViolationHighlight() {
  const vios = checkCategoryViolations(selectedItems, categoryPolicies);
  const violating = new Set(); // key: violating item ID

  // 1. 위반된 상품 ID 수집
  if (vios.length) {
    for (const v of vios) {
      selectedItems.forEach((it) => {
        if ((it.category || "") !== v.category) return;
        if (v.mode === "category") {
          violating.add(it.id);
        } else if (v.mode === "price") {
          if (String(it.price ?? "") === String(v.price)) violating.add(it.id);
        }
      });
    }
  }

  // 2. 테이블 행(tr)에 스타일 클래스 적용
  [...selectedTableBody.children].forEach((tr) => {
    const id = tr.dataset.id;
    if (violating.has(id)) {
      tr.classList.add("limit-violation");
    } else {
      tr.classList.remove("limit-violation");
    }
  });

  // 3. [복구] 하단 경고 뱃지 표시/숨김 제어
  const limitWarnEl = document.getElementById("limit-warning");
  if (limitWarnEl) {
    // toggleFade는 comp.js에 있는 유틸 함수 (없으면 classList 제어로 대체됨)
    if (typeof toggleFade === "function") {
      toggleFade(limitWarnEl, vios.length > 0);
    } else {
      // fallback
      if (vios.length > 0) limitWarnEl.classList.remove("hidden");
      else limitWarnEl.classList.add("hidden");
    }
  }
}

/* =========================================
   상품 목록 렌더링 (TDS Numeric Spinner 적용)
   ========================================= */
function renderSelectedList() {
  selectedTableBody.innerHTML = "";

  // 1. 빈 상태(Empty State) - TDS 스타일
  if (selectedItems.length === 0) {
    renderEmptyState(
      selectedTableBody,
      "장바구니가 비어있습니다",
      "fa-basket-shopping",
      "바코드를 스캔하거나 상품명을 검색하세요",
    );

    totalPointsEl.textContent = "0";
    if (warningEl) toggleFade(warningEl, false);

    // ✅ 구매 제한 초과 뱃지도 확실히 숨김 (빈 상태에서는 applyCategoryViolationHighlight가 호출되지 않음)
    const limitWarnEl = document.getElementById("limit-warning");
    if (limitWarnEl) {
      if (typeof toggleFade === "function") toggleFade(limitWarnEl, false);
      else limitWarnEl.classList.add("hidden");
    }

    saveProvisionDraft();
    return;
  }

  // 2. 상품 목록 렌더링
  selectedItems.forEach((item, idx) => {
    const tr = document.createElement("tr");
    const totalPrice = item.quantity * item.price;

    // [중요] 부분 업데이트를 위해 ID 부여: row-{idx}
    tr.id = `row-${idx}`;
    // [TDS] 행 스타일
    tr.className =
      "hover:bg-slate-50/50 dark:hover:bg-slate-700/20 transition-all border-b border-slate-100 dark:border-slate-700/50 last:border-0 group";

    tr.innerHTML = `
      <td class="py-4 px-5">
        <div class="flex flex-col">
          <span class="font-bold text-slate-800 dark:text-slate-100">${
            item.name
          }</span>
          <span class="text-[11px] text-slate-400 dark:text-slate-500 font-medium uppercase mt-0.5">${
            item.category || "미분류"
          }</span>
        </div>
      </td>
      <td class="py-4 px-5 text-center">
        <div class="numeric-spinner mx-auto">
          <button class="spinner-btn decrease-btn" data-idx="${idx}" ${
            item.quantity <= 1 ? "disabled" : ""
          }>
            <i class="fas fa-minus text-sm pointer-events-none"></i>
          </button>
          
          <div class="spinner-value-box">
            <input type="number" 
                   id="qty-${idx}" 
                   value="${item.quantity}" 
                   data-idx="${idx}" 
                   class="spinner-input quantity-input" 
                    />
          </div>
          
          <button class="spinner-btn increase-btn" data-idx="${idx}">
            <i class="fas fa-plus text-sm pointer-events-none"></i>
          </button>
        </div>
      </td>
      <td class="py-4 px-5 text-center text-slate-500 dark:text-slate-400 font-bold text-[15px]">${
        item.price
      }</td>
      <td class="py-4 px-5 text-center">
        <span id="total-${idx}" class="text-slate-900 dark:text-white font-black text-lg tracking-tight">${totalPrice.toLocaleString()}</span>
      </td>
      <td class="py-4 px-5 text-center">
        <button class="remove-btn btn btn-danger-weak !w-9 !h-9 !p-0 rounded-xl transition-opacity shadow-sm" data-idx="${idx}" title="삭제">
          <i class="fas fa-trash-alt text-sm pointer-events-none"></i>
        </button>
      </td>
    `;

    // 데이터 속성 바인딩
    tr.dataset.id = item.id;
    tr.dataset.category = item.category || "";
    tr.dataset.price = String(item.price ?? "");
    selectedTableBody.appendChild(tr);

    // [핵심] 롱프레스 이벤트 연결 (렌더링 직후 개별 바인딩)
    // 주의: setupLongPress는 위에서 정의한 유틸 함수여야 함
    const decBtn = tr.querySelector(".decrease-btn");
    const incBtn = tr.querySelector(".increase-btn");

    if (decBtn && incBtn) {
      // 클로저로 idx 캡처하여 전달
      setupLongPress(decBtn, () => changeQuantity(idx, -1));
      setupLongPress(incBtn, () => changeQuantity(idx, 1));
    }
  });

  // 전체 합계 계산 (UI 갱신 포함)
  updateTotalUIonly();
  applyCategoryViolationHighlight();
  saveProvisionDraft();

  if (__scrollAfterAdd) {
    setTimeout(() => scrollToSubmitSection(), 50);
    __scrollAfterAdd = false;
  }
}

document.querySelector("#selected-table tbody").addEventListener(
  "blur",
  (e) => {
    if (e.target.classList.contains("quantity-input")) {
      let val = parseInt(e.target.value, 10);

      if (isNaN(val) || val < 1) {
        e.target.value = 1;
        showToast("수량은 1 이상이어야 해요.");
      }
    }
  },
  true,
); // ← true로 설정해야 '이벤트 캡처링'이 동작해서 위임 가능

selectedTableBody.addEventListener("click", (e) => {
  // 아이콘을 눌러도 버튼을 찾도록 closest 사용
  const btn = e.target.closest("button");
  if (!btn) return;

  const idx = btn.dataset.idx;

  // 1. 삭제 버튼 (remove-btn)
  if (btn.classList.contains("remove-btn")) {
    // Undo 스택 저장
    undoStack.push(JSON.parse(JSON.stringify(selectedItems)));
    redoStack = [];

    selectedItems.splice(Number(idx), 1);
    renderSelectedList(); // 삭제는 리스트가 줄어드니 전체 렌더링 필요
    showToast("상품이 삭제되었어요.");
    return;
  }

  // (증가/감소 버튼은 setupLongPress가 직접 이벤트를 걸었으므로 여기서 처리 안 함)
});

selectedTableBody.addEventListener("change", (e) => {
  if (e.target.classList.contains("quantity-input")) {
    undoStack.push([...selectedItems.map((item) => ({ ...item }))]);
    redoStack = [];

    const idx = e.target.dataset.idx;
    const val = parseInt(e.target.value);
    if (val >= 1) {
      selectedItems[idx].quantity = val;
      renderSelectedList();
    }
  }
});

// 합계 계산 함수 (toggleFade 적용)
function calculateTotal() {
  const total = selectedItems.reduce(
    (acc, item) => acc + item.quantity * item.price,
    0,
  );

  if (totalPointsEl) totalPointsEl.textContent = total.toLocaleString();

  // [수정] 30포인트 초과 시 fade-in, 이하일 때 fade-out
  if (warningEl) {
    toggleFade(warningEl, total > 30);
  }
}

/* =========================
   보류: localStorage 저장/불러오기
   ========================= */
const holdSaveBtn = document.getElementById("hold-save-btn");
const holdLoadBtn = document.getElementById("hold-load-btn");

holdSaveBtn?.addEventListener("click", () => {
  if (!selectedCustomer) return showToast("먼저 방문자를 선택하세요.", true);
  localStorage.setItem(
    HOLD_PREFIX + selectedCustomer.id,
    JSON.stringify(selectedItems),
  );
  // ✅ 보류 시: 장바구니/입력 초기화 + 계산/제출 UI 숨김 + 고객정보도 숨김 + 방문자 선택 해제
  selectedItems = [];
  undoStack = [];
  redoStack = [];
  renderSelectedList();
  barcodeInput.value = "";
  quantityInput.value = "";
  productSection.classList.add("hidden");
  submitSection.classList.add("hidden");
  // 고객 정보 패널 숨김 및 선택 해제
  selectedCustomer = null;
  provisionCustomerInfoDiv.innerHTML = "";
  renderProvisionCustomerInfo(); // selectedCustomer가 null이면 hidden 처리됨
  renderVisitorList(); // active 표시 해제
  clearProvisionDraft();

  showToast("보류 처리되었어요.");
});

holdLoadBtn?.addEventListener("click", () => {
  if (!selectedCustomer) return showToast("먼저 방문자를 선택하세요.", true);
  const raw = localStorage.getItem(HOLD_PREFIX + selectedCustomer.id);
  if (!raw) return showToast("저장된 보류 데이터가 없어요.", true);
  try {
    selectedItems = JSON.parse(raw) || [];
    undoStack = [];
    redoStack = [];
    renderSelectedList();
    showToast("보류된 데이터를 불러왔어요.");
  } catch {
    showToast("보류 데이터가 손상되었어요.", true);
  }
});

// ✅ 제공 등록 제출
submitBtn.addEventListener("click", async () => {
  if (!selectedCustomer || selectedItems.length === 0)
    return showToast("이용자와 상품을 모두 선택하세요.", true);

  const total = selectedItems.reduce(
    (acc, item) => acc + item.quantity * item.price,
    0,
  );
  if (total > 30) return showToast("포인트가 초과되었어요.", true);

  // ✅ 현재 로그인한 사용자 확인
  const currentUser = auth.currentUser;
  if (!currentUser) {
    showToast("로그인된 사용자를 확인할 수 없어요.", true);
    return;
  }

  const now = new Date();
  const periodKey = toKstPeriodKey(now); // 예: 24-25 (KST)
  const visitDate = toKstDateKey(now); // YYYY-MM-DD (KST)
  const quarterKey = getQuarterKey(now);
  const lifelove = lifeloveCheckbox.checked;

  // 🔔 이번 분기 생명사랑 중복 제공 확인
  if (lifelove && selectedCustomer && selectedCustomer._lifeloveThisQuarter) {
    const okLife = await openConfirm({
      title: "생명사랑 중복 제공",
      message:
        "이 이용자는 이번 분기에 이미 생명사랑을 제공받았어요. 계속 진행할까요?",
      variant: "warn",
      confirmText: "계속",
      cancelText: "취소",
    });
    if (!okLife) return;
  }

  // ✅ 제한 위반 검사 → 있으면 Confirm
  const vios = checkCategoryViolations(selectedItems, categoryPolicies);
  if (vios.length) {
    const msg = vios
      .map((v) =>
        v.mode === "price"
          ? `<b>• ${v.category} - 가격 ${v.price}은(는) ${v.limit}개까지 가능해요.</b>`
          : `<b>• ${v.category} - 이 분류는 총 ${v.limit}개까지 가능해요.</b>`,
      )
      .join("<br>");
    const ok = await openConfirm({
      title: "제한 상품 중복",
      message: `현재 아래 분류의 제한 수량을 초과했어요.<br>${msg}<br>계속 진행할까요?`,
      variant: "warn",
      confirmText: "계속",
      cancelText: "취소",
    });
    if (!ok) return;
  }

  // ⚑ 더블클릭/중복 제출 방지
  if (window.__submitting) return;
  window.__submitting = true;
  submitBtn.disabled = true;
  const processedCustomerID = selectedCustomer?.id || null;
  const processedCustomerName = selectedCustomer?.name || "";
  const processedCustomerBirth = selectedCustomer?.birth || "";
  try {
    // ✅ 배치로 원자적 커밋 + 서버시간
    const batch = writeBatch(db);
    const provRef = doc(collection(db, "provisions"));
    batch.set(provRef, {
      customerId: processedCustomerID,
      customerName: processedCustomerName,
      customerBirth: processedCustomerBirth,
      items: selectedItems,
      total,
      timestamp: serverTimestamp(),
      handledBy: currentUser.email,
      lifelove,
      quarterKey,
    });
    const customerRef = doc(db, "customers", processedCustomerID);
    const updates = {
      [`visits.${periodKey}`]: arrayUnion(visitDate),
      ...(lifelove ? { [`lifelove.${quarterKey}`]: true } : {}),
      // 최근 방문 denormalized 필드(표시/정렬용) — write 수 증가 없음(동일 update 내 포함)
      lastVisit: visitDate.replace(/-/g, "."),
      lastVisitKey: visitDate.replace(/-/g, ""), // "YYYYMMDD"
      lastVisitAt: serverTimestamp(),
    };
    batch.update(customerRef, updates);
    await batch.commit();

    await ensureVisitAndDailyCounter(
      db,
      processedCustomerID,
      processedCustomerName,
      new Date(),
      selectedItems,
    );

    if (processedCustomerID) {
      visitorList = visitorList.filter((v) => v.id !== processedCustomerID);
      renderVisitorList();
      // ✅ 제공 등록으로 항목 제거 직후에도 localStorage 동기화
      try {
        if (visitorList.length === 0) clearVisitorDraft();
        else saveVisitorDraft(visitorList);
      } catch {}
    }

    showToast("제공 등록이 완료되었어요.");
    localStorage.removeItem(HOLD_PREFIX + processedCustomerID);
    resetForm();
  } catch (err) {
    console.error(err);
    showToast("제공 등록을 실패했어요.", true);
  } finally {
    window.__submitting = false;
    submitBtn.disabled = false;
  }
});

function resetForm({ resetVisitors = false } = {}) {
  provLookupInput.value = "";
  provisionCustomerInfoDiv.classList.add("hidden");
  productSection.classList.add("hidden");
  submitSection.classList.add("hidden");
  provisionCustomerInfoDiv.innerHTML = "";
  selectedCustomer = null;
  selectedItems = [];
  if (resetVisitors) {
    visitorList = [];
  }
  renderVisitorList();
  renderSelectedList();
  lifeloveCheckbox.checked = false;
  clearProvisionDraft();
  // 교환 섹션 자체도 숨김(초기 화면처럼)
  if (exchangeSection) exchangeSection.classList.add("hidden");
  // 교환 탭 고객정보도 안전하게 숨김
  exchangeSelectedCustomer = null;
  renderExchangeCustomerInfo();
}

// ✅ lifelove 체크 변경도 저장
lifeloveCheckbox?.addEventListener("change", () => {
  saveProvisionDraft();
});

/* =========================
   교환(최근 50일, 환불 없음)
   ========================= */

// DOM
const exchangeHistoryTbody = document.querySelector(
  "#exchange-history-table tbody",
);
const exchangeBuilder = document.getElementById("exchange-builder");
const exBarcode = document.getElementById("ex-barcode-input");
const exName = document.getElementById("ex-name-input");
const exQty = document.getElementById("ex-quantity-input");
const exAddBtn = document.getElementById("ex-add-product-btn");
const exTableBody = document.querySelector("#exchange-table tbody");
const exOriginalEl = document.getElementById("ex-original-total");
const exNewEl = document.getElementById("ex-new-total");
const exWarnEl = document.getElementById("ex-warning");
const exLimitWarnEl = document.getElementById("ex-limit-warning");
const exSubmitBtn = document.getElementById("exchange-submit-btn");
const exHistoryTable = document.getElementById("exchange-history-table");
// 교환 히스토리 섹션(표 래퍼)
const exchangeHistorySection = document.getElementById(
  "exchange-history-section",
);

// === 교환 입력 자동완성 ===
let __exNameAutoTimer = null;
let exNameReqSeq = 0;

// 교환용 자동완성 리스트가 없으면 생성
let exAutocompleteList = document.getElementById("ex-autocomplete-list");
if (!exAutocompleteList && exName) {
  exAutocompleteList = document.createElement("div");
  exAutocompleteList.id = "ex-autocomplete-list";
  exAutocompleteList.className = "autocomplete-list";
  (exName.parentElement || exchangeBuilder || document.body).appendChild(
    exAutocompleteList,
  );
}

// 교환용 이름 입력 자동완성
exName?.addEventListener("input", async () => {
  const keyword = exName.value.trim();
  if (__exNameAutoTimer) clearTimeout(__exNameAutoTimer);
  __exNameAutoTimer = setTimeout(async () => {
    if (!keyword || keyword.length < 2 || /^\d{13}$/.test(keyword)) {
      exAutocompleteList?.classList.add("hidden");
      return;
    }
    try {
      const reqId = ++exNameReqSeq;
      const rows = await searchProductsByNamePrefix(keyword);
      if (reqId !== exNameReqSeq) return; // 최신 입력만 반영
      renderExAutocomplete(rows);
    } catch {
      exAutocompleteList?.classList.add("hidden");
    }
  }, 250);
});

function renderExAutocomplete(matches) {
  if (!exAutocompleteList) return;
  exAutocompleteList.innerHTML = "";

  if (!matches || matches.length === 0) {
    exAutocompleteList.classList.add("hidden");
    return;
  }

  matches.forEach((product) => {
    const div = document.createElement("div");
    // [수정] 다크모드 대응: 배경, 텍스트, 호버, 보더
    div.className =
      "px-4 py-3 text-sm text-slate-700 dark:text-slate-200 font-medium cursor-pointer hover:bg-blue-50 dark:hover:bg-slate-700 transition-colors border-b border-slate-50 dark:border-slate-700/50 last:border-none flex justify-between items-center";

    div.innerHTML = `<span>${
      product.name
    }</span> <span class="text-xs text-slate-400 dark:text-slate-500 font-normal">${
      product.price || 0
    }p</span>`;

    div.addEventListener("click", () => {
      exName.value = product.name;
      exQty?.focus();
      exAutocompleteList.classList.add("hidden");
    });
    exAutocompleteList.appendChild(div);
  });
  exAutocompleteList.classList.remove("hidden");
}

// 교환 입력영역 밖을 클릭하면 자동완성 닫기
document.addEventListener("click", (e) => {
  if (!e.target.closest("#exchange-builder")) {
    exAutocompleteList?.classList.add("hidden");
  }
});

let exchangeItems = [];
let exchangeOriginalItems = [];
let exchangeOriginalTotal = 0;
let exchangeProvision = null; // { id, data }

// 교환 탭 Undo/Redo 및 자동저장용 변수
let exUndoStack = [];
let exRedoStack = [];
const EXCHANGE_AUTOSAVE_PREFIX = "fm.exchange.autosave";

function getExAutoSaveKey() {
  const uid = (auth.currentUser && auth.currentUser.uid) || "local";
  // 날짜별로 격리 (오늘 작업분만 유효)
  return `${EXCHANGE_AUTOSAVE_PREFIX}:${uid}:${ymdLocal()}`;
}

async function loadRecentProvisionsForCustomer(customerId) {
  if (!customerId || !exchangeHistoryTbody) return;
  // 최근 50일
  const fiftyAgo = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000);
  const qy = query(
    collection(db, "provisions"),
    where("customerId", "==", customerId),
    where("timestamp", ">=", fiftyAgo),
    orderBy("timestamp", "asc"), // 인덱스: [customerId ASC, timestamp ASC] 권장
  );
  const snap = await getDocs(qy);
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderExchangeHistory(rows);
}

function renderExchangeHistory(rows) {
  exchangeHistoryTbody.innerHTML = "";
  exchangeHistorySection?.classList.remove("hidden");
  exHistoryTable?.classList.remove("hidden");

  // [수정] 내역 없음(Empty State) 디자인 개선
  // [수정] Empty State 중앙화
  if (!rows.length) {
    renderEmptyState(
      exchangeHistoryTbody,
      "최근 50일 내 제공 내역이 없습니다.",
      "fa-history",
    );
    exchangeBuilder.classList.add("hidden");
    return;
  }

  rows.forEach((r) => {
    const ts = r.timestamp?.toDate
      ? r.timestamp.toDate()
      : new Date(r.timestamp);
    const when = ts
      ? `${ts.getFullYear()}.${String(ts.getMonth() + 1).padStart(
          2,
          "0",
        )}.${String(ts.getDate()).padStart(2, "0")} ${String(
          ts.getHours(),
        ).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`
      : "-";

    const tr = document.createElement("tr");
    // [수정] 테이블 행 다크모드 대응 (Hover, Border, Text)
    tr.className =
      "hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors border-b border-slate-100 dark:border-slate-700/50 last:border-0";

    tr.innerHTML = `
      <td class="py-3 px-4 text-sm text-slate-600 dark:text-slate-400">${when}</td>
      <td class="py-3 px-4 text-center text-sm font-bold text-slate-700 dark:text-slate-200">${
        r.items?.length || 0
      }건</td>
      <td class="py-3 px-4 text-center text-sm font-bold text-blue-600 dark:text-blue-400">${
        r.total ?? 0
      }p</td>
      <td class="py-3 px-4 text-center text-xs">
        ${
          r.lifelove
            ? '<span class="px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400 font-bold">생명사랑</span>'
            : '<span class="text-slate-300 dark:text-slate-600">-</span>'
        }
      </td>
      <td class="py-3 px-4 text-center">
        <button class="ex-pick btn btn-primary-weak h-7 px-3 text-xs rounded-md" data-id="${
          r.id
        }">선택</button>
      </td>
    `;
    exchangeHistoryTbody.appendChild(tr);
  });
  exchangeBuilder.classList.add("hidden");
  exchangeItems = [];
  exchangeOriginalItems = [];
  exchangeProvision = null;
}

exchangeHistoryTbody?.addEventListener("click", async (e) => {
  if (!e.target.classList.contains("ex-pick")) return;
  const id = e.target.dataset.id;
  const snap = await getDoc(doc(db, "provisions", id));
  if (!snap.exists()) return showToast("내역을 불러올 수 없어요.", true);

  const data = snap.data();
  exchangeProvision = { id, ...data };
  exchangeOriginalItems = Array.isArray(data.items)
    ? data.items.map((x) => ({ ...x }))
    : [];
  exchangeItems = exchangeOriginalItems.map((x) => ({ ...x })); // 초기값=원본
  exchangeOriginalTotal = Number(data.total || 0);
  renderExchangeList();
  exchangeBuilder.classList.remove("hidden");
  showToast("교환 편집을 시작할게요.");

  // 명시적 저장
  saveExchangeAutoSave();
});

/* =========================================
   교환 리스트 렌더링 (TDS Spinner & Long Press 적용)
   ========================================= */
function renderExchangeList() {
  exTableBody.innerHTML = "";

  // 1. 빈 상태 처리
  if (exchangeItems.length === 0) {
    renderEmptyState(
      exTableBody,
      "교환할 상품이 없습니다",
      "fa-right-left",
      "위 내역에서 선택하거나 상품을 추가하세요",
    );

    // 빈 상태일 때도 합계 UI 갱신 (0원 처리 및 경고 끄기)
    updateExchangeTotalUI();
    // ✅ 제한 뱃지도 확실히 숨김 처리
    applyCategoryViolationHighlightFor(
      exchangeItems,
      exTableBody,
      exLimitWarnEl,
    );
    return;
  }

  // 2. 리스트 렌더링
  exchangeItems.forEach((item, idx) => {
    const tr = document.createElement("tr");
    const totalPrice = (item.quantity || 0) * (item.price || 0);

    tr.className =
      "hover:bg-slate-50/50 dark:hover:bg-slate-700/20 transition-all border-b border-slate-100 dark:border-slate-700/50 last:border-0 group";

    tr.innerHTML = `
      <td class="py-4 px-5">
        <div class="flex flex-col">
          <span class="font-bold text-slate-800 dark:text-slate-100">${item.name}</span>
          <span class="text-[11px] text-slate-400 dark:text-slate-500 font-medium uppercase mt-0.5">${item.category || "미분류"}</span>
        </div>
      </td>
      <td class="py-4 px-5 text-center">
        <div class="numeric-spinner mx-auto">
          <button class="spinner-btn ex-dec" data-idx="${idx}" ${item.quantity <= 1 ? "disabled" : ""}>
            <i class="fas fa-minus text-sm pointer-events-none"></i>
          </button>
          
          <div class="spinner-value-box">
            <input type="number"
                  class="spinner-input quantity-input"
                  data-idx="${idx}"
                  value="${item.quantity || 1}" />
          </div>
          
          <button class="spinner-btn ex-inc" data-idx="${idx}">
            <i class="fas fa-plus text-sm pointer-events-none"></i>
          </button>
        </div>
      </td>
      <td class="py-4 px-5 text-center text-slate-500 dark:text-slate-400 font-bold text-[15px]">${item.price || 0}</td>
      <td class="py-4 px-5 text-center">
        <span class="text-slate-900 dark:text-white font-black text-lg tracking-tight">${totalPrice.toLocaleString()}</span>
      </td>
      <td class="py-4 px-5 text-center">
        <button class="ex-del btn btn-danger-weak !w-9 !h-9 !p-0 rounded-xl transition-opacity shadow-sm" data-idx="${idx}" title="삭제">
          <i class="fas fa-trash-alt text-sm pointer-events-none"></i>
        </button>
      </td>
    `;

    // 데이터 바인딩
    tr.dataset.id = item.id;
    tr.dataset.category = item.category || "";
    tr.dataset.price = String(item.price ?? "");
    exTableBody.appendChild(tr);

    // 롱프레스 이벤트
    const decBtn = tr.querySelector(".ex-dec");
    const incBtn = tr.querySelector(".ex-inc");
    if (decBtn && incBtn) {
      setupLongPress(decBtn, () => changeExchangeQuantity(idx, -1));
      setupLongPress(incBtn, () => changeExchangeQuantity(idx, 1));
    }
  });

  // [핵심] 별도 계산 로직을 제거하고 통합 함수 호출 (빈 뱃지 문제 해결)
  updateExchangeTotalUI();

  applyCategoryViolationHighlightFor(exchangeItems, exTableBody, exLimitWarnEl);
  saveExchangeAutoSave();
}

function applyCategoryViolationHighlightFor(items, tbody, warnEl) {
  // 기존 함수를 재사용하되 대상 tbody만 교체
  const vios = checkCategoryViolations(items, categoryPolicies);
  const violating = new Set();
  if (vios.length) {
    for (const v of vios) {
      items.forEach((it) => {
        if ((it.category || "") !== v.category) return;
        if (v.mode === "price") {
          if (String(it.price ?? "") === String(v.price)) violating.add(it.id);
        } else {
          violating.add(it.id);
        }
      });
    }
  }
  [...tbody.children].forEach((tr) => {
    const id = tr.dataset.id;
    tr.classList.toggle("limit-violation", violating.has(id));
  });

  // ✅ [추가] 하단 "구매 제한 초과" 뱃지 토글
  if (warnEl) {
    if (typeof toggleFade === "function") {
      toggleFade(warnEl, vios.length > 0);
    } else {
      warnEl.classList.toggle("hidden", !(vios.length > 0));
    }
  }
}

/* =========================================
   [교환 전용] 수량 변경 로직 (DOM 보존형)
   ========================================= */

// 1. 수량 변경 핸들러
function changeExchangeQuantity(idx, change) {
  const index = Number(idx);
  const item = exchangeItems[index];
  if (!item) return;

  const newQty = (item.quantity || 0) + change;
  // 범위 체크 (1~30)
  if (newQty < 1) return;

  // 데이터 업데이트
  // ✅ 롱프레스 반복에서도 "버스트당 1회"만 Undo 저장
  if (!window.__exQtyUndoGate) window.__exQtyUndoGate = new Map(); // idx -> lastTs
  const gate = window.__exQtyUndoGate;
  const now = Date.now();
  const last = gate.get(index) || 0;
  if (now - last > 350) saveExUndoState();
  gate.set(index, now);
  item.quantity = newQty;

  // [UI 업데이트] 전체 렌더링 대신, 해당 줄만 업데이트
  updateExchangeRowUI(index);
}

// 2. 부분 업데이트 함수
function updateExchangeRowUI(idx) {
  const item = exchangeItems[idx];
  if (!item) return;

  const tr = exTableBody.children[idx];
  if (!tr) return;

  // 1. 수량 인풋 업데이트
  const qtyInput = tr.querySelector(".spinner-input");
  if (qtyInput) qtyInput.value = item.quantity;

  // 2. 소계 업데이트
  const totalTd = tr.children[3];
  if (totalTd) {
    const span = totalTd.querySelector("span");
    if (span)
      span.textContent = (
        (item.quantity || 0) * (item.price || 0)
      ).toLocaleString();
  }

  // 3. 버튼 상태 업데이트
  const decBtn = tr.querySelector(".ex-dec");
  const incBtn = tr.querySelector(".ex-inc");
  if (decBtn) decBtn.disabled = item.quantity <= 1;
  if (incBtn) incBtn.disabled = false;

  // 4. 합계 재계산
  updateExchangeTotalUI();

  // ✅ [추가] 수량 변경 시 제한 위반 여부(빨간줄) 즉시 재검사 및 반영
  applyCategoryViolationHighlightFor(exchangeItems, exTableBody, exLimitWarnEl);

  saveExchangeAutoSave();
}

// 3. 합계 UI 업데이트 함수
function updateExchangeTotalUI() {
  const newTotal = exchangeItems.reduce(
    (a, b) => a + (b.quantity || 0) * (b.price || 0),
    0,
  );

  if (exOriginalEl)
    exOriginalEl.textContent = exchangeOriginalTotal.toLocaleString();
  if (exNewEl) exNewEl.textContent = newTotal.toLocaleString();

  // 경고창 제어
  let showWarn = false;
  let warnMsg = "";

  if (newTotal > 30) {
    showWarn = true;
    warnMsg = `<i class="fas fa-circle-exclamation mr-1.5"></i> 교환 불가 / 30P 초과`;
  } else if (newTotal < exchangeOriginalTotal) {
    showWarn = true;
    warnMsg = `<i class="fas fa-arrow-trend-down mr-1.5"></i> 교환 불가 / 기존 합계 미달`;
  }

  if (exWarnEl) {
    // [핵심] 경고를 보여줄 때만 텍스트를 업데이트합니다.
    // 숨길 때는 텍스트를 그대로 두어야 fade-out 애니메이션이 자연스럽게 보입니다.
    if (showWarn) {
      const badge = exWarnEl.querySelector(".badge");
      if (badge) badge.innerHTML = warnMsg;
    }
    toggleFade(exWarnEl, showWarn);
  }
}

// 교환 입력(추가)
exAddBtn?.addEventListener("click", async () => {
  const q = parseInt(exQty.value) || 1;
  const code = exBarcode.value.trim();
  const nameKey = exName.value.trim();
  if (!exchangeProvision)
    return showToast("먼저 교환할 내역을 선택하세요.", true);

  try {
    if (code) {
      if (!isValidEAN13(code))
        return showToast("유효한 바코드가 아니에요.", true);
      const byCode = await findProductByBarcode(code);
      if (!byCode) return showToast("해당 바코드의 상품이 없어요.", true);
      exchangeAdd(byCode, q);
      exchangeCleanup();
      return;
    }
    if (!nameKey) return showToast("바코드 또는 상품명을 입력하세요.", true);
    const rows = await searchProductsByNamePrefix(nameKey);
    const picked =
      rows.find(
        (p) => (p.name || "").toLowerCase() === nameKey.toLowerCase(),
      ) || rows[0];
    if (!picked) return showToast("해당 상품을 찾을 수 없어요.", true);
    exchangeAdd(picked, q);
    exchangeCleanup();
  } catch (e) {
    console.error(e);
    showToast("교환 항목 추가 중 오류가 발생했어요.", true);
  }
});
function exchangeAdd(prod, qty) {
  saveExUndoState(); // 변경 전 스냅샷

  const ex = exchangeItems.find((it) => it.id === prod.id);
  if (ex) ex.quantity = (ex.quantity || 0) + qty;
  else
    exchangeItems.push({
      id: prod.id,
      name: prod.name,
      category: prod.category || "",
      price: prod.price || 0,
      quantity: qty,
    });
  renderExchangeList();
}
function exchangeCleanup() {
  exBarcode.value = "";
  exName.value = "";
  exQty.value = "";
  exBarcode.focus();
}

// 교환 테이블 조작
exTableBody?.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;

  const idx = btn.dataset.idx;

  // 삭제 버튼 (ex-del)
  if (btn.classList.contains("ex-del")) {
    saveExUndoState();
    exchangeItems.splice(Number(idx), 1);
    renderExchangeList();
    return;
  }
});
exTableBody?.addEventListener("change", (e) => {
  if (!e.target.classList.contains("quantity-input")) return;
  saveExUndoState();
  const idx = e.target.dataset.idx;
  let val = parseInt(e.target.value, 10);
  if (!Number.isFinite(val) || val < 1) val = 1;
  exchangeItems[idx].quantity = val;
  renderExchangeList();
});
// ✅ 교환 수량 blur 보정(입력 중 실수 방지)
exTableBody?.addEventListener(
  "blur",
  (e) => {
    if (!e.target.classList.contains("quantity-input")) return;
    let v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v) || v < 1) e.target.value = 1;
  },
  true,
);

// 교환 제출
function resetExchangeUI() {
  // 상태 비우기
  exchangeItems = [];
  exchangeOriginalItems = [];
  exchangeOriginalTotal = 0;
  exchangeProvision = null;
  // UI 초기화
  if (exTableBody) exTableBody.innerHTML = "";
  if (exOriginalEl) exOriginalEl.textContent = "0";
  if (exNewEl) exNewEl.textContent = "0";
  if (exWarnEl) exWarnEl.classList.add("hidden");
  if (exBarcode) exBarcode.value = "";
  if (exName) exName.value = "";
  if (exQty) exQty.value = "";
  if (exchangeBuilder) exchangeBuilder.classList.add("hidden");
  if (exHistoryTable) {
    const tb = exHistoryTable.querySelector("tbody");
    if (tb) tb.innerHTML = "";
    exHistoryTable.classList.add("hidden");
  }
  exchangeHistorySection?.classList.add("hidden");
}

exSubmitBtn?.addEventListener("click", async () => {
  if (!exchangeProvision) return showToast("교환할 내역을 선택하세요.", true);
  if (!exchangeItems.length) return showToast("교환 항목을 추가하세요.", true);

  const newTotal = exchangeItems.reduce(
    (a, b) => a + (b.quantity || 0) * (b.price || 0),
    0,
  );

  // 1. 30점 초과 차단
  if (newTotal > 30) {
    return showToast("총 포인트는 30점을 초과할 수 없어요.", true);
  }

  // 2. 기존 합계 미달 차단
  if (newTotal < exchangeOriginalTotal) {
    return showToast(
      `최소 ${exchangeOriginalTotal}점 이상이어야 해요. (기존 합계 미달)`,
      true,
    );
  }

  // Confirm 메시지
  const ok = await openConfirm({
    title: "교환 확정",
    message: `기존 합계 ${exchangeOriginalTotal}p → 교환 합계 ${newTotal}p<br>
              <span class="text-xs text-slate-500">(차액 ${
                newTotal - exchangeOriginalTotal
              }p 추가 사용)</span><br>
              교환을 진행할까요?`,
    confirmText: "교환",
    cancelText: "취소",
  });
  if (!ok) return;

  // ✅ delta 계산: (교환 후) - (교환 전)
  const buildQtyMap = (arr) => {
    const m = new Map(); // pid -> { qty, name, category }
    (Array.isArray(arr) ? arr : []).forEach((it) => {
      const pid = it?.id;
      if (!pid) return;

      const q = Number(it?.quantity || 0);
      if (!Number.isFinite(q) || q === 0) return;

      const prev = m.get(pid) || {
        qty: 0,
        name: it?.name || "",
        category: it?.category || "",
      };
      prev.qty += q;
      if (!prev.name && it?.name) prev.name = it.name;
      if (!prev.category && it?.category) prev.category = it.category;
      m.set(pid, prev);
    });
    return m;
  };

  const oldMap = buildQtyMap(exchangeOriginalItems);
  const newMap = buildQtyMap(exchangeItems);

  const deltaMap = new Map(); // pid -> { qty, name, category }
  let qtyDeltaTotal = 0;

  const keys = new Set([...oldMap.keys(), ...newMap.keys()]);
  keys.forEach((pid) => {
    const o = oldMap.get(pid) || { qty: 0, name: "", category: "" };
    const n = newMap.get(pid) || { qty: 0, name: "", category: "" };
    const d = Number(n.qty || 0) - Number(o.qty || 0);
    if (!Number.isFinite(d) || d === 0) return;

    qtyDeltaTotal += d;
    deltaMap.set(pid, {
      qty: d,
      name: n.name || o.name || "",
      category: n.category || o.category || "",
    });
  });

  try {
    const provRef = doc(db, "provisions", exchangeProvision.id);

    // 이 전표가 기록된 날짜(통계 반영 기준)
    const ts = exchangeProvision.timestamp;
    const atDate = ts?.toDate ? ts.toDate() : new Date();
    const dayNum = toDayNumber(atDate);
    const statsRef = doc(db, "stats_daily", String(dayNum));

    await runTransaction(db, async (tx) => {
      // ✅ Firestore 트랜잭션 규칙: 모든 읽기(tx.get)를 모든 쓰기(tx.update/set)보다 먼저 수행해야 함
      // 1) (필요 시) stats_daily 먼저 읽고, 쓸 payload를 미리 계산
      let nextStatsPayload = null;
      if (deltaMap.size > 0) {
        const statsSnap = await tx.get(statsRef);
        const stats = statsSnap.exists() ? statsSnap.data() || {} : {};

        // itemsTotalQty
        const curItemsTotalQty = Number(stats.itemsTotalQty || 0);
        let nextItemsTotalQty = curItemsTotalQty + qtyDeltaTotal;
        if (!Number.isFinite(nextItemsTotalQty))
          nextItemsTotalQty = curItemsTotalQty;
        if (nextItemsTotalQty < 0) nextItemsTotalQty = 0;

        // itemStatsById
        let curMap = {};
        if (stats.itemStatsById && typeof stats.itemStatsById === "object") {
          curMap = { ...stats.itemStatsById };
        } else if (Array.isArray(stats.topItems20)) {
          // legacy best-effort (구버전 stats_daily 대비)
          curMap = {};
          for (const x of stats.topItems20) {
            if (!x?.id) continue;
            curMap[x.id] = {
              qty: Number(x.qty || 0),
              name: x.name || "",
              category: x.category || "",
            };
          }
        }

        for (const [pid, d] of deltaMap.entries()) {
          const cur =
            curMap[pid] && typeof curMap[pid] === "object" ? curMap[pid] : {};
          const curQty = Number(cur.qty || 0);
          const nextQty = curQty + Number(d.qty || 0);

          if (!Number.isFinite(nextQty) || nextQty <= 0) {
            delete curMap[pid];
          } else {
            curMap[pid] = {
              qty: nextQty,
              name: d.name || cur.name || "",
              category: d.category || cur.category || "",
            };
          }
        }

        const topItems20 = Object.entries(curMap)
          .map(([id, v]) => ({
            id,
            name: v?.name || "",
            category: v?.category || "",
            qty: Number(v?.qty || 0),
          }))
          .filter((x) => Number.isFinite(x.qty) && x.qty > 0)
          .sort((a, b) => b.qty - a.qty)
          .slice(0, 20);

        nextStatsPayload = {
          itemsTotalQty: nextItemsTotalQty,
          itemStatsById: curMap,
          topItems20,
          updatedAt: serverTimestamp(),
        };
      }

      // 2) 전표 교환 반영 (쓰기)
      tx.update(provRef, {
        items: exchangeItems,
        total: newTotal,
        updatedAt: serverTimestamp(),
        exchangeLog: arrayUnion({
          at: Timestamp.now(),
          by: auth.currentUser?.email || null,
          from: exchangeOriginalItems,
          to: exchangeItems,
        }),
      });

      // 3) stats_daily 반영 (쓰기)
      if (nextStatsPayload) {
        tx.set(statsRef, nextStatsPayload, { merge: true });
      }
    });

    showToast("교환이 완료되었어요.");
    resetExchangeUI();

    localStorage.removeItem(getExAutoSaveKey());
    exUndoStack = []; // 스택도 비움
    exRedoStack = [];

    exchangeSelectedCustomer = null;
    renderExchangeCustomerInfo(); // 교환 고객정보 숨김
    if (exLookupInput) exLookupInput.value = "";
  } catch (e) {
    console.error(e);
    showToast("교환을 실패했어요.", true);
  }
});

// 방문자 선택 시, 교환 탭이면 히스토리 자동 로드
// (기존 visitorListEl select 핸들러 마지막에 renderSelectedList() 후 아래 한 줄 추가해도 됨)
document.addEventListener("exchange_customer_switched", () => {
  const isEx =
    document.querySelector(".tab-btn.active")?.dataset.tab === "exchange";
  if (isEx && exchangeSelectedCustomer)
    loadRecentProvisionsForCustomer(exchangeSelectedCustomer.id);
});

// ============================================================
// 🔄 교환 탭 스마트 자동 저장 (Auto-Save) & 복구
// ============================================================

function saveExchangeAutoSave() {
  try {
    const payload = {
      v: 1,
      updatedAt: Date.now(),
      step: 0,
      customer: exchangeSelectedCustomer, // 1단계: 고객 정보
      provision: exchangeProvision, // 2단계: 원본 영수증
      originalItems: exchangeOriginalItems,
      originalTotal: exchangeOriginalTotal,
      currentItems: exchangeItems, // 3단계: 작업 중인 장바구니
      undo: exUndoStack,
      redo: exRedoStack,
    };

    // 단계 판별
    if (exchangeItems.length > 0 || (exUndoStack && exUndoStack.length > 0)) {
      payload.step = 3; // 물품 수정 중
    } else if (exchangeProvision) {
      payload.step = 2; // 내역 선택 완료
    } else if (exchangeSelectedCustomer) {
      payload.step = 1; // 고객만 선택됨
    } else {
      // 저장할 내용 없음 -> 삭제
      localStorage.removeItem(getExAutoSaveKey());
      return;
    }

    localStorage.setItem(getExAutoSaveKey(), JSON.stringify(payload));
  } catch (e) {
    console.warn("Auto-save failed:", e);
  }
}

// ============================================================
// 7. 교환 탭 하단 기능 버튼 (Undo, Redo, Reset, Clear)
// ============================================================

// 1. 되돌리기 (Undo)
document.getElementById("ex-undo-btn")?.addEventListener("click", () => {
  if (exUndoStack.length === 0) return showToast("되돌릴 작업이 없어요.", true);

  // 현재 상태를 Redo로 보냄 (스냅샷 X, 그냥 이동)
  exRedoStack.push(JSON.parse(JSON.stringify(exchangeItems)));

  exchangeItems = exUndoStack.pop();
  renderExchangeList();
});

// 2. 다시 실행 (Redo)
document.getElementById("ex-redo-btn")?.addEventListener("click", () => {
  if (exRedoStack.length === 0)
    return showToast("다시 실행할 작업이 없어요.", true);

  // 현재 상태를 Undo로 보냄
  exUndoStack.push(JSON.parse(JSON.stringify(exchangeItems)));

  exchangeItems = exRedoStack.pop();
  renderExchangeList();
});

// 3. 원래대로 (Reset Initial)
document
  .getElementById("ex-reset-initial-btn")
  ?.addEventListener("click", async () => {
    if (!exchangeProvision) return showToast("선택된 내역이 없어요.", true);

    const ok = await openConfirm({
      title: "초기화",
      message: "처음 불러온 상태로 되돌릴까요?",
      confirmText: "되돌리기",
      cancelText: "취소",
      variant: "warn",
    });

    if (ok) {
      saveExUndoState(); // 이 행위도 Undo 가능하도록 저장
      // 원본 깊은 복사로 복구
      exchangeItems = JSON.parse(JSON.stringify(exchangeOriginalItems));
      renderExchangeList();
      showToast("초기 상태로 복구되었어요.");
    }
  });

// 4. 전체 비우기 (Clear All) - 고객 선택부터 다시
document
  .getElementById("ex-clear-all-btn")
  ?.addEventListener("click", async () => {
    const ok = await openConfirm({
      title: "전체 비우기",
      message: "교환 작업을 완전히 종료하고 초기화할까요?",
      confirmText: "비우기",
      cancelText: "취소",
      variant: "warn",
    });

    if (ok) {
      // 1. 메모리 초기화
      resetExchangeUI();
      exchangeSelectedCustomer = null;
      renderExchangeCustomerInfo();

      // 2. 스택 초기화
      exUndoStack = [];
      exRedoStack = [];

      // 3. 자동 저장 데이터 삭제 (가장 중요)
      localStorage.removeItem(getExAutoSaveKey());

      // 4. 검색창 초기화
      if (exLookupInput) exLookupInput.value = "";

      showToast("모든 내역이 초기화되었어요.");
    }
  });

// [추가] 교환 완료 시(submit 성공 후)에도 자동저장 삭제
// exSubmitBtn 클릭 리스너의 성공 블록 안에 아래 코드 추가 필요:
// localStorage.removeItem(getExAutoSaveKey());

// === [로직] 수량 변경 처리 (DOM 파괴 없이 값만 갱신) ===
function changeQuantity(idx, change) {
  const index = Number(idx);
  const item = selectedItems[index];
  if (!item) return;

  const newQty = item.quantity + change;

  // 범위 체크 (1~30)
  if (newQty < 1) return;

  // ✅ [Undo/Redo] 롱프레스(100ms 반복)에서도 "버스트당 1회"만 스냅샷 저장
  // - start()가 즉시 1회 + 이후 반복 호출되므로, 시간 간격으로 그룹화한다.
  if (!window.__qtyUndoGate) window.__qtyUndoGate = new Map(); // idx -> lastTs
  const gate = window.__qtyUndoGate;
  const now = Date.now();
  const last = gate.get(index) || 0;
  if (now - last > 350) {
    undoStack.push(JSON.parse(JSON.stringify(selectedItems)));
    redoStack = [];
  }
  gate.set(index, now);

  // 데이터 업데이트
  item.quantity = newQty;

  // [UI 업데이트] 전체 렌더링 대신, 해당 줄만 업데이트 (애니메이션/포커스 유지)
  updateRowUI(index);
}

// 특정 행 UI만 부분 업데이트
function updateRowUI(idx) {
  const item = selectedItems[idx];
  if (!item) return;

  // 1. 수량 인풋 값 변경
  const qtyInput = document.getElementById(`qty-${idx}`);
  if (qtyInput) qtyInput.value = item.quantity;

  // 2. 해당 행 소계(Total) 텍스트 변경
  const totalSpan = document.getElementById(`total-${idx}`);
  if (totalSpan) {
    totalSpan.textContent = (item.quantity * item.price).toLocaleString();
  }

  // 3. 버튼 활성/비활성 상태 갱신 (최소값 도달 시)
  const row = document.getElementById(`row-${idx}`);
  if (row) {
    const decBtn = row.querySelector(".decrease-btn");
    const incBtn = row.querySelector(".increase-btn");
    if (decBtn) decBtn.disabled = item.quantity <= 1;
    if (incBtn) incBtn.disabled = false;
  }

  // 4. 전체 합계 재계산 및 드래프트 저장
  updateTotalUIonly();
  applyCategoryViolationHighlight(); // ✅ [추가] 수량 변경 시에도 즉시 위반 여부 검사
  saveProvisionDraft();
}

// 전체 합계만 다시 계산해서 하단바 갱신 (toggleFade 적용)
function updateTotalUIonly() {
  const total = selectedItems.reduce(
    (acc, item) => acc + item.quantity * item.price,
    0,
  );

  if (totalPointsEl) totalPointsEl.textContent = total.toLocaleString();

  // [수정] 직접 classList 제어 대신 toggleFade 사용
  if (warningEl) {
    toggleFade(warningEl, total > 30);
  }
}
