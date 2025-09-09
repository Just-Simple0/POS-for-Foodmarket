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
  endAt,
  limit,
  arrayUnion,
  writeBatch,
  serverTimestamp,
  setDoc,
  increment,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { showToast, openConfirm } from "./components/comp.js";
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

// 방문/일일 카운터 기록 (visits는 확정 저장, stats_daily는 best-effort)
async function ensureVisitAndDailyCounter(
  db,
  customerId,
  customerName,
  atDate
) {
  const day = toDayNumber(atDate);
  const dateKey = toDateKey(day);
  const periodKey = toPeriodKey(atDate);
  const visitId = `${dateKey}_${customerId}`;
  const visitRef = doc(db, "visits", visitId);
  try {
    const snap = await getDoc(visitRef);
    if (!snap.exists()) {
      // 규칙 요구: createdBy 포함
      await setDoc(
        visitRef,
        {
          day,
          dateKey,
          periodKey,
          customerId,
          customerName: customerName || null,
          createdAt: serverTimestamp(),
          createdBy: auth.currentUser?.uid || "unknown",
        },
        { merge: true }
      );
      // stats_daily는 admin만 허용 → 실패해도 무시
      try {
        await setDoc(
          doc(db, "stats_daily", String(day)),
          {
            uniqueVisitors: increment(1),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      } catch (e) {
        console.warn("[stats_daily] best-effort skipped:", e?.message || e);
      }
    } else {
      // 존재 시 식별키 필드만 동기화(작성자/생성시각 보존)
      await setDoc(
        visitRef,
        {
          day,
          dateKey,
          periodKey,
          customerId,
          customerName: customerName || null,
        },
        { merge: true }
      );
    }
  } catch (e) {
    console.warn("[visits] ensure failed:", e?.message || e);
  }
}

const lookupInput = document.getElementById("customer-search");
const lookupBtn = document.getElementById("lookup-btn");
const customerInfoDiv = document.getElementById("customer-info");
const productSection = document.getElementById("product-selection");
const submitSection = document.getElementById("submit-section");
const submitBtn = document.getElementById("submit-btn");
const undoBtn = document.getElementById("undo-btn");
const redoBtn = document.getElementById("redo-btn");
const resetProductsBtn = document.getElementById("clear-products-btn");
const resetAllBtn = document.getElementById("clear-all-btn");
const lifeloveCheckbox = document.getElementById("lifelove-checkbox");
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
function saveVisitorDraft(list) {
  const payload = {
    v: 1,
    date: ymdLocal(),
    savedAt: Date.now(),
    expiresAt: endOfTodayTs(),
    list: Array.isArray(list) ? list : [],
  };
  try {
    localStorage.setItem(getVisitorKey(), JSON.stringify(payload));
  } catch (e) {
    console.warn("saveVisitorDraft failed:", e);
  }
}
function loadVisitorDraft() {
  try {
    let best = null; // {obj, key}
    for (const key of getKeysToTry(VISITOR_STORAGE_PREFIX)) {
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
    return best && Array.isArray(best.obj.list) ? best.obj.list : [];
  } catch (e) {
    console.warn("loadVisitorDraft failed:", e);
    return [];
  }
}
function clearVisitorDraft() {
  try {
    localStorage.removeItem(getVisitorKey());
  } catch {}
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

let selectedCustomer = null;
let selectedItems = [];
let selectedCandidate = null;
let visitorList = []; // ✅ 방문자 리스트
const visitorListEl = document.getElementById("visitor-list");
const visitorListSection = document.getElementById("visitor-list-section");

// ── 상품: 선로딩 제거 → JIT 조회(로컬 캐시로 재조회 최소화)
const productByBarcode = new Map(); // barcode -> {id,name,price,barcode,category}
const productById = new Map(); // id -> product
let nameReqSeq = 0; // 자동완성 최신 응답 가드

// ✅ 분류 제한 정책 (읽기 전용): stats/categoryPolicies 문서에서 1회 로드
//   문서 예시: { policies: { "생필품": {mode:"one_per_category",active:true}, "스낵":{mode:"one_per_price",active:true} } }
let categoryPolicies = {}; // { [category]: {mode:'one_per_category'|'one_per_price', active:boolean} }
async function loadCategoryPolicies() {
  try {
    const snap = await getDoc(doc(db, "stats", "categoryPolicies"));
    const data = snap.exists() ? snap.data() : null;
    categoryPolicies = data && data.policies ? data.policies : {};
  } catch (e) {
    console.warn("categoryPolicies load failed:", e);
    categoryPolicies = {};
  }
}

// 🔁 동명이인 모달 키보드 내비 전역 핸들러 참조
let dupKeyHandler = null;
let dupActiveIndex = -1;
// ✅ 복구 토스트/중복 실행 방지 플래그
let __restoredVisitors = false;
let __restoredProvision = false;

function tryRestoreDrafts() {
  // 방문자
  const visitors = loadVisitorDraft();
  if (visitors.length && !__restoredVisitors) {
    visitorList = visitors;
    renderVisitorList();
    __restoredVisitors = true;
    if (typeof showToast === "function")
      showToast(`방문자 ${visitorList.length}명 복구됨`);
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
    renderCustomerInfo();
    renderSelectedList();
    renderVisitorList();
    __restoredProvision = true;
    if (typeof showToast === "function")
      showToast("임시 장바구니가 복구되었습니다.");
  }
}

window.addEventListener("DOMContentLoaded", () => {
  lookupInput.focus();
  loadCategoryPolicies();
  // 로그인 여부와 무관하게 1차 복구(게스트 키 포함)
  tryRestoreDrafts();
});

// ✅ 로그인 상태가 결정되면(uid 키까지) 2차 복구
onAuthStateChanged(auth, () => {
  tryRestoreDrafts();
});

// ✅ 다른 탭/창에서 변경 시 동기화
window.addEventListener("storage", (e) => {
  if (!e.key) return;
  const isToday = e.key.endsWith(`:${ymdLocal()}`);
  const isVisitor = e.key.startsWith(`${VISITOR_STORAGE_PREFIX}:`);
  const isProvision = e.key.startsWith(`${PROVISION_DRAFT_PREFIX}:`);
  if (isToday && isVisitor) {
    visitorList = loadVisitorDraft();
    renderVisitorList();
  } else if (isToday && isProvision) {
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
    renderCustomerInfo();
    renderSelectedList();
    renderVisitorList();
  }
});

// ===== 탭 전환: 제공/교환 =====
const tabBtns = document.querySelectorAll(".tab-btn");
const exchangePanel = document.querySelector('[data-tab-panel="exchange"]');
const provisionHideOnExchange = [
  document.getElementById("product-selection"),
  document.getElementById("submit-section"),
  document.getElementById("product-action-buttons"),
];
function showTab(name) {
  tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  if (name === "exchange") {
    exchangePanel?.classList.remove("hidden");
    provisionHideOnExchange.forEach((el) => el?.classList.add("hidden"));
    // 고객이 선택되어 있으면 최근 50일 내 제공내역 로드
    if (selectedCustomer) loadRecentProvisionsForCustomer(selectedCustomer.id);
  } else {
    exchangePanel?.classList.add("hidden");
    // 제공 등록 UI 복구
    if (selectedCustomer) {
      productSection.classList.remove("hidden");
      submitSection.classList.remove("hidden");
    }
    provisionHideOnExchange.forEach((el) => el?.classList.remove("hidden"));
  }
}
tabBtns.forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab))
);

lookupInput.addEventListener("keydown", (e) => {
  if (!duplicateModal.classList.contains("hidden") && e.key === "Enter") {
    e.preventDefault();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault(); // 폼 submit 방지
    lookupBtn.click();
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
async function serverSearchByNamePrefix(prefix, max = 20) {
  const base = collection(db, "customers");
  const qy = query(
    base,
    where("status", "==", "지원"),
    orderBy("nameLower"),
    startAt(prefix),
    endAt(prefix + "\uf8ff"),
    limit(max)
  );
  const snap = await getDocs(qy);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
lookupBtn.addEventListener("click", async () => {
  const raw = lookupInput.value.trim();
  if (!raw) return showToast("이름을 입력하세요.", true);
  try {
    const key = normalize(raw);
    let rows = await searchCacheByNamePrefix(key, 20);
    if (!rows || rows.length === 0) {
      // 캐시에 없을 때만 서버 hits (reads 최소화)
      rows = await serverSearchByNamePrefix(key, 20);
    }
    if (!rows.length) return showToast("해당 이용자를 찾을 수 없습니다.", true);
    showDuplicateSelection(rows); // rows: [{id,name,birth,phone,...}]
  } catch (err) {
    console.error(err);
    showToast("이용자 조회 중 오류 발생", true);
  }
});

// 고객 정보 렌더링
function renderCustomerInfo() {
  if (!selectedCustomer) {
    customerInfoDiv.innerHTML = "";
    customerInfoDiv.classList.add("hidden");
    return;
  }
  const lifeBadge = selectedCustomer._lifeloveThisQuarter
    ? '<span class="badge badge-life">이번 분기 생명사랑 제공됨</span>'
    : '<span class="badge">이번 분기 미제공</span>';
  customerInfoDiv.innerHTML = `
      <strong>이용자명:</strong> ${selectedCustomer.name ?? ""}<br>
      <strong>생년월일:</strong> ${selectedCustomer.birth ?? ""}<br>
      <strong>주소:</strong> ${selectedCustomer.address ?? ""}<br>
      <strong>전화번호:</strong> ${selectedCustomer.phone ?? ""}<br>
      <strong>생명사랑:</strong> ${lifeBadge}<br>
      <strong>비고:</strong> ${selectedCustomer.note ?? ""}
    `;
  customerInfoDiv.classList.remove("hidden");
}

// 동명이인 처리하기
const duplicateModal = document.getElementById("duplicate-modal");
const duplicateList = document.getElementById("duplicate-list");
const closeDuplicateModal = document.getElementById("close-duplicate-modal");

closeDuplicateModal.addEventListener("click", () => {
  // ✅ 닫기: 모달/검색창/상태 초기화
  duplicateModal.classList.add("hidden");
  duplicateList.innerHTML = "";
  const infoEl = document.getElementById("selected-info");
  infoEl.classList.add("hidden");
  infoEl.innerHTML = "";
  selectedCandidate = null;
  dupActiveIndex = -1;
  lookupInput.value = "";
  lookupInput.focus();
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
    const data = row; // {id,name,birth,phone,...});
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="dup-name"><strong>${data.name}</strong></div>
      <div class="dup-sub">
        ${data.birth || "생년월일 없음"} | ${data.phone || "전화번호 없음"}
      </div>
    `;

    li.classList.add("duplicate-item");
    li.tabIndex = -1; // 키보드 포커싱 가능
    // 공통 선택 로직
    const selectThis = () => {
      document
        .querySelectorAll(".duplicate-item")
        .forEach((el) => el.classList.remove("selected"));
      li.classList.add("selected");
      document
        .querySelectorAll(".duplicate-item i")
        .forEach((icon) => icon.remove());
      const icon = document.createElement("i");
      icon.className = "fas fa-square-check";
      icon.style.color = "#1976d2";
      icon.style.marginRight = "8px";
      li.prepend(icon);
      selectedCandidate = { id: data.id, ...data };
      const infoEl = document.getElementById("selected-info");
      infoEl.innerHTML = `
        <div><strong>주소 :</strong> ${data.address || "없음"}</div>
        <div><strong>성별 :</strong> ${data.gender || "없음"}</div>
        <div><strong>비고 :</strong> ${data.note || ""}<div>
      `;
      infoEl.classList.remove("hidden");
      confirmBtn.disabled = false;
      dupActiveIndex = i;
      li.focus();
    };

    li.addEventListener("click", () => {
      selectThis();
    });
    duplicateList.appendChild(li);
    items.push(li);
  });
  // ✅ 단일/다중 모두: 첫 항목을 자동 "선택"(자동 삽입은 하지 않음)
  if (items.length > 0) {
    items[0].click(); // selectThis() 호출 → selectedCandidate 세팅 + confirm 활성화
    items[0].focus(); // 키보드 내비 시작 지점
    dupActiveIndex = 0;
  }

  duplicateModal.classList.remove("hidden");

  // ✅ 방향키/Enter/Escape 지원
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
      const currentMonth = now.toISOString().slice(0, 7); // YYYY-MM
      const year =
        now.getMonth() + 1 < 3 ? now.getFullYear() - 1 : now.getFullYear();
      const periodKey = `${String(year).slice(2)}-${String(year + 1).slice(2)}`; // 예: 24-25
      const visitArr = (data.visits && data.visits[periodKey]) || [];
      const alreadyThisMonth =
        Array.isArray(visitArr) &&
        visitArr.some(
          (v) => typeof v === "string" && v.startsWith(currentMonth)
        );
      if (alreadyThisMonth) {
        showToast("이미 이번 달 방문 처리된 이용자입니다.", true);
      } else {
        const qKey = getQuarterKey(now);
        const alreadyLife = !!(data.lifelove && data.lifelove[qKey]);
        const candidate = {
          ...selectedCandidate,
          _lifeloveThisQuarter: alreadyLife,
        };
        if (!visitorList.some((v) => v.id === candidate.id)) {
          visitorList.push(candidate);
          renderVisitorList();
          saveVisitorDraft(visitorList);
          showToast("방문자 리스트에 추가되었습니다.");
        } else {
          showToast("이미 리스트에 있는 이용자입니다.", true);
        }
      }
    } catch (err) {
      console.error(err);
      showToast("이용자 정보 확인 중 오류가 발생했습니다.", true);
    } finally {
      // 모달/검색창 초기화
      duplicateModal.classList.add("hidden");
      duplicateList.innerHTML = "";
      const infoEl = document.getElementById("selected-info");
      infoEl.classList.add("hidden");
      infoEl.innerHTML = "";
      selectedCandidate = null;
      dupActiveIndex = -1;
      lookupInput.value = "";
      lookupInput.focus();
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
    query(collection(db, "products"), where("barcode", "==", code), limit(1))
  );
  if (snap.empty) return null;
  const d = snap.docs[0];
  const p = { id: d.id, ...d.data() };
  productByBarcode.set(p.barcode, p);
  productById.set(p.id, p);
  return p;
}
let __nameAutoTimer = null;
async function searchProductsByNamePrefix(prefix) {
  // 서버 prefix 쿼리, 상위 5개만
  const qy = query(
    collection(db, "products"),
    orderBy("name"),
    startAt(prefix),
    endAt(prefix + "\uf8ff"),
    limit(5)
  );
  const snap = await getDocs(qy);
  return snap.docs.map((d) => {
    const p = { id: d.id, ...d.data() };
    productById.set(p.id, p);
    if (p.barcode) productByBarcode.set(p.barcode, p);
    return p;
  });
}

let undoStack = [];
let redoStack = [];

undoBtn.addEventListener("click", () => {
  if (undoStack.length > 0) {
    redoStack.push([...selectedItems.map((item) => ({ ...item }))]);
    selectedItems = undoStack.pop();
    renderSelectedList();
  } else {
    showToast("되돌릴 작업이 없습니다.", true);
  }
});

redoBtn.addEventListener("click", () => {
  if (redoStack.length > 0) {
    undoStack.push([...selectedItems.map((item) => ({ ...item }))]);
    selectedItems = redoStack.pop();
    renderSelectedList();
  } else {
    showToast("다시 실행할 작업이 없습니다.", true);
  }
});

resetProductsBtn.addEventListener("click", () => {
  if (selectedItems.length === 0)
    return showToast("초기화할 물품이 없습니다.", true);

  undoStack.push([...selectedItems.map((item) => ({ ...item }))]);
  redoStack = [];
  selectedItems = [];
  renderSelectedList();
  showToast("물품 목록이 초기화되었습니다.");
});

resetAllBtn.addEventListener("click", async () => {
  const ok = await openConfirm({
    title: "전체 초기화",
    message: "전체 초기화하시겠습니까?",
    variant: "warn",
    confirmText: "초기화",
    cancelText: "취소",
  });
  if (!ok) return;
  resetForm(); // 고객/상품 전체 초기화
  undoStack = [];
  redoStack = [];
  showToast("전체 초기화 완료");
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

/* =========================
   방문자 리스트 렌더/선택
   ========================= */
function renderVisitorList() {
  visitorListEl.innerHTML = "";
  if (visitorList.length === 0) {
    visitorListSection.classList.add("hidden");
    // 방문자 없으면 계산/제출 섹션 숨김
    selectedCustomer = null;
    productSection.classList.add("hidden");
    submitSection.classList.add("hidden");
    renderCustomerInfo();
    return;
  }
  visitorListSection.classList.remove("hidden");
  visitorList.forEach((v) => {
    const hasHold = localStorage.getItem(HOLD_PREFIX + v.id);
    const li = document.createElement("li");
    li.className =
      "visitor-item" +
      (selectedCustomer?.id === v.id ? " active" : "") +
      (hasHold ? "has-hold" : "");
    const holdBadge = hasHold
      ? `<i class="fas fa-bookmark hold-badge" style="font-size:11px;" title="보류 있음" aria-label="보류 있음"></i>`
      : "";
    li.innerHTML = `
      <div class="meta">
        <div class="name">${v.name} ${holdBadge}</div>
        <div class="sub">${v.birth || ""} ${
      v.phone ? " | " + v.phone : ""
    }</div>
      </div>
      <div class="actions">
        <button class="select" data-id="${v.id}">선택</button>
        <button class="remove" data-id="${v.id}">삭제</button>
      </div>
    `;
    visitorListEl.appendChild(li);
  });
}

visitorListEl?.addEventListener("click", async (e) => {
  const id = e.target.dataset.id;
  if (!id) return;
  const idx = visitorList.findIndex((v) => v.id === id);
  if (idx === -1) return;

  if (e.target.classList.contains("remove")) {
    // 선택 중인 고객을 제거하려 하면 경고
    if (selectedCustomer?.id === id && selectedItems.length > 0) {
      const ok = await openConfirm({
        title: "선택 해제",
        message: "현재 장바구니가 있습니다. 이 방문자를 리스트에서 제거할까요?",
        variant: "warn",
        confirmText: "제거",
        cancelText: "취소",
      });
      if (!ok) return;
    }
    if (selectedCustomer?.id === id) {
      selectedCustomer = null;
      selectedItems = [];
      renderSelectedList();
      clearProvisionDraft();
    }
    visitorList.splice(idx, 1);
    renderVisitorList();
    saveVisitorDraft(visitorList);
    return;
  }

  if (e.target.classList.contains("select")) {
    // 고객 전환 시, 기존 장바구니 보류 안내
    if (
      selectedCustomer &&
      selectedItems.length > 0 &&
      selectedCustomer.id !== id
    ) {
      const ok = await openConfirm({
        title: "방문자 전환",
        message:
          "현재 장바구니가 있습니다. 전환하시겠습니까? (보류 저장을 권장)",
        variant: "warn",
        confirmText: "전환",
        cancelText: "취소",
      });
      if (!ok) return;
    }
    selectedCustomer = visitorList[idx];
    // 선택 후에만 계산/제출 섹션 노출
    productSection.classList.remove("hidden");
    submitSection.classList.remove("hidden");
    renderCustomerInfo();
    // 방문자 전환 시 기본은 빈 장바구니
    selectedItems = [];
    undoStack = [];
    redoStack = [];
    lifeloveCheckbox.checked = false; // lifelove도 초기화
    // 🔍 선택한 방문자에 보류 데이터가 있으면, 불러올지 물어본 뒤 자동 적용
    try {
      const holdRaw = localStorage.getItem(HOLD_PREFIX + selectedCustomer.id);
      if (holdRaw) {
        const okLoad = await openConfirm({
          title: "보류 불러오기",
          message: "이 방문자에 저장된 보류 장바구니가 있습니다. 불러올까요?",
          variant: "warn",
          confirmText: "불러오기",
          cancelText: "새로 시작",
        });
        if (okLoad) {
          try {
            const parsed = JSON.parse(holdRaw);
            if (Array.isArray(parsed)) {
              selectedItems = parsed;
              showToast("보류 장바구니를 불러왔습니다.");
            }
          } catch {}
        }
      }
    } catch {}
    renderSelectedList();
    renderVisitorList(); // active 표시 갱신
    saveProvisionDraft();
    document.dispatchEvent(new Event("provision_customer_switched"));
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

// ✅ 바코드: Enter → EAN-13 검증 → 존재하면 1개 추가 / 없으면 빠른 등록 유도
barcodeInput.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const code = barcodeInput.value.trim();
  if (!code) return showToast("바코드를 입력하세요.", true);
  if (!isValidEAN13(code)) return showToast("유효한 바코드가 아닙니다.", true);
  // 전량 선로딩 제거: 단건 조회로 대체
  const hit = await findProductByBarcode(code);
  if (hit) {
    addToSelected(hit, parseInt(quantityInput.value) || 1);
    afterAddCleanup();
    return;
  }
  const ok = await openConfirm({
    title: "미등록 바코드",
    message: "해당 바코드의 상품이 없습니다. 등록하시겠습니까?",
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
      if (!isValidEAN13(code))
        return showToast("유효한 바코드가 아닙니다.", true);
      const byCode = await findProductByBarcode(code);
      if (!byCode) {
        const ok = await openConfirm({
          title: "미등록 바코드",
          message: "해당 바코드의 상품이 없습니다. 등록하시겠습니까?",
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
        (p) => (p.name || "").toLowerCase() === nameKey.toLowerCase()
      ) || rows[0];
    if (!picked) return showToast("해당 상품을 찾을 수 없습니다.", true);
    addToSelected(picked, q);
    afterAddCleanup();
  } catch (err) {
    console.error(err);
    showToast("상품 추가 중 오류", true);
  }
});

quantityInput.addEventListener("input", () => {
  let val = parseInt(quantityInput.value, 10);
  if (val > 30) {
    quantityInput.value = 30;
    showToast("수량은 최대 30까지만 입력할 수 있습니다.");
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
    div.textContent = `${product.name}`;
    div.addEventListener("click", () => {
      nameInput.value = product.name;
      quantityInput.focus(); // 이름 → 수량 → Enter로 추가
      autocompleteList.classList.add("hidden");
    });
    autocompleteList.appendChild(div);
  });

  autocompleteList.classList.remove("hidden");
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".product-input-area")) {
    autocompleteList.classList.add("hidden");
  }
});

// ===== 공통 유틸: 담기, EAN-13, 클린업 =====
function addToSelected(prod, qty) {
  undoStack.push([...selectedItems.map((it) => ({ ...it }))]);
  redoStack = [];
  const ex = selectedItems.find((it) => it.id === prod.id);
  if (ex) {
    ex.quantity = Math.min(ex.quantity + qty, 30);
    showToast(`${prod.name}의 수량이 ${qty}개 증가했습니다.`);
  } else {
    selectedItems.push({
      id: prod.id,
      name: prod.name,
      category: prod.category || "",
      price: prod.price || 0,
      quantity: qty,
    });
  }
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
  if (!isValidEAN13(barcode))
    return showToast("유효한 바코드가 아닙니다.", true);
  // 0.5 단위 체크(선택)
  if (Math.round(price * 2) !== price * 2)
    return showToast("가격은 0.5 단위로 입력하세요.", true);
  try {
    // 동일 바코드가 이미 있으면 신규 생성 대신 그 상품을 담기
    const exist = await findProductByBarcode(barcode);
    if (exist) {
      addToSelected(exist, parseInt(quantityInput.value) || 1);
      showToast("이미 존재하는 상품입니다. 장바구니에 추가했습니다.");
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
    addToSelected(prod, parseInt(quantityInput.value) || 1); // 장바구니에도 바로 추가
    showToast("상품이 등록되었습니다.");
    closeQuickCreateModal();
    afterAddCleanup();
  } catch (e) {
    console.error(e);
    showToast("상품 등록 실패", true);
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
  const violating = new Set(); // key: `${id}` of violating rows
  if (vios.length) {
    // 어떤 아이템이 위반에 해당하는지 계산
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
  // 테이블 행에 표시
  [...selectedTableBody.children].forEach((tr) => {
    const id = tr.dataset.id;
    tr.classList.toggle("limit-violation", violating.has(id));
  });
}

function renderSelectedList() {
  selectedTableBody.innerHTML = "";

  selectedItems.forEach((item, idx) => {
    const tr = document.createElement("tr");
    const totalPrice = item.quantity * item.price;

    tr.innerHTML = `
      <td>${item.name}</td>
      <td>
        <div class="quantity-wrapper">
        <button class="decrease-btn" data-idx="${idx}">−</button>
        <input type="number" name="quantity-${idx}" min="1" max="30" value="${item.quantity}" data-idx="${idx}" class="quantity-input" />
        <button class="increase-btn" data-idx="${idx}">+</button>
        </div>
      </td>
      <td>${item.price}</td>
      <td>${totalPrice}</td>
      <td>
        <button class="remove-btn" data-idx="${idx}"><i class="fas fa-trash"></i></button>
      </td>
    `;

    // 행 데이터 세팅(제한 검사용)
    tr.dataset.id = item.id;
    tr.dataset.category = item.category || "";
    tr.dataset.price = String(item.price ?? "");
    selectedTableBody.appendChild(tr);
  });

  // 합계 업데이트
  calculateTotal();
  // 제한 검사/강조
  applyCategoryViolationHighlight();
  // ✅ 렌더 후 상태 저장(수량/합계 변경 반영)
  saveProvisionDraft();
}

document.querySelector("#selected-table tbody").addEventListener(
  "blur",
  (e) => {
    if (e.target.classList.contains("quantity-input")) {
      let val = parseInt(e.target.value, 10);

      if (isNaN(val) || val < 1) {
        e.target.value = 1;
        showToast("수량은 1 이상이어야 합니다.");
      } else if (val > 30) {
        e.target.value = 30;
        showToast("수량은 최대 30까지만 가능합니다.");
      }
    }
  },
  true
); // ← true로 설정해야 '이벤트 캡처링'이 동작해서 위임 가능

selectedTableBody.addEventListener("click", (e) => {
  const idx = e.target.dataset.idx;

  // 수량 증가
  if (e.target.classList.contains("increase-btn")) {
    selectedItems[idx].quantity = Math.min(selectedItems[idx].quantity + 1, 30);
    renderSelectedList();
  }

  // 수량 감소
  if (e.target.classList.contains("decrease-btn")) {
    selectedItems[idx].quantity = Math.max(selectedItems[idx].quantity - 1, 1);
    renderSelectedList();
  }

  // 삭제
  if (e.target.closest(".remove-btn")) {
    const removeIdx = Number(e.target.closest(".remove-btn").dataset.idx);
    selectedItems.splice(removeIdx, 1);
    renderSelectedList();
  }
});

selectedTableBody.addEventListener("change", (e) => {
  if (e.target.classList.contains("quantity-input")) {
    undoStack.push([...selectedItems.map((item) => ({ ...item }))]);
    redoStack = [];

    const idx = e.target.dataset.idx;
    const val = parseInt(e.target.value);
    if (val >= 1 && val <= 30) {
      selectedItems[idx].quantity = val;
      renderSelectedList();
    }
  }
});

selectedTableBody.addEventListener("click", (e) => {
  if (e.target.closest(".remove-btn")) {
    const idx = e.target.closest(".remove-btn").dataset.idx;
    selectedItems.splice(idx, 1);
    renderSelectedList();
  }
});

function calculateTotal() {
  const total = selectedItems.reduce(
    (acc, item) => acc + item.quantity * item.price,
    0
  );

  totalPointsEl.textContent = total;

  if (total > 30) {
    warningEl.classList.remove("hidden");
  } else {
    warningEl.classList.add("hidden");
  }
}

/* =========================
   보류: localStorage 저장/불러오기
   ========================= */
const HOLD_PREFIX = "provision:hold:";
const holdSaveBtn = document.getElementById("hold-save-btn");
const holdLoadBtn = document.getElementById("hold-load-btn");

holdSaveBtn?.addEventListener("click", () => {
  if (!selectedCustomer) return showToast("먼저 방문자를 선택하세요.", true);
  localStorage.setItem(
    HOLD_PREFIX + selectedCustomer.id,
    JSON.stringify(selectedItems)
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
  customerInfoDiv.innerHTML = "";
  renderCustomerInfo(); // selectedCustomer가 null이면 hidden 처리됨
  renderVisitorList(); // active 표시 해제
  clearProvisionDraft();

  showToast("보류 처리되었습니다.");
});

holdLoadBtn?.addEventListener("click", () => {
  if (!selectedCustomer) return showToast("먼저 방문자를 선택하세요.", true);
  const raw = localStorage.getItem(HOLD_PREFIX + selectedCustomer.id);
  if (!raw) return showToast("저장된 보류 데이터가 없습니다.", true);
  try {
    selectedItems = JSON.parse(raw) || [];
    undoStack = [];
    redoStack = [];
    renderSelectedList();
    showToast("보류된 데이터를 불러왔습니다.");
  } catch {
    showToast("보류 데이터가 손상되었습니다.", true);
  }
});

// ✅ 제공 등록 제출
submitBtn.addEventListener("click", async () => {
  if (!selectedCustomer || selectedItems.length === 0)
    return showToast("이용자와 상품을 모두 선택하세요.", true);

  const total = selectedItems.reduce(
    (acc, item) => acc + item.quantity * item.price,
    0
  );
  if (total > 30) return showToast("포인트가 초과되었습니다.", true);

  // ✅ 현재 로그인한 사용자 확인
  const currentUser = auth.currentUser;
  if (!currentUser) {
    showToast("로그인된 사용자를 확인할 수 없습니다.", true);
    return;
  }

  const now = new Date();
  const year =
    now.getMonth() + 1 < 3 ? now.getFullYear() - 1 : now.getFullYear();
  const periodKey = `${String(year).slice(2)}-${String(year + 1).slice(2)}`; // 예: 24-25
  const visitDate = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const quarterKey = getQuarterKey(now);
  const lifelove = lifeloveCheckbox.checked;

  // 🔔 이번 분기 생명사랑 중복 제공 확인
  if (lifelove && selectedCustomer && selectedCustomer._lifeloveThisQuarter) {
    const okLife = await openConfirm({
      title: "생명사랑 중복 제공",
      message:
        "이 이용자는 이번 분기에 이미 생명사랑을 제공받았습니다. 계속 진행하시겠습니까?",
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
          ? `<b>• ${v.category} - 가격 ${v.price}은(는) ${v.limit}개까지 가능합니다.</b>`
          : `<b>• ${v.category} - 이 분류는 총 ${v.limit}개까지 가능합니다.</b>`
      )
      .join("<br>");
    const ok = await openConfirm({
      title: "제한 상품 중복",
      message: `현재 아래 분류의 제한 수량을 초과했습니다.<br>${msg}<br>계속 진행하시겠습니까?`,
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
  try {
    // ✅ 배치로 원자적 커밋 + 서버시간
    const batch = writeBatch(db);
    const provRef = doc(collection(db, "provisions"));
    batch.set(provRef, {
      customerId: selectedCustomer.id,
      customerName: selectedCustomer.name,
      customerBirth: selectedCustomer.birth,
      items: selectedItems,
      total,
      timestamp: serverTimestamp(),
      handledBy: currentUser.email,
      lifelove,
      quarterKey,
    });
    const customerRef = doc(db, "customers", selectedCustomer.id);
    const updates = {
      [`visits.${periodKey}`]: arrayUnion(visitDate),
      ...(lifelove ? { [`lifelove.${quarterKey}`]: true } : {}),
    };
    batch.update(customerRef, updates);
    await batch.commit();

    await ensureVisitAndDailyCounter(
      db,
      selectedCustomer.id,
      selectedCustomer.name,
      new Date()
    );

    showToast("제공 등록 완료!");
    localStorage.removeItem(HOLD_PREFIX + selectedCustomer.id);
    resetForm();
  } catch (err) {
    console.error(err);
    showToast("제공 등록 실패", true);
  } finally {
    window.__submitting = false;
    submitBtn.disabled = false;
  }
});

function resetForm() {
  lookupInput.value = "";
  customerInfoDiv.classList.add("hidden");
  productSection.classList.add("hidden");
  submitSection.classList.add("hidden");
  customerInfoDiv.innerHTML = "";
  selectedCustomer = null;
  selectedItems = [];
  visitorList = []; // ✅ 방문자 리스트도 초기화
  renderVisitorList();
  renderSelectedList();
  lifeloveCheckbox.checked = false;
  clearVisitorDraft();
  clearProvisionDraft();
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
  "#exchange-history-table tbody"
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
const exSubmitBtn = document.getElementById("exchange-submit-btn");

let exchangeItems = [];
let exchangeOriginalItems = [];
let exchangeOriginalTotal = 0;
let exchangeProvision = null; // { id, data }

async function loadRecentProvisionsForCustomer(customerId) {
  if (!customerId || !exchangeHistoryTbody) return;
  // 최근 50일
  const fiftyAgo = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000);
  const qy = query(
    collection(db, "provisions"),
    where("customerId", "==", customerId),
    where("timestamp", ">=", fiftyAgo),
    orderBy("timestamp", "asc") // 인덱스: [customerId ASC, timestamp ASC] 권장
  );
  const snap = await getDocs(qy);
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderExchangeHistory(rows);
}

function renderExchangeHistory(rows) {
  exchangeHistoryTbody.innerHTML = "";
  if (!rows.length) {
    exchangeHistoryTbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#666;">최근 50일 내 제공내역이 없습니다.</td></tr>`;
    exchangeBuilder.classList.add("hidden");
    return;
  }
  rows.forEach((r) => {
    const ts = r.timestamp?.toDate
      ? r.timestamp.toDate()
      : new Date(r.timestamp);
    const when = ts
      ? `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(
          2,
          "0"
        )}-${String(ts.getDate()).padStart(2, "0")} ${String(
          ts.getHours()
        ).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`
      : "-";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${when}</td>
      <td>${r.items?.length || 0}건</td>
      <td>${r.total ?? 0}</td>
      <td>${r.lifelove ? "생명사랑" : "-"}</td>
      <td><button class="ex-pick" data-id="${r.id}">선택</button></td>
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
  if (!snap.exists()) return showToast("내역을 불러올 수 없습니다.", true);

  const data = snap.data();
  exchangeProvision = { id, ...data };
  exchangeOriginalItems = Array.isArray(data.items)
    ? data.items.map((x) => ({ ...x }))
    : [];
  exchangeItems = exchangeOriginalItems.map((x) => ({ ...x })); // 초기값=원본
  exchangeOriginalTotal = Number(data.total || 0);
  renderExchangeList();
  exchangeBuilder.classList.remove("hidden");
  showToast("교환 편집을 시작합니다.");
});

// 교환 리스트 렌더
function renderExchangeList() {
  exTableBody.innerHTML = "";
  exchangeItems.forEach((item, idx) => {
    const tr = document.createElement("tr");
    const totalPrice = (item.quantity || 0) * (item.price || 0);
    tr.innerHTML = `
      <td>${item.name}</td>
      <td>
        <div class="quantity-wrapper">
          <button class="ex-dec" data-idx="${idx}">−</button>
          <input type="number" class="quantity-input" min="1" max="30" value="${
            item.quantity || 1
          }" data-idx="${idx}" />
          <button class="ex-inc" data-idx="${idx}">+</button>
        </div>
      </td>
      <td>${item.price || 0}</td>
      <td>${totalPrice}</td>
      <td><button class="ex-del" data-idx="${idx}"><i class="fas fa-trash"></i></button></td>
    `;
    tr.dataset.id = item.id;
    tr.dataset.category = item.category || "";
    tr.dataset.price = String(item.price ?? "");
    exTableBody.appendChild(tr);
  });
  // 합계/경고
  const newTotal = exchangeItems.reduce(
    (a, b) => a + (b.quantity || 0) * (b.price || 0),
    0
  );
  exOriginalEl.textContent = exchangeOriginalTotal;
  exNewEl.textContent = newTotal;

  if (newTotal > exchangeOriginalTotal || newTotal > 30) {
    exWarnEl.classList.remove("hidden");
  } else {
    exWarnEl.classList.add("hidden");
  }

  // 제한 강조
  applyCategoryViolationHighlightFor(exchangeItems, exTableBody);
}

function applyCategoryViolationHighlightFor(items, tbody) {
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
        return showToast("유효한 바코드가 아닙니다.", true);
      const byCode = await findProductByBarcode(code);
      if (!byCode) return showToast("해당 바코드의 상품이 없습니다.", true);
      exchangeAdd(byCode, q);
      exchangeCleanup();
      return;
    }
    if (!nameKey) return showToast("바코드 또는 상품명을 입력하세요.", true);
    const rows = await searchProductsByNamePrefix(nameKey);
    const picked =
      rows.find(
        (p) => (p.name || "").toLowerCase() === nameKey.toLowerCase()
      ) || rows[0];
    if (!picked) return showToast("해당 상품을 찾을 수 없습니다.", true);
    exchangeAdd(picked, q);
    exchangeCleanup();
  } catch (e) {
    console.error(e);
    showToast("교환 항목 추가 중 오류", true);
  }
});
function exchangeAdd(prod, qty) {
  const ex = exchangeItems.find((it) => it.id === prod.id);
  if (ex) ex.quantity = Math.min((ex.quantity || 0) + qty, 30);
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
  const idx = e.target.dataset.idx || e.target.closest("button")?.dataset.idx;
  if (idx == null) return;
  if (e.target.classList.contains("ex-inc")) {
    exchangeItems[idx].quantity = Math.min(
      (exchangeItems[idx].quantity || 1) + 1,
      30
    );
    renderExchangeList();
  } else if (e.target.classList.contains("ex-dec")) {
    exchangeItems[idx].quantity = Math.max(
      (exchangeItems[idx].quantity || 1) - 1,
      1
    );
    renderExchangeList();
  } else if (e.target.closest(".ex-del")) {
    exchangeItems.splice(Number(idx), 1);
    renderExchangeList();
  }
});
exTableBody?.addEventListener("change", (e) => {
  if (!e.target.classList.contains("quantity-input")) return;
  const idx = e.target.dataset.idx;
  let val = parseInt(e.target.value, 10);
  if (!Number.isFinite(val) || val < 1) val = 1;
  if (val > 30) val = 30;
  exchangeItems[idx].quantity = val;
  renderExchangeList();
});

// 교환 제출
exSubmitBtn?.addEventListener("click", async () => {
  if (!exchangeProvision) return showToast("교환할 내역을 선택하세요.", true);
  if (!exchangeItems.length) return showToast("교환 항목을 추가하세요.", true);

  const newTotal = exchangeItems.reduce(
    (a, b) => a + (b.quantity || 0) * (b.price || 0),
    0
  );
  if (newTotal > 30) return showToast("포인트 초과(최대 30)", true);
  if (newTotal > exchangeOriginalTotal)
    return showToast(
      "교환 합계는 기존 합계 이내로만 가능합니다(환불 없음).",
      true
    );

  const ok = await openConfirm({
    title: "교환 확정",
    message: `기존 합계 ${exchangeOriginalTotal} → 교환 합계 ${newTotal}\n환불은 없습니다. 진행할까요?`,
    confirmText: "교환",
    cancelText: "취소",
  });
  if (!ok) return;

  try {
    await updateDoc(doc(db, "provisions", exchangeProvision.id), {
      items: exchangeItems,
      total: newTotal,
      updatedAt: serverTimestamp(),
      exchangeLog: arrayUnion({
        at: serverTimestamp(),
        by: auth.currentUser?.email || null,
        from: exchangeOriginalItems,
        to: exchangeItems,
      }),
    });
    showToast("교환이 완료되었습니다.");
    // 히스토리 재조회 + 빌더 초기화
    loadRecentProvisionsForCustomer(
      selectedCustomer?.id || exchangeProvision.customerId
    );
    exchangeBuilder.classList.add("hidden");
  } catch (e) {
    console.error(e);
    showToast("교환 실패", true);
  }
});

// 방문자 선택 시, 교환 탭이면 히스토리 자동 로드
// (기존 visitorListEl select 핸들러 마지막에 renderSelectedList() 후 아래 한 줄 추가해도 됨)
document.addEventListener("provision_customer_switched", () => {
  const isEx =
    document.querySelector(".tab-btn.active")?.dataset.tab === "exchange";
  if (isEx && selectedCustomer)
    loadRecentProvisionsForCustomer(selectedCustomer.id);
});
