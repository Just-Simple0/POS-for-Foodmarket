import { db, auth } from "./components/firebase-config.js";
import {
  collection,
  setDoc,
  addDoc,
  doc,
  getDocs,
  getDoc,
  query,
  Timestamp,
  updateDoc,
  deleteDoc,
  where,
  writeBatch,
  orderBy,
  limit,
  startAt,
  endAt,
  startAfter,
  endBefore,
  documentId,
  getCountFromServer,
  limitToLast,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  showToast,
  renderCursorPager,
  initPageSizeSelect,
  openConfirm,
  makeSectionSkeleton,
  setBusy,
  showLoading,
  hideLoading,
} from "./components/comp.js";

// 🔍 검색용 메모리 저장
let customerData = [];
let pagesKnown = 1; // 렌더 직전 순간값으로 재계산해서 넣어줌

let displaydData = [];
let currentSort = { field: "name", direction: "asc" };
let pendingCreatePayload = null;
let pendingDupRef = null;
let pendingDupData = null;
let editingOriginal = null;

// ===== 서버 페이지네이션 상태 =====
let pageSize = 25;
let pageCursors = [null]; // 각 페이지의 "startAfter" 기준(이전 페이지의 lastDoc Snapshot)
let currentPageIndex = 0; // 0-based
let lastPageCount = 0; // 이번 화면에 실제로 표시한 문서 수(룩어헤드 제외)
let __hasNextPage = false; // 룩어헤드 결과(이번 페이지 기준 다음 페이지 존재 여부)
let currentQueryIdentity = ""; // 검색/정렬/필터 조합 식별자. 바뀌면 커서 초기화
let buildCurrentQuery = null; // () => QueryConstraints[] (pageCursors[currentPageIndex] 참조)
let buildBaseQuery = null; // () => limit/startAfter 제외한 쿼리 제약 (count(), 마지막 페이지용)
let __totalPages = 1; // count() 기반 총 페이지 수
let __currentFirstDoc = null; // 현재 페이지 첫 문서 스냅샷
let __currentLastDoc = null; // 현재 페이지 마지막 문서 스냅샷

function roleConstraint() {
  return isAdmin ? [] : [where("status", "==", "지원")];
}

function resetPager(identity, baseBuilder) {
  currentQueryIdentity = identity;
  buildBaseQuery = baseBuilder;
  // 실제 페이지 로드는 base + (startAfter) + limit(N+1)
  buildCurrentQuery = () => {
    const after = pageCursors[currentPageIndex];
    const cons = [...buildBaseQuery()];
    if (after) cons.push(startAfter(after));
    cons.push(limit(pageSize + 1));
    return cons;
  };
  pageCursors = [null];
  currentPageIndex = 0;
  lastPageCount = 0;
  __hasNextPage = false;
  pagesKnown = 1; // 새 쿼리 시작 시 임시값(곧 totalPages로 대체)
  // 1) 총 페이지 수 산출 → 2) 1페이지 로드 (statistics와 동일)
  computeCustomersTotalPages()
    .then(fetchAndRenderPage)
    .catch(fetchAndRenderPage);
}

// [수정] 서버에서 데이터 가져와서 테이블 렌더링
async function fetchAndRenderPage() {
  if (!buildCurrentQuery) return;
  const base = collection(db, "customers");
  const cons = buildCurrentQuery();
  const tbody = document.querySelector("#customer-table tbody");

  if (tbody) tbody.innerHTML = "";

  let __cleanupSkel;
  try {
    __cleanupSkel = makeSectionSkeleton(tbody, 10);
    const snap = await getDocs(query(base, ...cons));
    __hasNextPage = snap.size > pageSize;
    const docsForRender = __hasNextPage
      ? snap.docs.slice(0, pageSize)
      : snap.docs;

    lastPageCount = docsForRender.length;
    __currentFirstDoc = docsForRender[0] || null;
    __currentLastDoc = docsForRender[docsForRender.length - 1] || null;

    const rows = docsForRender.map((d) => {
      const data = { id: d.id, ...d.data() };
      data.lastVisit = data.lastVisit || computeLastVisit(data);
      return data;
    });

    displaydData = rows;
    renderTable(rows);
    updatePagerUI();

    pageCursors[currentPageIndex + 1] =
      docsForRender[docsForRender.length - 1] || null;

    // [핵심 추가] 렌더링 후 데이터가 0건인지 확인하여 에러 표시
    if (rows.length === 0) {
      // 상세 검색 입력창에 값이 있을 때만 에러 표시 (단순 페이지 이동 시엔 표시 안 함)
      const fVal = document.getElementById("field-search").value.trim();
      if (fVal) {
        toggleSearchError(
          "field-search-group",
          true,
          "조건에 맞는 결과가 없습니다."
        );
      }
    } else {
      // 결과가 있으면 에러 해제
      toggleSearchError("field-search-group", false);
    }
  } finally {
    __cleanupSkel?.();
  }
}

function updatePagerUI() {
  const pagEl = document.getElementById("pagination");
  // A안: 페이지 상태 계산
  const current = currentPageIndex + 1;
  const hasPrev = currentPageIndex > 0;
  const hasNext = current < (__totalPages || 1); // 총 페이지 수 기준
  // 처음부터 정확한 전체 페이지 기반으로 버튼 노출
  pagesKnown = __totalPages || current + (__hasNextPage ? 1 : 0);
  renderCursorPager(
    pagEl,
    { current, pagesKnown, hasPrev, hasNext },
    {
      goFirst: () => {
        if (currentPageIndex === 0) return;
        currentPageIndex = 0;
        fetchAndRenderPage();
      },
      goPrev: () => {
        if (!hasPrev) return;
        goPrevPage();
      },
      // 숫자 점프: 가까운 방향으로 연속 이동
      goPage: async (n) => {
        if (n === current) return;
        n = Math.max(1, Math.min(n, pagesKnown));
        while (currentPageIndex + 1 < n && __hasNextPage) {
          await goNextPage();
        }
        while (currentPageIndex + 1 > n && currentPageIndex > 0) {
          await goPrevPage();
        }
      },
      goNext: () => {
        if (!hasNext) return;
        goNextPage();
      },
      // '끝(>>)' 버튼: 단일 쿼리로 마지막 페이지 로드
      goLast: () => {
        goLastDirect().catch(console.warn);
      },
    },
    { window: 5 }
  );
}

// [추가] UI 필드명을 DB 필드명으로 변환 & 쿼리 적용 헬퍼
function applySortToQuery(constraints) {
  const { field, direction } = currentSort;
  if (!field) return constraints;

  // 인덱스 효율을 위해 매핑 (name -> nameLower)
  let dbField = field;
  if (field === "name") dbField = "nameLower";
  if (field === "region1") dbField = "regionLower";

  constraints.push(orderBy(dbField, direction));
  constraints.push(orderBy(documentId())); // 커서 안정성 보장
  return constraints;
}

// [추가] 정렬 변경 시 페이지 리로드 함수
async function reloadPageWithNewSort() {
  if (!buildBaseQuery) return; // 로컬 검색 모드면 무시

  // 페이징 상태 초기화 후 다시 로드
  pageCursors = [null];
  currentPageIndex = 0;
  await computeCustomersTotalPages();
  await fetchAndRenderPage();
}

/* ============================
 * 유틸: 저장/삭제/등록 후 현재 뷰 유지한 채 재조회
 * ============================ */
async function refreshAfterMutation() {
  const kwEl = document.getElementById("global-search");
  const fldSel = document.getElementById("field-select");
  const fldInp = document.getElementById("field-search");
  const kw = (kwEl?.value || "").trim();
  const f = (fldSel?.value || "").trim();
  const fv = (fldInp?.value || "").trim();
  try {
    if (kw || (f && fv)) {
      await runServerSearch();
    } else if (typeof fetchAndRenderPage === "function" && buildCurrentQuery) {
      await fetchAndRenderPage();
    } else {
      await loadCustomers();
    }
  } catch (_) {
    await loadCustomers();
  }
}

/* ============================
 * 직접 등록 폼 초기화
 * ============================ */
// [수정] 폼 초기화 (입력값/탭 리셋 + 엑셀 UI 초기화 추가)
function resetCreateForm() {
  const set = (id, v = "") => {
    const el = document.getElementById(id);
    if (el) el.value = v;
  };

  // 1. 직접 입력 필드 초기화
  set("create-name");
  set("create-birth");
  set("create-gender", "");
  set("create-status", "지원");
  set("create-region1");
  set("create-address");
  set("create-type");
  set("create-category");
  set("create-note");

  // 전화번호 초기화
  try {
    initPhoneList("#create-phone-wrap", "#create-phone-add", []);
  } catch {}

  // 2. 탭 상태 초기화 (직접 입력 탭으로 복귀)
  const modal = document.getElementById("customer-create-modal");
  if (modal) {
    modal.querySelectorAll(".tab").forEach((t) => {
      t.classList.remove(
        "active",
        "bg-white",
        "text-primary",
        "shadow-sm",
        "dark:bg-slate-700",
        "dark:text-white"
      );
      t.classList.add("text-slate-500");
    });
    const directTab = modal.querySelector('[data-tab="direct"]');
    if (directTab) {
      directTab.classList.add(
        "active",
        "bg-white",
        "text-primary",
        "shadow-sm",
        "dark:bg-slate-700",
        "dark:text-white"
      );
      directTab.classList.remove("text-slate-500");
    }
    modal.querySelector("#tab-direct")?.classList.remove("hidden");
    modal.querySelector("#tab-upload")?.classList.add("hidden");

    // 푸터 버튼 초기화
    modal.querySelector("#footer-direct")?.classList.remove("hidden");
    const footerUpload = modal.querySelector("#footer-upload");
    if (footerUpload) {
      footerUpload.classList.add("hidden");
      footerUpload.classList.remove("flex");
    }
  }

  // 3. [추가] 엑셀 업로드 탭 UI 완전 초기화
  const fileInput = document.getElementById("upload-file");
  if (fileInput) fileInput.value = ""; // 파일 선택 해제

  // 업로드 박스 디자인 원상복구 (파란색 -> 회색)
  const uploaderBox = document.querySelector("#tab-upload .uploader");
  const uiIconWrap = document.getElementById("upload-ui-icon-wrapper");
  const uiIcon = document.getElementById("upload-ui-icon");
  const uiTextMain = document.getElementById("upload-ui-text-main");
  const uiTextSub = document.getElementById("upload-ui-text-sub");
  const preview = document.getElementById("upload-preview");
  const execBtn = document.getElementById("btn-upload-exec");

  if (uploaderBox) {
    uploaderBox.classList.add(
      "border-slate-200",
      "dark:border-slate-700",
      "bg-slate-50/50",
      "dark:bg-slate-800/50"
    );
    uploaderBox.classList.remove(
      "border-blue-500",
      "bg-blue-50/30",
      "dark:bg-blue-900/10"
    );
  }
  if (uiIconWrap) {
    uiIconWrap.classList.add(
      "bg-blue-50",
      "text-blue-500",
      "dark:bg-blue-900/20"
    );
    uiIconWrap.classList.remove(
      "bg-green-100",
      "text-green-600",
      "dark:bg-green-900/30",
      "dark:text-green-400"
    );
  }
  if (uiIcon) uiIcon.className = "fas fa-cloud-upload-alt text-xl";
  if (uiTextMain) {
    uiTextMain.textContent = "엑셀 파일을 이곳에 드래그하거나 클릭하세요";
    uiTextMain.classList.remove("text-blue-600", "dark:text-blue-400");
  }
  if (uiTextSub) {
    uiTextSub.textContent = ".xlsx, .xls 파일만 지원됩니다.";
    uiTextSub.classList.remove("text-blue-400");
  }
  if (preview) {
    preview.textContent = "파일을 선택하고 미리보기를 눌러주세요.";
    preview.className =
      "p-4 bg-blue-50/50 dark:bg-slate-800 border border-blue-100 dark:border-slate-700 rounded-xl text-sm text-blue-800 dark:text-blue-300 text-center font-medium";
  }
  if (execBtn) execBtn.disabled = true;
}

// 다음 페이지(룩어헤드 기준으로 존재 시에만)
async function goNextPage() {
  if (!buildCurrentQuery || !__hasNextPage) return;
  currentPageIndex += 1;
  await fetchAndRenderPage();
}
// 이전 페이지: 현재 첫 문서 이전 묶음을 endBefore + limitToLast로 로드
async function goPrevPage() {
  if (!buildBaseQuery || currentPageIndex === 0) return;
  if (!__currentFirstDoc) return;
  const base = collection(db, "customers");
  const tbody = document.querySelector("#customer-table tbody");
  if (tbody) tbody.innerHTML = "";

  let __cleanupSkel;
  try {
    __cleanupSkel = makeSectionSkeleton(tbody, 8); // tbody 전달
    const snap = await getDocs(
      query(
        base,
        ...buildBaseQuery(),
        endBefore(__currentFirstDoc),
        limitToLast(pageSize)
      )
    );
    const docsForRender = snap.docs;
    lastPageCount = docsForRender.length;
    __currentFirstDoc = docsForRender[0] || null;
    __currentLastDoc = docsForRender[docsForRender.length - 1] || null;
    // 화면 데이터 갱신
    const rows = docsForRender.map((d) => {
      const data = { id: d.id, ...d.data() };
      data.lastVisit = data.lastVisit || computeLastVisit(data);
      return data;
    });
    displaydData = rows;
    renderTable(rows);
    // 인덱스/커서 상태 갱신(이후 '다음' 이동을 위해 현재 페이지의 마지막 문서를 저장)
    currentPageIndex = Math.max(0, currentPageIndex - 1);
    pageCursors[currentPageIndex + 1] = __currentLastDoc || null;
    // 다음 페이지 존재 여부는 총 페이지/현 인덱스로 판정
    __hasNextPage = currentPageIndex + 1 < (__totalPages || 1);
    updatePagerUI();
  } finally {
    __cleanupSkel?.();
  }
}

// 마지막 페이지: limitToLast로 한 번에 가져와 렌더
async function goLastDirect() {
  if (!buildBaseQuery) return;
  const base = collection(db, "customers");
  const tbody = document.querySelector("#customer-table tbody");
  if (tbody) tbody.innerHTML = "";

  let __cleanupSkel;
  try {
    __cleanupSkel = makeSectionSkeleton(tbody, 8); // tbody 전달
    const snap = await getDocs(
      query(base, ...buildBaseQuery(), limitToLast(pageSize))
    );
    const docsForRender = snap.docs; // asc 정렬 그대로 마지막 pageSize개
    lastPageCount = docsForRender.length;
    __currentFirstDoc = docsForRender[0] || null;
    __currentLastDoc = docsForRender[docsForRender.length - 1] || null;
    const rows = docsForRender.map((d) => {
      const data = { id: d.id, ...d.data() };
      data.lastVisit = data.lastVisit || computeLastVisit(data);
      return data;
    });
    displaydData = rows;
    renderTable(rows);
    // 인덱스를 맨 끝으로, '다음'은 없음
    currentPageIndex = Math.max(0, (__totalPages || 1) - 1);
    __hasNextPage = false;
    // 이후 '이전'→'다음' 왕복을 위해 현재 페이지의 lastDoc을 앵커로 저장
    pageCursors[currentPageIndex + 1] = null; // 끝 이후는 없음
    pageCursors[currentPageIndex] = __currentLastDoc || null; // 다음 로드시 startAfter anchoring용
    updatePagerUI();
  } finally {
    __cleanupSkel?.();
  }
}

// ===== IndexedDB (지원자 캐시) =====
const IDB_NAME = "pos_customers";
const IDB_STORE = "support_only";
let idbReady = null;
function openIDB() {
  if (idbReady) return idbReady;
  idbReady = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        const st = db.createObjectStore(IDB_STORE, { keyPath: "id" });
        st.createIndex("nameLower", "nameLower", { unique: false });
        st.createIndex("regionLower", "regionLower", { unique: false });
        // phoneTokens는 배열 → 인덱스 대신 전체 스캔(600건 규모 OK)
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbReady;
}
async function idbPutAll(rows) {
  const dbi = await openIDB();
  return await new Promise((resolve) => {
    const tx = dbi.transaction(IDB_STORE, "readwrite");
    const st = tx.objectStore(IDB_STORE);
    rows.forEach((r) => st.put(r));
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}
async function idbClear() {
  const dbi = await openIDB();
  return await new Promise((resolve) => {
    const tx = dbi.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}
async function idbGetAll() {
  const dbi = await openIDB();
  return await new Promise((resolve) => {
    const tx = dbi.transaction(IDB_STORE, "readonly");
    const st = tx.objectStore(IDB_STORE);
    const out = [];
    st.openCursor().onsuccess = (e) => {
      const cur = e.target.result;
      if (cur) {
        out.push(cur.value);
        cur.continue();
      } else resolve(out);
    };
  });
}
function toCacheShape(c) {
  // 서버 문서에 인덱스 필드가 없어도 로컬에서 보정 (통합검색: 전필드 대상)
  const lower = (s) => normalize(s || "");
  const nameLower = lower(c.name);
  const regionLower = lower(c.region1);
  const addressLower = lower(c.address);
  const typeLower = lower(c.type);
  const categoryLower = lower(c.category);
  const noteLower = lower(c.note);
  const genderLower = lower(c.gender);
  const birthDigits = String(c.birth || "").replace(/\D/g, "");
  const display = c.phone || "";
  const { phoneTokens, phoneLast4 } = buildPhoneIndexFields(display);
  return {
    id: c.id,
    name: c.name || "",
    birth: c.birth || "",
    gender: c.gender || "",
    status: c.status || "",
    region1: c.region1 || "",
    address: c.address || "",
    phone: display,
    type: c.type || "",
    category: c.category || "",
    note: c.note || "",
    lastVisit: c.lastVisit || "",
    updatedAt: c.updatedAt || "",
    updatedBy: c.updatedBy || "",
    // 로컬 인덱스
    nameLower,
    regionLower,
    addressLower,
    typeLower,
    categoryLower,
    noteLower,
    genderLower,
    birthDigits,
    phoneTokens,
    phoneLast4,
  };
}
async function syncSupportCache() {
  // 관리자/일반 공통: status=="지원"만 로컬 캐시
  const base = collection(db, "customers");
  const snap = await getDocs(query(base, where("status", "==", "지원")));
  const rows = snap.docs.map((d) => toCacheShape({ id: d.id, ...d.data() }));
  await idbClear();
  await idbPutAll(rows);
}

// 통합검색(로컬 캐시 전필드 OR, 규칙 없이 부분 포함/숫자 포함)
async function localUnifiedSearch(keyword) {
  const key = normalize(keyword || "");
  if (!key) return [];
  const rows = await idbGetAll();
  const digits = key.replace(/\D/g, "");
  return rows
    .filter((r) => {
      // 숫자: 전화 토큰/끝 4자리/생년월일 숫자에 포함되면 매칭
      const numHit =
        !!digits &&
        ((r.phoneTokens || []).some((t) => t.includes(digits)) ||
          (r.phoneLast4 || "") === digits ||
          (r.birthDigits || "").includes(digits));
      // 텍스트: 모든 인덱스 필드에 부분 포함이면 매칭
      const txtHit =
        (r.nameLower || "").includes(key) ||
        (r.regionLower || "").includes(key) ||
        (r.addressLower || "").includes(key) ||
        (r.typeLower || "").includes(key) ||
        (r.categoryLower || "").includes(key) ||
        (r.noteLower || "").includes(key) ||
        (r.genderLower || "").includes(key);
      return numHit || txtHit;
    })
    .slice(0, 200); // 안전 상한
}

// ===== 로그 유틸 =====
async function logEvent(type, data = {}) {
  try {
    await addDoc(collection(db, "customerLogs"), {
      type,
      actor: auth.currentUser?.email || "unknown",
      createdAt: Timestamp.now(),
      ...data,
    });
  } catch (e) {
    // 로깅 실패는 UX 차단하지 않음
    console?.warn?.("logEvent failed:", e);
  }
}
async function pruneOldCustomerLogs() {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const q = query(
      collection(db, "customerLogs"),
      where("createdAt", "<", Timestamp.fromDate(cutoff)),
      orderBy("createdAt", "asc"),
      limit(200)
    );
    const snap = await getDocs(q);
    if (snap.empty) return;
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  } catch (e) {
    console?.warn?.("pruneOldLogs skipped:", e);
  }
}

// ===== 권한/역할 감지 & UI 토글 =====
let isAdmin = false;
async function applyRoleFromUser(user) {
  if (!user) {
    isAdmin = false;
  } else {
    const token = await user.getIdTokenResult().catch(() => null);
    const role = token?.claims?.role || "pending";
    isAdmin = role === "admin";
  }
  document.documentElement.classList.toggle("is-admin", isAdmin);
}

// ===== 등록하기 모달 바인딩 =====
function bindToolbarAndCreateModal() {
  const modal = document.getElementById("customer-create-modal");

  // ============================
  // 1. 모달 열기 (초기화 후 열기)
  // ============================
  document
    .getElementById("btn-customer-create")
    .addEventListener("click", () => {
      resetCreateForm();
      openCreateModal();
    });

  // ============================
  // 2. 엑셀 전체 내보내기 (메인 툴바)
  // ============================
  document
    .getElementById("btn-export-xlsx")
    .addEventListener("click", exportXlsx);

  // ============================
  // 3. 모달 닫기 (작성 중 내용 확인 - Dirty Check)
  // ============================
  const closeAll = async () => {
    // (1) 작성 중인지 검사
    let isDirty = false;

    // 1-1. 직접 입력 필드 검사
    const directFields = [
      "create-name",
      "create-birth",
      "create-region1",
      "create-address",
      "create-type",
      "create-category",
      "create-note",
    ];
    if (
      directFields.some(
        (id) => document.getElementById(id)?.value.trim() !== ""
      )
    ) {
      isDirty = true;
    }

    // 1-2. 전화번호 검사 (하나라도 입력되었으면 Dirty)
    const phoneInputs = document.querySelectorAll("#create-phone-wrap input");
    if (Array.from(phoneInputs).some((input) => input.value.trim() !== "")) {
      isDirty = true;
    }

    // 1-3. 엑셀 파일 선택 여부 검사
    const fileInput = document.getElementById("upload-file");
    if (fileInput && fileInput.files.length > 0) {
      isDirty = true;
    }

    // (2) 작성 중이면 확인 창 띄우기
    if (isDirty) {
      const ok = await openConfirm({
        title: "작성 취소",
        message: "작성 중인 내용이 있습니다. 정말 닫으시겠습니까?",
        variant: "warn",
        confirmText: "닫기",
        cancelText: "계속 작성",
        defaultFocus: "cancel",
      });
      if (!ok) return; // '계속 작성' 선택 시 함수 종료
    }

    // (3) 모달 닫기 및 초기화
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    resetCreateForm();
  };

  document
    .querySelectorAll("#create-modal-close")
    .forEach((el) => el.addEventListener("click", closeAll));

  // ============================
  // 4. 탭 전환 (디자인 + 푸터 버튼 토글)
  // ============================
  modal.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetTab = tab.dataset.tab;
      const isUpload = targetTab === "upload";

      // (1) 탭 스타일 업데이트 (Segmented Control)
      modal.querySelectorAll(".tab").forEach((t) => {
        t.classList.remove(
          "active",
          "bg-white",
          "text-primary",
          "shadow-sm",
          "dark:bg-slate-700",
          "dark:text-white"
        );
        t.classList.add("text-slate-500");
      });
      tab.classList.add(
        "active",
        "bg-white",
        "text-primary",
        "shadow-sm",
        "dark:bg-slate-700",
        "dark:text-white"
      );
      tab.classList.remove("text-slate-500");

      // (2) 패널 전환
      modal
        .querySelectorAll(".tab-panel")
        .forEach((p) => p.classList.add("hidden"));
      const targetPanel = modal.querySelector("#tab-" + targetTab);
      if (targetPanel) targetPanel.classList.remove("hidden");

      // (3) 푸터 버튼 전환 (직접입력 vs 엑셀업로드)
      const directFooter = modal.querySelector("#footer-direct");
      const uploadFooter = modal.querySelector("#footer-upload");

      if (isUpload) {
        directFooter.classList.add("hidden");
        uploadFooter.classList.remove("hidden");
        uploadFooter.classList.add("flex");
      } else {
        directFooter.classList.remove("hidden");
        uploadFooter.classList.add("hidden");
        uploadFooter.classList.remove("flex");
      }
    });
  });

  // ============================
  // 5. 엑셀 양식 다운로드 (ExcelJS 즉석 생성)
  // ============================
  document
    .getElementById("btn-download-template")
    ?.addEventListener("click", async () => {
      try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("업로드양식");

        // 헤더 설정
        sheet.columns = [
          { header: "이용자명", key: "name", width: 15 },
          { header: "생년월일", key: "birth", width: 15 },
          { header: "성별", key: "gender", width: 8 },
          { header: "전화번호", key: "phone", width: 20 },
          { header: "주소", key: "address", width: 40 },
          { header: "행정구역", key: "region1", width: 15 },
          { header: "이용자구분", key: "type", width: 15 },
          { header: "이용자분류", key: "category", width: 15 },
          { header: "상태", key: "status", width: 10 },
          { header: "비고", key: "note", width: 30 },
        ];

        // 헤더 스타일링
        const headerRow = sheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
        headerRow.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF4B5563" },
        };
        headerRow.alignment = { vertical: "middle", horizontal: "center" };

        // 예시 데이터
        sheet.addRow({
          name: "홍길동",
          birth: "1980.01.01",
          gender: "남",
          phone: "010-1234-5678",
          address: "대구광역시 달서구...",
          region1: "두류동",
          type: "기초생활수급자",
          category: "독거노인",
          status: "지원",
          note: "예시 데이터입니다.",
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        saveAs(blob, "이용자등록_양식.xlsx");
      } catch (e) {
        console.error(e);
        showToast("양식 생성 중 오류가 발생했습니다.", true);
      }
    });

  // ============================
  // 6. 저장 및 업로드 실행 바인딩
  // ============================
  // 직접 저장 버튼
  document
    .getElementById("create-modal-save")
    .addEventListener("click", saveCreateDirect);

  // 업로드 탭 기능 바인딩 (파일 선택, 미리보기, 실행)
  bindUploadTab();

  // ============================
  // 7. 입력 보조 (생년월일, 전화번호)
  // ============================
  const birth = document.getElementById("create-birth");
  if (birth && !birth.dataset.strictBound) {
    birth.addEventListener("input", () => {
      birth.value = formatBirthStrictInput(birth.value);
      birth.setCustomValidity("");
    });
    birth.addEventListener("blur", () => {
      if (!validateBirthStrict(birth.value)) {
        birth.setCustomValidity(
          "생년월일은 YYYYMMDD 형식(예: 19990203)으로 입력하세요."
        );
        birth.reportValidity();
      } else {
        birth.value = finalizeBirthStrict(birth.value);
        birth.setCustomValidity("");
      }
    });
    birth.dataset.strictBound = "1";
  }

  // 전화번호 리스트 초기화
  initPhoneList("#create-phone-wrap", "#create-phone-add");

  // ============================
  // 8. 동명이인 모달 버튼
  // ============================
  document.getElementById("dup-update")?.addEventListener("click", onDupUpdate);
  document.getElementById("dup-new")?.addEventListener("click", onDupNew);
  document.querySelectorAll("#dup-modal [data-close]")?.forEach((b) =>
    b.addEventListener("click", () => {
      document.getElementById("dup-modal").classList.add("hidden");
    })
  );

  // ============================
  // 9. 유지보수
  // ============================
  pruneOldCustomerLogs();
}
function openCreateModal() {
  const modal = document.getElementById("customer-create-modal");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}
async function saveCreateDirect() {
  const email = auth.currentUser?.email || "unknown";
  const phoneVals = getPhonesFromList("#create-phone-wrap");
  const picked = parsePhonesPrimarySecondary(...phoneVals);
  // 생년월일 엄격 검증(YYYYMMDD)
  const createBirthRaw = val("#create-birth");
  if (!validateBirthStrict(createBirthRaw)) {
    showToast("생년월일은 YYYYMMDD 형식(예: 19990203)으로 입력하세요.", true);
    return;
  }
  const createBirth = finalizeBirthStrict(createBirthRaw);
  const payload = {
    name: val("#create-name"),
    birth: createBirth,
    gender: val("#create-gender"),
    status: val("#create-status") || "지원",
    region1: val("#create-region1"),
    address: val("#create-address"),
    phone: picked.display,
    phonePrimary: picked.prim || "",
    phoneSecondary: picked.sec || "",
    type: val("#create-type"),
    category: val("#create-category"),
    note: val("#create-note"),
    updatedAt: new Date().toISOString(),
    updatedBy: email,
    // 🔎 인덱스 필드
    nameLower: normalize(val("#create-name")),
    regionLower: normalize(val("#create-region1")),
    ...buildPhoneIndexFields(picked.display),
  };
  if (!payload.name || !payload.birth) {
    return showToast("이용자명/생년월일은 필수입니다.", true);
  }
  // 동명이인 검사: 같은 name+birth 문서 존재 시 선택 모달
  const id = slugId(payload.name, payload.birth);
  const ref = doc(collection(db, "customers"), id);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    pendingCreatePayload = payload;
    pendingDupRef = ref;
    pendingDupData = snap.data() || {};
    document.getElementById(
      "dup-info"
    ).textContent = `${payload.name} / ${payload.birth} 동일 항목이 이미 존재합니다.`;
    document.getElementById("dup-modal").classList.remove("hidden");
    return;
  }
  // 중복 없음 → 권한에 따라 바로 저장/승인요청
  if (isAdmin) {
    await setDoc(ref, payload, { merge: true });
    showToast("등록되었습니다");
    try {
      if (payload.status === "지원")
        await idbPutAll([toCacheShape({ id, ...payload })]);
    } catch {}
    await logEvent("customer_add", {
      target: id,
      name: payload.name,
      birth: payload.birth,
      status: payload.status,
    });
  } else {
    const ok = await openConfirm({
      title: "승인 요청",
      message: "관리자의 승인이 필요한 사항입니다. 승인을 요청하시겠습니까?",
      variant: "warn",
      confirmText: "승인 요청",
      cancelText: "취소",
      defaultFocus: "cancel",
    });
    if (!ok) return;
    await setDoc(doc(collection(db, "approvals")), {
      type: "customer_add",
      payload,
      requestedBy: auth.currentUser?.email || "",
      requestedAt: Timestamp.now(),
      approved: false,
    });
    showToast("승인 요청이 전송되었습니다");
    await logEvent("approval_request", {
      approvalType: "customer_add",
      name: payload.name,
      birth: payload.birth,
      status: payload.status,
    });
  }
  document.getElementById("customer-create-modal").classList.add("hidden");
  resetCreateForm();
  await refreshAfterMutation();
}
function val(sel) {
  const el = document.querySelector(sel);
  return el ? el.value.trim() : "";
}
function slugId(name, birth) {
  return `${(name || "").trim()}_${(birth || "").replace(/[.\-]/g, "")}`;
}

// 날짜 표시 YYYY.MM.DD
function fmtYMD(dateStr) {
  if (!dateStr) return "";
  // 2025-09-03 또는 ISO → YYYY.MM.DD
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
// visits 맵에서 가장 최신 날짜(문자열) 추출
function computeLastVisit(c) {
  const v = c?.visits;
  if (!v || typeof v !== "object") return "";
  let latest = "";
  for (const k of Object.keys(v)) {
    const arr = Array.isArray(v[k]) ? v[k] : [];
    for (const s of arr) {
      if (!s) continue;
      // 비교를 위해 YYYY-MM-DD를 우선 사용
      const iso = String(s).replace(/\./g, "-");
      if (!latest || iso > latest) latest = iso;
    }
  }
  return latest ? fmtYMD(latest) : "";
}

async function loadCustomers() {
  // [핵심] roleConstraint 결과에 applySortToQuery로 정렬 조건 추가
  resetPager("list:default", () => {
    const cons = [...roleConstraint()];
    return applySortToQuery(cons);
  });
  updateSortIcons();
  try {
    await syncSupportCache();
  } catch {}
}

function renderTable(data) {
  const tbody = document.querySelector("#customer-table tbody");
  tbody.innerHTML = "";
  customerData = data;

  // 1. [수정] 변수 선언을 if 밖으로 꺼냄 (함수 전체에서 사용 가능하도록)
  let sorted = [...data];

  // 2. 클라이언트 사이드 정렬 (로컬 검색 모드일 때만 수행)
  // 서버 모드(!buildBaseQuery 등)일 때는 이미 정렬된 데이터를 받아오므로 이 블록을 건너뜀
  if (!buildCurrentQuery && currentSort.field) {
    sorted.sort((a, b) => {
      const normalize = (val) =>
        (val || "").toString().trim().replace(/-/g, "").replace(/\s+/g, "");
      const valA = normalize(a[currentSort.field]);
      const valB = normalize(b[currentSort.field]);
      return currentSort.direction === "asc"
        ? valA.localeCompare(valB, "ko", { sensitivity: "base", numeric: true })
        : valB.localeCompare(valA, "ko", {
            sensitivity: "base",
            numeric: true,
          });
    });
  }

  // 3. 데이터 없음 (Empty State)
  if (sorted.length === 0) {
    tbody.innerHTML = `
      <tr class="customer-empty-state">
        <td colspan="12" class="py-24 text-center select-none pointer-events-none">
          <div class="flex flex-col items-center gap-3 text-slate-300 dark:text-slate-600">
            <div class="w-16 h-16 rounded-full bg-slate-50 dark:bg-slate-800 flex items-center justify-center mb-1">
              <i class="fas fa-search text-3xl text-slate-200 dark:text-slate-600"></i>
            </div>
            <p class="text-slate-500 dark:text-slate-400 font-medium text-base">
              조건에 맞는 이용자가 없습니다.
            </p>
          </div>
        </td>
      </tr>`;
    updatePagerUI();
    return;
  }

  // 4. 행(Row) 생성
  sorted.forEach((c) => {
    const tr = document.createElement("tr");
    tr.className =
      "border-b border-slate-50 dark:border-slate-700/50 hover:bg-blue-50/50 dark:hover:bg-slate-700/30 transition-colors group";

    // 상태 배지
    let statusClass =
      "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400";
    if (c.status === "지원") {
      statusClass =
        "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400";
    } else if (c.status === "중단" || c.status === "제외") {
      statusClass =
        "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400";
    } else if (c.status === "사망") {
      statusClass =
        "bg-slate-100 text-slate-500 line-through decoration-slate-400 dark:bg-slate-800 dark:text-slate-500";
    }

    // 데이터 셀 렌더링 (text-sm, text-slate-700 적용됨)
    tr.innerHTML = `
      <td class="px-6 py-3.5 whitespace-nowrap">
        <span class="font-bold text-slate-900 dark:text-slate-100">${
          c.name || "-"
        }</span>
      </td>
      <td class="px-6 py-3.5 whitespace-nowrap text-sm text-slate-700 dark:text-slate-300">
        ${c.birth || "-"}
      </td>
      <td class="px-6 py-3.5 whitespace-nowrap text-sm text-slate-700 dark:text-slate-300">
        ${c.gender || "-"}
      </td>
      <td class="px-6 py-3.5 whitespace-nowrap">
        <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold ${statusClass}">
          ${c.status || "미지정"}
        </span>
      </td>
      <td class="px-6 py-3.5 whitespace-nowrap text-sm text-slate-700 dark:text-slate-300">
        ${c.region1 || "-"}
      </td>
      <td class="px-6 py-3.5 whitespace-nowrap text-sm text-slate-700 dark:text-slate-300">
        ${c.address || "-"}
      </td>
      <td class="px-6 py-3.5 whitespace-nowrap text-sm text-slate-700 dark:text-slate-300 tracking-tight">
        ${c.phone || "-"}
      </td>
      <td class="px-6 py-3.5 whitespace-nowrap text-sm text-slate-700 dark:text-slate-300">
        ${c.type || "-"}
      </td>
      <td class="px-6 py-3.5 whitespace-nowrap text-sm text-slate-700 dark:text-slate-300">
        ${c.category || "-"}
      </td>
      <td class="px-6 py-3.5 whitespace-nowrap text-sm text-slate-700 dark:text-slate-300">
        ${c.lastVisit || "-"}
      </td>
      <td class="px-6 py-3.5 whitespace-nowrap text-sm text-slate-700 dark:text-slate-300">
        ${c.note || "-"}
      </td>
      <td class="px-6 py-3.5 text-center whitespace-nowrap">
        <div class="flex justify-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
          <button class="btn btn-ghost w-8 h-8 rounded-lg p-0 text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-900/30 transition-colors" title="수정" data-edit="${
            c.id
          }">
            <i class="fas fa-pen text-xs"></i>
          </button>
          <button class="btn btn-ghost w-8 h-8 rounded-lg p-0 text-rose-500 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-900/30 transition-colors" title="삭제" data-del="${
            c.id
          }">
            <i class="fas fa-trash text-xs"></i>
          </button>
        </div>
      </td>
    `;

    tr.addEventListener("dblclick", () => openEditModal(c));
    tbody.appendChild(tr);
  });

  updatePagerUI();
}

// thead 정렬: 새 컬럼 순서에 맞춰 매핑
const fieldMap = [
  "name",
  "birth",
  "gender",
  "status",
  "region1",
  "address",
  "phone",
  "type",
  "category",
  "lastVisit",
  "note",
];

document.querySelectorAll("#customers-thead th").forEach((th, index) => {
  const field = fieldMap[index];
  if (field) {
    th.style.cursor = "pointer";
    // 기존 리스너 중복 방지를 위해 onclick 프로퍼티 사용 권장 (또는 기존 addEventListener 유지 시 내부 로직만 교체)
    th.onclick = () => {
      // 1. 정렬 상태 업데이트
      if (currentSort.field === field) {
        currentSort.direction =
          currentSort.direction === "asc" ? "desc" : "asc";
      } else {
        currentSort.field = field;
        currentSort.direction = "asc";
      }

      // 2. [핵심] 모드에 따른 동작 분기
      // buildBaseQuery가 존재하면 '서버 페이징' 모드 -> 서버에 재요청
      if (typeof buildBaseQuery === "function" && buildBaseQuery) {
        reloadPageWithNewSort();
      } else {
        // buildBaseQuery가 없으면 '로컬 통합검색' 모드 -> 클라이언트 정렬
        renderTable(displaydData);
      }

      updateSortIcons();
    };
  } else {
    th.style.cursor = "default";
  }
});

// function initCustomSelect(id, inputId = null) {
//   const select = document.getElementById(id);
//   const selected = select.querySelector(".selected");
//   const options = select.querySelector(".options");
//   const input = inputId ? document.getElementById(inputId) : null;

//   if (selected) {
//     selected.addEventListener("click", () => {
//       options.classList.toggle("hidden");
//     });

//     options.querySelectorAll("div").forEach((opt) => {
//       opt.addEventListener("click", () => {
//         selected.textContent = opt.textContent;
//         selected.dataset.value = opt.dataset.value;
//         options.classList.add("hidden");
//       });
//     });
//   }

//   if (input) {
//     options.querySelectorAll("div").forEach((opt) => {
//       opt.addEventListener("click", () => {
//         input.value = opt.dataset.value;
//         options.classList.add("hidden");
//       });
//     });
//     input.addEventListener("focus", () => options.classList.remove("hidden"));
//     input.addEventListener("blur", () =>
//       setTimeout(() => options.classList.add("hidden"), 150)
//     );
//   }
// }

// 모달 열기 시 데이터 설정
function openEditModal(customer) {
  editingOriginal = { ...customer }; // 편집 취소 시 복원용
  const idInput = document.getElementById("edit-id");
  if (idInput) idInput.value = customer.id || "";
  document.getElementById("edit-name").value = customer.name || "";
  document.getElementById("edit-birth").value = customer.birth || "";
  document.getElementById("edit-region1").value = customer.region1 || "";
  document.getElementById("edit-address").value = customer.address || "";
  initPhoneList(
    "#edit-phone-wrap",
    "#edit-phone-add",
    splitPhonesToArray(customer.phone)
  );
  document.getElementById("edit-type").value = customer.type || "";
  document.getElementById("edit-category").value = customer.category || "";
  document.getElementById("edit-note").value = customer.note || "";

  // select 값 세팅
  const gSel = document.getElementById("edit-gender");
  if (gSel) gSel.value = customer.gender || "";
  const sSel = document.getElementById("edit-status");
  if (sSel) sSel.value = customer.status || "지원";

  document.getElementById("edit-modal").classList.remove("hidden");

  // 수정 모달에도 엄격 포맷 적용 (중복 바인딩 방지)
  const eBirth = document.getElementById("edit-birth");
  if (eBirth && !eBirth.dataset.strictBound) {
    eBirth.addEventListener("input", () => {
      eBirth.value = formatBirthStrictInput(eBirth.value);
      eBirth.setCustomValidity("");
    });
    eBirth.addEventListener("blur", () => {
      if (!validateBirthStrict(eBirth.value)) {
        eBirth.setCustomValidity(
          "생년월일은 YYYYMMDD 형식(예: 19990203)으로 입력하세요."
        );
        eBirth.reportValidity();
      } else {
        eBirth.value = finalizeBirthStrict(eBirth.value);
        eBirth.setCustomValidity("");
      }
    });
    eBirth.dataset.strictBound = "1";
  }
}

// 저장 시 반영
// [수정] 수정 모달 저장 버튼 클릭 이벤트 (Form Submit 대체)
document
  .getElementById("edit-modal-save")
  .addEventListener("click", async () => {
    // 1. 필수값 검증 (이름, 생년월일)
    const nameInput = document.getElementById("edit-name");
    const birthInput = document.getElementById("edit-birth");

    if (!nameInput.value.trim() || !birthInput.value.trim()) {
      showToast("이름과 생년월일은 필수 입력 항목입니다.", true);
      // 빈 칸으로 포커스 이동
      if (!nameInput.value.trim()) nameInput.focus();
      else birthInput.focus();
      return;
    }

    const id = document.getElementById("edit-id").value;
    const email = auth.currentUser?.email || "unknown";

    // 2. 전화번호 수집
    const phoneVals = getPhonesFromList("#edit-phone-wrap");
    const picked = parsePhonesPrimarySecondary(...phoneVals);

    // 3. 지역 정보 가져오기
    const region1Val = (
      document.getElementById("edit-region1")?.value || ""
    ).trim();

    // 4. 생년월일 처리
    const editBirthRaw = document.getElementById("edit-birth").value;
    // (엄격 검증 함수가 있다면 체크)
    if (
      typeof validateBirthStrict === "function" &&
      !validateBirthStrict(editBirthRaw)
    ) {
      showToast("생년월일은 YYYYMMDD 형식(예: 19990203)으로 입력하세요.", true);
      return;
    }
    const editBirth =
      typeof finalizeBirthStrict === "function"
        ? finalizeBirthStrict(editBirthRaw)
        : editBirthRaw;

    // 5. 업데이트할 데이터 생성
    const updateData = {
      name: nameInput.value.trim(),
      birth: editBirth,
      gender: document.getElementById("edit-gender").value || "",
      status: document.getElementById("edit-status").value || "",
      region1: region1Val,
      regionLower: normalize(region1Val),
      address: document.getElementById("edit-address").value,

      phone: picked.display,
      phonePrimary: picked.prim || "",
      phoneSecondary: picked.sec || "",

      type: document.getElementById("edit-type").value,
      category: document.getElementById("edit-category").value,
      note: document.getElementById("edit-note").value,

      updatedAt: new Date().toISOString(),
      updatedBy: email,

      nameLower: normalize(nameInput.value),
      ...buildPhoneIndexFields(picked.display),
    };

    try {
      if (isAdmin) {
        await updateDoc(doc(db, "customers", id), updateData);
        showToast("수정되었습니다");

        // 로컬 캐시 갱신 (지원 상태 변경에 따른 처리)
        try {
          const dbi = await openIDB();
          const tx = dbi.transaction(IDB_STORE, "readwrite");
          const st = tx.objectStore(IDB_STORE);
          if (updateData.status !== "지원") {
            st.delete(id);
          } else {
            st.put(toCacheShape({ id, ...updateData }));
          }
        } catch {}

        await logEvent("customer_update", { id, changes: updateData });
      } else {
        // 비관리자 승인 요청
        const ok = await openConfirm({
          title: "수정 승인 요청",
          message:
            "관리자 승인이 필요한 사항입니다. 승인요청을 보내시겠습니까?",
          variant: "warn",
          confirmText: "승인 요청",
          cancelText: "취소",
          defaultFocus: "cancel",
        });
        if (!ok) return;

        await setDoc(doc(collection(db, "approvals")), {
          type: "customer_update",
          payload: { id, ...updateData },
          requestedBy: email,
          requestedAt: Timestamp.now(),
          approved: false,
        });
        showToast("수정 요청이 전송되었습니다");
      }

      // 모달 닫기 및 목록 새로고침
      document.getElementById("edit-modal").classList.add("hidden");
      await refreshAfterMutation();
    } catch (err) {
      console.error(err);
      showToast("수정 실패: " + err.message, true);
    }
  });

document.getElementById("edit-modal-close")?.addEventListener("click", () => {
  document.getElementById("edit-modal").classList.add("hidden");
});

function updateSortIcons() {
  const ths = document.querySelectorAll("#customers-thead th");
  // 정렬 가능한 필드 매핑
  const fieldMap = [
    "name",
    "birth",
    "gender",
    "status",
    "region1",
    "address",
    "phone",
    "type",
    "category",
    "lastVisit",
    "note",
  ];

  ths.forEach((th, index) => {
    const field = fieldMap[index];
    if (!field) return; // 작업 열 등 정렬 불가능한 열은 패스

    // 1. 현재 정렬 상태 확인
    const isSorted = currentSort.field === field;
    const dir = currentSort.direction;

    // 2. 아이콘 결정
    let iconClass = "fa-sort"; // 기본: 양방향 (흐릿함)
    let colorClass = "text-slate-300 dark:text-slate-600"; // 기본 색상

    if (isSorted) {
      iconClass = dir === "asc" ? "fa-sort-up" : "fa-sort-down";
      colorClass = "text-blue-600 dark:text-blue-400"; // 활성 색상
    }

    // 3. HTML 다시 그리기 (Flexbox로 정렬)
    // 기존 텍스트(label)를 유지하면서 아이콘을 옆에 붙임
    th.innerHTML = `
      <div class="flex items-center gap-1.5 cursor-pointer select-none">
        <span>${th.dataset.label}</span>
        <i class="fas ${iconClass} ${colorClass} transition-colors text-xs"></i>
      </div>
    `;
  });
}
function normalize(str) {
  return (
    str
      ?.toString()
      .toLowerCase()
      .replace(/[\s\-]/g, "") || ""
  );
}

function buildPhoneIndexFields(displayPhones = "") {
  const toks = [];
  String(displayPhones)
    .split(/[,\s/]+/)
    .map((t) => t.replace(/\D/g, ""))
    .filter(Boolean)
    .forEach((d) => {
      toks.push(d);
      if (d.length >= 4) toks.push(d.slice(-4));
    });
  const phoneTokens = Array.from(new Set(toks));
  const phoneLast4 = phoneTokens.find((t) => t.length === 4) || "";
  return { phoneTokens, phoneLast4 };
}

// =====  검색 =====

// 에러 상태 토글 유틸
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

let __searchTimer = null;
// [수정] 통합 검색 및 필드 검색 로직
async function runServerSearch() {
  const gInput = document.getElementById("global-search");
  const fSelect = document.getElementById("field-select");
  const fInput = document.getElementById("field-search");

  const globalKeyword = normalize(gInput?.value || "");
  const field = fSelect?.value || "";
  const fieldRaw = (fInput?.value || "").trim();
  const fieldValue = normalize(fieldRaw);

  // 1. [초기화] 검색 시작 시 기존 에러 상태 모두 해제
  toggleSearchError("global-search-group", false);
  toggleSearchError("field-search-group", false);

  // 검색 조건이 아예 없으면 -> 기본 목록으로 초기화
  if (!globalKeyword && (!field || !fieldValue)) {
    resetPager("list:nameLower:asc", () => [
      ...roleConstraint(),
      orderBy("nameLower"),
      orderBy(documentId()),
    ]);
    return;
  }

  // 2. [통합 검색] (로컬 캐시 사용)
  if (globalKeyword) {
    const localRows = await localUnifiedSearch(globalKeyword);
    displaydData = localRows;
    renderTable(localRows);

    // 페이저 등 초기화
    buildCurrentQuery = null;
    currentPageIndex = 0;
    lastPageCount = 0;
    pagesKnown = 1;
    updatePagerUI();

    // [핵심] 결과가 0건이면 통합 검색창에 에러 표시
    if (localRows.length === 0) {
      toggleSearchError("global-search-group", true, "검색 결과가 없습니다.");
    }
    return; // 로컬 검색 종료
  }

  // 3. [상세(필드) 검색] (서버 페이지네이션)
  else if (field && fieldValue) {
    const identityParts = [];
    if (!isAdmin) identityParts.push("role:user");
    identityParts.push(`field:${field}`, `value:${fieldValue}`);
    const identity = identityParts.join("|");

    // resetPager를 호출하면 내부적으로 fetchAndRenderPage가 실행됨
    // 따라서 상세 검색의 '결과 없음' 처리는 fetchAndRenderPage에서 수행
    resetPager(identity, () => {
      const cons2 = [...roleConstraint()];
      switch (field) {
        case "name":
          cons2.push(orderBy("nameLower"), orderBy(documentId()));
          cons2.push(startAt(fieldValue), endAt(fieldValue + "\uf8ff"));
          break;
        case "birth":
          cons2.push(where("birth", "==", formatBirth(fieldRaw, true)));
          cons2.push(orderBy(documentId()));
          break;
        case "region1":
          cons2.push(where("region1", "==", fieldRaw));
          cons2.push(orderBy(documentId()));
          break;
        case "status":
          cons2.push(where("status", "==", fieldRaw || "지원"));
          cons2.push(orderBy(documentId()));
          break;
        case "type":
          cons2.push(where("type", "==", fieldRaw));
          cons2.push(orderBy(documentId()));
          break;
        case "category":
          cons2.push(where("category", "==", fieldRaw));
          cons2.push(orderBy(documentId()));
          break;
        case "note":
          cons2.push(where("note", "==", fieldRaw));
          cons2.push(orderBy(documentId()));
          break;
        case "phone": {
          const d = fieldRaw.replace(/\D/g, "");
          if (d.length >= 3)
            cons2.push(where("phoneTokens", "array-contains", d));
          else cons2.push(where("phoneLast4", "==", d));
          cons2.push(orderBy(documentId()));
          break;
        }
        default:
          // 인덱스 없는 필드 (로컬 필터링)
          buildCurrentQuery = null;
          const filtered = customerData.filter((c) =>
            normalize(c[field] || "").includes(fieldValue)
          );
          renderTable(filtered);

          currentPageIndex = 0;
          lastPageCount = 0;
          __hasNextPage = false;
          pagesKnown = 1;
          updatePagerUI();

          // [핵심] 로컬 필터링 결과 0건 처리
          if (filtered.length === 0) {
            toggleSearchError(
              "field-search-group",
              true,
              "조건에 맞는 결과가 없습니다."
            );
          }
          return [];
      }
      return cons2;
    });
  }
}

function filterAndRenderField() {
  clearTimeout(__searchTimer);
  __searchTimer = setTimeout(runServerSearch, 200);
}
async function runGlobalSearchNow() {
  await runServerSearch(); // 내부에서 로컬 통합검색 수행
}

document
  .getElementById("toggle-advanced-search")
  .addEventListener("click", () => {
    const adv = document.getElementById("advanced-search");
    adv.classList.toggle("hidden");

    const btn = document.getElementById("toggle-advanced-search");
    btn.textContent = adv.classList.contains("hidden")
      ? "상세 검색"
      : "상세 검색 닫기";
  });
document
  .getElementById("btn-run-search")
  ?.addEventListener("click", runGlobalSearchNow);

document
  .getElementById("field-select")
  .addEventListener("change", filterAndRenderField);
document.getElementById("field-search").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    filterAndRenderField();
  }
});
document
  .getElementById("btn-run-field-search")
  ?.addEventListener("click", filterAndRenderField);

// 초기 로딩: 인증 준비(onAuthStateChanged) 후 역할/목록 로드
document.addEventListener("DOMContentLoaded", () => {
  onAuthStateChanged(auth, async (user) => {
    await applyRoleFromUser(user);
    bindToolbarAndCreateModal();
    const searchInput = document.getElementById("global-search");
    if (searchInput) {
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          runGlobalSearchNow();
        }
      });
    }
    await loadCustomers(); // 서버 페이지네이션 첫 페이지 + 캐시 동기화
  });
  // 페이지 사이즈 공통 초기화(A안)
  initPageSizeSelect(document.getElementById("page-size"), (n) => {
    pageSize = n;
    // 커서 초기화 및 첫 페이지 로드 (집계 없이)
    const id = currentQueryIdentity || "list:nameLower:asc";
    const baseBuilder =
      buildBaseQuery ||
      (() => [
        ...roleConstraint(),
        orderBy("nameLower"),
        orderBy(documentId()),
      ]);
    resetPager(id, baseBuilder);
  });
});

// 총 페이지 수 계산(count) — statistics와 동일 개념
async function computeCustomersTotalPages() {
  if (!buildBaseQuery) {
    __totalPages = 1;
    return 1;
  }
  try {
    const base = collection(db, "customers");
    const agg = await getCountFromServer(query(base, ...buildBaseQuery()));
    const total = Number(agg.data().count || 0);
    __totalPages = Math.max(1, Math.ceil(total / pageSize));
    return __totalPages;
  } catch (e) {
    console.warn("[Customers] totalPages count failed", e);
    __totalPages = 1;
    return 1;
  }
}

// ===== 수정, 삭제 버튼 =====
document.addEventListener("click", async (e) => {
  // 수정
  const editBtn = e.target.closest("[data-edit]");
  if (editBtn) {
    const id = editBtn.getAttribute("data-edit");
    const row = (customerData || []).find((x) => x.id === id);
    if (row) openEditModal(row);
    return;
  }
  // 삭제
  const del = e.target.closest("[data-del]");
  if (!del) return;
  if (isAdmin) {
    const ok = await openConfirm({
      title: "삭제 확인",
      message: "이 이용자를 삭제하시겠습니까?",
      variant: "danger",
      confirmText: "삭제",
      cancelText: "취소",
    });
    if (!ok) return;
    await deleteDoc(doc(db, "customers", del.dataset.del));
    showToast("삭제되었습니다");
    // 캐시 제거
    try {
      const dbi = await openIDB();
      const tx = dbi.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(del.dataset.del);
    } catch {}
    await logEvent("customer_delete", { targetId: del.dataset.del });
    await loadCustomers();
  } else {
    const ok = await openConfirm({
      title: "승인 요청",
      message: "관리자의 승인이 필요한 사항입니다. 승인을 요청하시겠습니까?",
      variant: "warn",
      confirmText: "승인 요청",
      cancelText: "취소",
      defaultFocus: "cancel",
    });
    if (!ok) return;
    await setDoc(doc(collection(db, "approvals")), {
      type: "customer_delete",
      targetId: del.dataset.del,
      requestedBy: auth.currentUser?.email || "",
      requestedAt: Timestamp.now(),
      approved: false,
    });
    showToast("삭제 승인 요청이 전송되었습니다");
    await logEvent("approval_request", {
      approvalType: "customer_delete",
      targetId: del.dataset.del,
    });
  }
});

// ===== 업로드 탭(옵션: 상태 필드 없어도 허용 / 모두 ‘지원’) & 미리보기/실행 =====
function bindUploadTab() {
  const modal = document.getElementById("customer-create-modal");
  const fileEl = modal.querySelector("#upload-file");
  const preview = modal.querySelector("#upload-preview");
  const dryBtn = modal.querySelector("#btn-upload-dryrun");
  const execBtn = modal.querySelector("#btn-upload-exec");

  // UI 제어용 엘리먼트 가져오기
  const uploaderBox = modal.querySelector(".uploader");
  const uiIconWrap = modal.querySelector("#upload-ui-icon-wrapper");
  const uiIcon = modal.querySelector("#upload-ui-icon");
  const uiTextMain = modal.querySelector("#upload-ui-text-main");
  const uiTextSub = modal.querySelector("#upload-ui-text-sub");

  let dryRows = null;
  let lastOptions = null;
  let lastDeactivateTargets = [];

  // [추가] 양식 다운로드 버튼 이벤트 연결
  document
    .getElementById("btn-download-template")
    ?.addEventListener("click", async () => {
      try {
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet("업로드양식");

        // 헤더 설정 (사용자가 입력해야 할 필드들)
        sheet.columns = [
          { header: "이용자명", key: "name", width: 15 },
          { header: "생년월일", key: "birth", width: 15 },
          { header: "성별", key: "gender", width: 8 },
          { header: "상태", key: "status", width: 10 },
          { header: "행정구역", key: "region1", width: 15 },
          { header: "주소", key: "address", width: 40 },
          { header: "전화번호", key: "phone", width: 20 },
          { header: "이용자구분", key: "type", width: 15 },
          { header: "이용자분류", key: "category", width: 15 },
          { header: "비고", key: "note", width: 30 },
        ];

        // 헤더 스타일링 (회색 배경, 굵게)
        const headerRow = sheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
        headerRow.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF4B5563" },
        };
        headerRow.alignment = { vertical: "middle", horizontal: "center" };

        // 예시 데이터 추가 (사용자가 보고 따라할 수 있도록)
        sheet.addRow({
          name: "홍길동",
          birth: "19800101",
          gender: "남",
          status: "지원",
          region1: "두류동",
          address: "대구광역시 달서구...",
          phone: "010-1234-5678",
          type: "기초생활수급자",
          category: "독거노인",
          note: "예시 데이터입니다.",
        });

        // 파일 다운로드 실행
        const buffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([buffer], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        saveAs(blob, "이용자등록 양식.xlsx");
      } catch (e) {
        console.error(e);
        showToast("양식 생성 중 오류가 발생했습니다.", true);
      }
    });

  // 1. [추가] 파일 선택 시 UI 즉시 변경 이벤트
  fileEl.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];

    if (file) {
      // 파일 있음: 파란색 테두리 + 엑셀 아이콘 + 파일명 표시
      uploaderBox.classList.remove(
        "border-slate-200",
        "dark:border-slate-700",
        "bg-slate-50/50",
        "dark:bg-slate-800/50"
      );
      uploaderBox.classList.add(
        "border-blue-500",
        "bg-blue-50/30",
        "dark:bg-blue-900/10"
      );

      uiIconWrap.classList.remove(
        "bg-blue-50",
        "text-blue-500",
        "dark:bg-blue-900/20"
      );
      uiIconWrap.classList.add(
        "bg-green-100",
        "text-green-600",
        "dark:bg-green-900/30",
        "dark:text-green-400"
      );

      uiIcon.className = "fas fa-file-excel text-2xl"; // 엑셀 아이콘으로 변경

      uiTextMain.textContent = file.name; // 파일명 표시
      uiTextMain.classList.add("text-blue-600", "dark:text-blue-400");

      // 파일 크기 계산 (KB)
      const kb = (file.size / 1024).toFixed(1);
      uiTextSub.textContent = `${kb} KB · 클릭하여 변경 가능`;
      uiTextSub.classList.add("text-blue-400");

      // 미리보기 초기화 (새 파일 선택 시)
      preview.textContent = "새 파일이 선택되었습니다. 미리보기를 눌러주세요.";
      preview.className =
        "p-4 bg-blue-50/50 dark:bg-slate-800 border border-blue-100 dark:border-slate-700 rounded-xl text-sm text-blue-800 dark:text-blue-300 text-center font-medium";
      execBtn.disabled = true;
      dryRows = null;
    } else {
      // 파일 취소됨: 초기 상태 복구
      resetUploaderUI();
    }
  });

  // UI 초기화 함수
  const resetUploaderUI = () => {
    uploaderBox.classList.add(
      "border-slate-200",
      "dark:border-slate-700",
      "bg-slate-50/50",
      "dark:bg-slate-800/50"
    );
    uploaderBox.classList.remove(
      "border-blue-500",
      "bg-blue-50/30",
      "dark:bg-blue-900/10"
    );

    uiIconWrap.classList.add(
      "bg-blue-50",
      "text-blue-500",
      "dark:bg-blue-900/20"
    );
    uiIconWrap.classList.remove(
      "bg-green-100",
      "text-green-600",
      "dark:bg-green-900/30",
      "dark:text-green-400"
    );

    uiIcon.className = "fas fa-cloud-upload-alt text-xl";
    uiTextMain.textContent = "엑셀 파일을 이곳에 드래그하거나 클릭하세요";
    uiTextMain.classList.remove("text-blue-600", "dark:text-blue-400");
    uiTextSub.textContent = ".xlsx, .xls 파일만 지원됩니다.";
    uiTextSub.classList.remove("text-blue-400");

    preview.textContent = "파일을 선택하고 미리보기를 눌러주세요.";
    fileEl.value = ""; // input 값 초기화
  };

  // [수정] bindUploadTab 내부의 '미리보기' 버튼 클릭 리스너 부분
  // [수정] 1. 미리보기 버튼 (변경사항 있는 경우만 표시)
  dryBtn.addEventListener("click", async () => {
    const f = fileEl.files?.[0];
    if (!f) return showToast("파일을 선택하세요.", true);

    lastOptions = {
      allowMissingStatus: modal.querySelector("#opt-allow-missing-status")
        .checked,
      statusMode:
        modal.querySelector("input[name='opt-status-mode']:checked")?.value ||
        "none",
    };

    try {
      dryRows = await parseAndNormalizeExcel(f, lastOptions);
      const total = dryRows.length;

      // DB 조회 (비교용)
      const base = collection(db, "customers");
      const q = isAdmin
        ? query(base)
        : query(base, where("status", "==", "지원"));
      const existingSnap = await getDocs(q);

      // 비교 맵 생성 (Key: 이름+생년월일 -> Value: 기존 데이터 객체)
      const existingMap = new Map();
      existingSnap.docs.forEach((d) => {
        const data = d.data();
        const key = slugId(data.name, data.birth);
        existingMap.set(key, { id: d.id, ...data });
      });

      const newRows = [];
      const updateRows = [];

      dryRows.forEach((r) => {
        const key = slugId(r.name, r.birth);
        const exist = existingMap.get(key);

        if (!exist) {
          // 신규: DB에 키가 없음
          newRows.push(r);
        } else {
          // 기존: 변경사항이 있는지 검사 (Diff Check)
          // 상태, 전화번호, 주소, 행정구역, 메모 등이 하나라도 다르면 업데이트 대상으로 분류
          const isStatusChanged = exist.status !== r.status;
          const isInfoChanged =
            (exist.phone || "") !== (r.phone || "") ||
            (exist.address || "") !== (r.address || "") ||
            (exist.region1 || "") !== (r.region1 || "") ||
            (exist.note || "") !== (r.note || "");

          if (isStatusChanged || isInfoChanged) {
            updateRows.push({
              ...r,
              _existId: exist.id, // 기존 ID 보존 (실행 시 사용 가능)
              _isStatusChanged: isStatusChanged,
              _oldStatus: exist.status,
            });
          }
          // 변경사항이 없으면 리스트에 포함하지 않음 (Pass)
        }
      });

      const newCnt = newRows.length;
      const updateCnt = updateRows.length;

      // 중단 대상 계산
      lastDeactivateTargets = [];
      if (lastOptions.statusMode === "all-support-stop-others") {
        const excelKeys = new Set(dryRows.map((r) => slugId(r.name, r.birth)));
        lastDeactivateTargets = existingSnap.docs
          .filter(
            (d) =>
              d.data().status === "지원" &&
              !excelKeys.has(slugId(d.data().name, d.data().birth))
          )
          .map((d) => d.id);
      }
      const stopCnt = lastDeactivateTargets.length;

      // 결과 HTML 생성
      let summaryHtml = `
      <div class="font-bold text-base mb-2">
        총 <span class="text-slate-900 dark:text-white">${total}</span>건 
        (신규 <span class="text-blue-600 dark:text-blue-400">${newCnt}</span> / 
         갱신 <span class="text-emerald-600 dark:text-emerald-400">${updateCnt}</span> /
         유지 <span class="text-slate-400">${total - newCnt - updateCnt}</span>)
      </div>
    `;

      if (lastOptions.statusMode === "all-support-stop-others" && stopCnt > 0) {
        summaryHtml += `<div class="text-xs text-rose-500 font-bold mb-3">※ 명단 미포함 ${stopCnt}명은 '중단' 처리됩니다.</div>`;
      }

      // (A) 신규 등록 테이블
      if (newCnt > 0) {
        summaryHtml += `
        <div class="mb-4 text-left">
          <div class="text-xs font-bold text-blue-600 mb-1">🌱 신규 등록 (${newCnt}명)</div>
          <div class="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden bg-white dark:bg-slate-900 shadow-sm max-h-[150px] overflow-y-auto custom-scrollbar">
            <table class="w-full text-xs">
              <thead class="bg-slate-50 dark:bg-slate-800 text-slate-500 sticky top-0">
                <tr>
                  <th class="px-3 py-2 text-left">이름</th>
                  <th class="px-3 py-2 text-left">생년월일</th>
                  <th class="px-3 py-2 text-left">상태</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                ${newRows
                  .map(
                    (r) => `
                  <tr>
                    <td class="px-3 py-2 font-bold">${r.name}</td>
                    <td class="px-3 py-2 text-slate-500">${r.birth}</td>
                    <td class="px-3 py-2"><span class="badge badge-xs badge-weak-primary">${r.status}</span></td>
                  </tr>`
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;
      }

      // (B) 업데이트 테이블
      if (updateCnt > 0) {
        summaryHtml += `
        <div class="text-left">
          <div class="text-xs font-bold text-emerald-600 mb-1">🔄 정보 변경 (${updateCnt}명)</div>
          <div class="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden bg-white dark:bg-slate-900 shadow-sm max-h-[150px] overflow-y-auto custom-scrollbar">
            <table class="w-full text-xs">
              <thead class="bg-slate-50 dark:bg-slate-800 text-slate-500 sticky top-0">
                <tr>
                  <th class="px-3 py-2 text-left">이름</th>
                  <th class="px-3 py-2 text-left">생년월일</th>
                  <th class="px-3 py-2 text-left">변경 내역</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
                ${updateRows
                  .map((r) => {
                    let statusHtml = ``;
                    if (r._isStatusChanged) {
                      statusHtml = `
                      <span class="text-slate-400 line-through mr-1">${r._oldStatus}</span>
                      <i class="fas fa-arrow-right text-[10px] text-slate-300 mx-1"></i>
                      <b class="text-blue-600">${r.status}</b>
                    `;
                    } else {
                      statusHtml = `<span class="text-slate-500">정보 갱신</span>`;
                    }
                    return `
                  <tr>
                    <td class="px-3 py-2 font-bold">${r.name}</td>
                    <td class="px-3 py-2 text-slate-500">${r.birth}</td>
                    <td class="px-3 py-2">${statusHtml}</td>
                  </tr>`;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;
      }

      // 변경 사항이 아예 없는 경우
      if (newCnt === 0 && updateCnt === 0) {
        summaryHtml += `<div class="mt-3 text-xs text-slate-400">데이터 변경 사항이 없습니다.</div>`;
      }

      preview.innerHTML = summaryHtml;
      preview.className =
        "p-5 bg-slate-50 dark:bg-slate-800/30 border border-slate-200 dark:border-slate-700 rounded-2xl text-center text-sm text-slate-600 dark:text-slate-300";
      execBtn.disabled = false;
    } catch (e) {
      console.error(e);
      showToast("엑셀 파싱 실패. 형식을 확인해주세요.", true);
    }
  });

  // [수정] 2. 실행 버튼 (ID 매핑 로직 추가)
  execBtn.addEventListener("click", async () => {
    if (!dryRows) return;

    if (isAdmin) {
      showLoading("데이터를 업로드하고 있습니다...");

      try {
        const email = auth.currentUser?.email || "unknown";

        // 1. [핵심] 기존 ID 매핑을 위해 DB 다시 조회 (최신 상태 반영)
        // (미리보기 시점과 차이가 있을 수 있으므로 안전하게 다시 조회)
        const base = collection(db, "customers");
        const q = query(base); // 전체 조회 (ID 찾기용)
        const existingSnap = await getDocs(q);

        const idMap = new Map();
        existingSnap.docs.forEach((d) => {
          const data = d.data();
          // 내용 기반 매핑 (이름+생년월일 -> 실제 문서 ID)
          idMap.set(slugId(data.name, data.birth), d.id);
        });

        // 2. 데이터 저장
        const batchLimit = 400; // 배치 사이즈
        let batch = writeBatch(db);
        let count = 0;

        for (const r of dryRows) {
          const key = slugId(r.name, r.birth);
          // 기존 ID가 있으면 그것을 쓰고, 없으면 키를 그대로 ID로 사용(신규)
          const targetId = idMap.get(key) || key;

          const docRef = doc(db, "customers", targetId);
          batch.set(
            docRef,
            {
              ...r,
              updatedAt: new Date().toISOString(),
              updatedBy: email,
            },
            { merge: true }
          );

          count++;
          // 배치 커밋 (Batch Limit 도달 시)
          if (count % batchLimit === 0) {
            await batch.commit();
            batch = writeBatch(db);
          }
        }
        // 남은 배치 커밋
        if (count % batchLimit !== 0) {
          await batch.commit();
        }

        // 3. '중단' 처리 대상 업데이트
        if (
          lastOptions?.statusMode === "all-support-stop-others" &&
          lastDeactivateTargets?.length
        ) {
          await batchUpdateStatus(lastDeactivateTargets, "중단", email);
          await logEvent("customer_bulk_deactivate", {
            count: lastDeactivateTargets.length,
          });
        }

        showToast("업로드가 완료되었습니다");
        await logEvent("customer_add", { mode: "bulk", count: dryRows.length });

        resetUploaderUI();
        document
          .getElementById("customer-create-modal")
          .classList.add("hidden");
        resetCreateForm();
        await loadCustomers();
      } catch (e) {
        console.error(e);
        showToast("업로드 중 오류가 발생했습니다.", true);
      } finally {
        hideLoading();
      }
    } else {
      // 비관리자 로직 (기존과 동일하지만 ID 매핑이 필요하다면 서버리스 함수 등에서 처리 필요)
      // 일단 현재 구조상 비관리자는 '요청'만 보내므로 기존 코드 유지
      const ok = await openConfirm({
        title: "승인 요청",
        message:
          "관리자의 승인이 필요한 사항입니다. 승인요청을 보내시겠습니까?",
        variant: "warn",
        confirmText: "승인 요청",
        cancelText: "취소",
        defaultFocus: "cancel",
      });
      if (!ok) return;

      showLoading("승인 요청을 전송 중입니다...");

      try {
        await setDoc(doc(collection(db, "approvals")), {
          type: "customer_bulk_upload",
          payload: {
            rows: dryRows,
            options: lastOptions,
            deactivateTargets:
              lastOptions?.statusMode === "all-support-stop-others"
                ? lastDeactivateTargets
                : [],
          },
          requestedBy: auth.currentUser?.email || "",
          requestedAt: Timestamp.now(),
          approved: false,
        });

        showToast("업로드 승인 요청이 전송되었습니다");
        await logEvent("approval_request", {
          approvalType: "customer_bulk_upload",
          count: dryRows.length,
        });

        resetUploaderUI();
        document
          .getElementById("customer-create-modal")
          .classList.add("hidden");
        resetCreateForm();
      } catch (e) {
        console.error(e);
        showToast("요청 전송 실패.", true);
      } finally {
        hideLoading();
      }
    }
  });
}

async function parseAndNormalizeExcel(file, opts) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // 병합/제목행 대응: 헤더 자동 탐지 → 객체 배열화
  const rows = sheetToObjectsSmart(ws);

  const out = [];

  for (const row of rows) {
    // ── 헤더 매핑(스크린샷 파일 대응) ────────────────────────────────
    const name = cleanName(pick(row, "성명", "이용자명", "이름", "name"));
    const rrn = pick(row, "주민등록번호", "주민번호");
    let birth = pick(row, "생년월일", "생년월", "출생", "birth");
    let gender = pick(row, "성별", "gender");
    const region1 = pick(
      row,
      "행정구역",
      "행정동",
      "관할주민센터",
      "지역",
      "센터"
    );
    const address = pick(row, "주소");
    const { telCell, hpCell } = pickPhonesFromRow(row);
    const category = pick(row, "이용자분류", "분류", "세대유형");
    const type = pick(row, "이용자구분", "구분", "지원자격");
    const note = pick(row, "비고", "메모", "특이사항");
    let status = pick(row, "상태", "지원상태");

    if (!name) continue; // 이름은 필수

    // 주민번호로 생년월일/성별 보정(앞6뒤1만 있어도 처리)
    if ((!birth || !gender) && rrn) {
      const d = deriveBirthGenderFromRRNPartial(rrn);
      if (d) {
        if (!birth) birth = d.birth;
        if (!gender) gender = d.gender;
      }
    }
    birth = formatBirth(birth, true, rrn);
    if (!birth) continue; // 생년월일은 필수

    // 상태 기본값(옵션/파일명 기반)
    if (!status) {
      if (
        opts.statusMode === "all-support" ||
        opts.statusMode === "all-support-stop-others"
      )
        status = "지원";
      else if (opts.allowMissingStatus) status = "지원";
    } else if (
      opts.statusMode === "all-support" ||
      opts.statusMode === "all-support-stop-others"
    ) {
      status = "지원";
    }

    // 연락처 파싱: 대표 1개  보조 1개
    const p = parsePhonesPrimarySecondary(telCell, hpCell);
    const phoneDisplay = p.display; // "010-.... / 053-...." 형식

    const rec = {
      name,
      birth,
      gender,
      status,
      region1,
      address,
      // 표시용
      phone: phoneDisplay,
      // 보관용(검색/중복 판단 등에 활용 가능)
      phonePrimary: p.prim || "",
      phoneSecondary: p.sec || "",
      type,
      category,
      note,
    };

    // 🔎 인덱스 필드 추가
    rec.nameLower = normalize(name);
    rec.regionLower = normalize(region1 || "");
    const toks = [];
    [p.prim, p.sec].filter(Boolean).forEach((n) => {
      const digits = String(n).replace(/\D/g, "");
      if (digits) {
        toks.push(digits);
        if (digits.length >= 4) toks.push(digits.slice(-4)); // last4도 인덱싱
      }
    });
    rec.phoneTokens = Array.from(new Set(toks));
    rec.phoneLast4 = rec.phoneTokens.find((t) => t.length === 4) || "";
    out.push(rec);
  }
  return out;
}

// ========== 유틸(엑셀 파싱/정규화) ==========
// 1. 날짜 포맷팅 (YYYYMMDD -> YYYY.MM.DD)
function formatBirth(val, strict = false, rrn = "") {
  let v = String(val || "").trim();
  const digits = v.replace(/\D/g, "");

  // 8자리 숫자(19900101)라면 포맷팅 적용
  if (digits.length === 8) {
    return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}`;
  }
  // 이미 포맷된 경우(1990.01.01) 그대로 반환
  if (/^\d{4}\.\d{2}\.\d{2}$/.test(v)) return v;
  return v;
}

// 헤더 자동 탐지(제목행/병합 헤더 대응)
function sheetToObjectsSmart(ws) {
  const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
  const looksLikeHeader = (r = []) =>
    r.some((c) =>
      /성\s*명|이용자명|주민등록번호|행정동|주소|연락처|핸드폰|세대유형|지원자격|비고/.test(
        String(c)
      )
    );
  const hIdx = arr.findIndex(looksLikeHeader);
  const header = (hIdx >= 0 ? arr[hIdx] : arr[0]).map((c) =>
    String(c).replace(/\s+/g, "").trim()
  );
  const data = arr
    .slice(hIdx >= 0 ? hIdx + 1 : 1)
    .filter((r) => r.some((v) => String(v).trim() !== ""));
  return data.map((r) => {
    const o = {};
    header.forEach((h, i) => (o[h || `COL${i}`] = r[i]));
    return o;
  });
}
// 헤더 별칭 선택
function pick(obj, ...keys) {
  for (const k of keys) {
    const kNorm = String(k).replace(/\s+/g, "");
    for (const ok of Object.keys(obj)) {
      if (String(ok).replace(/\s+/g, "") === kNorm) return obj[ok];
    }
  }
  return "";
}

// 헤더 정규화: 소문자, 공백/괄호/구분자 제거
function _normHeader(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s\(\)\[\]\{\}\-_:]/g, "");
}
// 연락처 헤더 자동 감지
function pickPhonesFromRow(row) {
  const keys = Object.keys(row || {});
  const hpVals = [];
  const telVals = [];
  for (const k of keys) {
    const nk = _normHeader(k);
    const val = row[k];
    if (val == null || val === "") continue;
    // 대표 패턴
    const hasMobile =
      /휴대|핸드폰|모바일|cell|handphone|hp/.test(nk) ||
      (/연락처\d*$/.test(nk) && /1$/.test(nk)); // 연락처1 → 휴대 우선
    const hasTel =
      (/전화|연락처|자택|집/.test(nk) && !/휴대|핸드폰|모바일/.test(nk)) ||
      /전화번호\d*$/.test(nk) ||
      (/연락처\d*$/.test(nk) && /2$/.test(nk)); // 연락처2 → 유선 쪽
    if (hasMobile) hpVals.push(val);
    else if (hasTel) telVals.push(val);
    // 애매하면 보류(모두 스캔 후 부족분 보충)
  }
  // 보충: 아무 것도 못 찾았으면 전체 열에서 숫자 포함 칸을 긁어 통합
  const concat = (arr) =>
    arr
      .map((v) => String(v))
      .filter((s) => /\d{2,}/.test(s))
      .join(" ");
  let hpCell = concat(hpVals);
  let telCell = concat(telVals);
  if (!hpCell && !telCell) {
    const any = keys
      .map((k) => row[k])
      .map((v) => String(v))
      .filter((s) => /\d{2,}/.test(s))
      .join(" ");
    // 휴대/유선 구분 없이 한 뭉치라도 넘겨서 파서가 모바일 우선으로 뽑게
    return { hpCell: any, telCell: "" };
  }
  return { hpCell, telCell };
}

// 이름 앞의 "7." 등 제거
function cleanName(v) {
  return String(v || "")
    .trim()
    .replace(/^\d+[\.\-]?\s*/, "");
}
// 주민번호 앞6자리+뒤1자리 → 생년월일/성별
function deriveBirthGenderFromRRNPartial(rrn) {
  const digits = String(rrn || "").replace(/\D/g, "");
  if (digits.length < 7) return null;
  const yymmdd = digits.slice(0, 6);
  const code = digits[6];
  let century = null,
    gender = null;
  if (code === "1" || code === "2") century = 1900;
  if (code === "3" || code === "4") century = 2000;
  if (code === "1" || code === "3") gender = "남";
  if (code === "2" || code === "4") gender = "여";
  if (!century || !gender) return null;
  const yy = parseInt(yymmdd.slice(0, 2), 10);
  const mm = yymmdd.slice(2, 4);
  const dd = yymmdd.slice(4, 6);
  if (!(+mm >= 1 && +mm <= 12 && +dd >= 1 && +dd <= 31)) return null;
  return { birth: `${century + yy}.${mm}.${dd}`, gender };
}
// 여러 번호에서 대표1 + 보조1 선택 (우선순위: HP → 모바일 보충 → 유선 보충)
function parsePhonesPrimarySecondary(telCell, hpCell) {
  const extract = (text = "") => {
    // 괄호 '내용'을 날리지 말고 괄호 문자만 제거해 (053)도 인식되도록
    const cleaned = String(text).replace(/[()]/g, " ");
    const found = cleaned.match(/0\d{1,2}[- ]?\d{3,4}[- ]?\d{4}/g) || [];
    const extra = cleaned.match(/0\d{8,10}/g) || [];
    const nums = [...found, ...extra]
      .map((s) => s.replace(/\D/g, ""))
      .filter((n) => n.length >= 9 && n.length <= 11);
    return Array.from(new Set(nums));
  };
  const hpNums = extract(hpCell); // 휴대폰 칼럼
  const telNums = extract(telCell); // 유선 칼럼
  const all = [...hpNums, ...telNums.filter((n) => !hpNums.includes(n))];
  if (!all.length) return { display: "", prim: "", sec: "" };

  const isMobile = (n) => /^01[016789]/.test(n);
  const fmt = (n) =>
    n.length === 11
      ? `${n.slice(0, 3)}-${n.slice(3, 7)}-${n.slice(7)}`
      : n.startsWith("02") && n.length === 10
      ? `02-${n.slice(2, 5)}-${n.slice(5)}`
      : n.length === 10
      ? `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}`
      : n;

  // 1) HP에서 모바일 2개까지 먼저
  const hpMobiles = hpNums.filter(isMobile);
  let primary = hpMobiles[0] || "";
  let secondary = hpMobiles[1] || "";
  // 2) 부족분은 전체에서 모바일로 보충
  if (!primary) {
    const m = all.find(isMobile);
    if (m) primary = m;
  }
  if (!secondary) {
    const m2 = all.find((n) => isMobile(n) && n !== primary);
    if (m2) secondary = m2;
  }
  // 3) 그래도 비면 유선으로 보충
  if (!primary) primary = all[0] || "";
  if (!secondary) {
    const land = all.find((n) => n !== primary) || "";
    secondary = land;
  }
  const display = [primary, secondary].filter(Boolean).map(fmt).join(" / ");
  return { display, prim: primary || "", sec: secondary || "" };
}

// ===== 내보내기 (ExcelJS: 스타일 + No. 추가) =====
async function exportXlsx() {
  const btn = document.getElementById("btn-export-xlsx");
  const originalBtnText = btn.innerHTML;
  setBusy(btn, true);

  try {
    let rowsToExport = [];

    // 1. [데이터 확보]
    if (typeof buildBaseQuery === "function" && buildBaseQuery) {
      showToast("전체 데이터를 다운로드 중입니다...", false);
      const base = collection(db, "customers");
      const constraints = buildBaseQuery();
      const q = query(base, ...constraints);
      const snap = await getDocs(q);
      rowsToExport = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } else {
      rowsToExport = displaydData;
    }

    if (!rowsToExport.length) {
      showToast("내보낼 데이터가 없습니다.", true);
      return;
    }

    // 2. [워크북 생성]
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("customers");

    // 3. [헤더 설정] (맨 앞에 'No.' 추가)
    worksheet.columns = [
      { header: "No.", key: "no", width: 6 }, // [추가됨] 너비 6
      { header: "이용자명", key: "name", width: 15 },
      { header: "생년월일", key: "birth", width: 15 },
      { header: "성별", key: "gender", width: 8 },
      { header: "상태", key: "status", width: 10 },
      { header: "행정구역", key: "region1", width: 15 },
      { header: "주소", key: "address", width: 60 },
      { header: "전화번호", key: "phone", width: 40 },
      { header: "이용자구분", key: "type", width: 20 },
      { header: "이용자분류", key: "category", width: 20 },
      { header: "비고", key: "note", width: 30 },
    ];

    // 헤더 행 스타일링
    const headerRow = worksheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF4B5563" },
      };
      cell.font = {
        color: { argb: "FFFFFFFF" },
        bold: true,
      };
      cell.alignment = { vertical: "middle", horizontal: "center" };
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
    });
    headerRow.height = 25;

    // 4. [데이터 추가] (index를 사용하여 번호 매기기)
    rowsToExport.forEach((c, index) => {
      worksheet.addRow({
        no: index + 1, // [추가됨] 1부터 시작하는 연번
        name: c.name || "",
        birth: c.birth || "",
        gender: c.gender || "",
        status: c.status || "",
        region1: c.region1 || "",
        address: c.address || "",
        phone: c.phone || "",
        type: c.type || "",
        category: c.category || "",
        note: c.note || "",
      });
    });

    // 5. [데이터 행 스타일링]
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      row.eachCell((cell, colNumber) => {
        cell.border = {
          top: { style: "thin" },
          left: { style: "thin" },
          bottom: { style: "thin" },
          right: { style: "thin" },
        };

        // 기본 정렬: 세로 중앙
        const align = { vertical: "middle", wrapText: false };

        // [디테일] 'No.', '생년월일', '성별', '상태'는 가운데 정렬하면 예쁩니다
        if ([1, 3, 4, 5].includes(colNumber)) {
          align.horizontal = "center";
        }

        cell.alignment = align;
      });
    });

    // 6. [파일 저장]
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    saveAs(blob, `customers_${dateStamp()}.xlsx`);

    showToast(`총 ${rowsToExport.length}건 다운로드 완료`);
  } catch (e) {
    console.error(e);
    showToast("엑셀 다운로드 중 오류가 발생했습니다.", true);
  } finally {
    setBusy(btn, false);
    btn.innerHTML = originalBtnText;
  }
}

// 날짜 포맷팅 헬퍼 (파일명 생성용)
function dateStamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(
    d.getHours()
  )}${z(d.getMinutes())}`;
}

// ===== 동명이인 모달 동작 =====
async function onDupUpdate() {
  const payload = pendingCreatePayload;
  const ref = pendingDupRef;
  const before = pendingDupData || {};
  if (!payload || !ref) return;
  if (isAdmin) {
    await updateDoc(ref, payload);
    showToast("기존 정보가 업데이트되었습니다");
    await logEvent("customer_update", {
      targetId: ref.id,
      changes: payload,
      mode: "dup_update",
    });
  } else {
    // 변경분만 추려 승인요청
    const changes = {};
    [
      "name",
      "birth",
      "gender",
      "status",
      "region1",
      "address",
      "phone",
      "type",
      "category",
      "note",
    ].forEach((k) => {
      if ((payload[k] ?? "") !== (before[k] ?? ""))
        changes[k] = payload[k] ?? "";
    });
    const ok = await openConfirm({
      title: "승인 요청",
      message: "관리자의 승인이 필요한 사항입니다. 승인을 요청하시겠습니까?",
      variant: "warn",
      confirmText: "승인 요청",
      cancelText: "취소",
      defaultFocus: "cancel",
    });
    if (!ok) return;
    await setDoc(doc(collection(db, "approvals")), {
      type: "customer_update",
      targetId: ref.id,
      changes,
      requestedBy: auth.currentUser?.email || "",
      requestedAt: Timestamp.now(),
      approved: false,
    });
    showToast("승인 요청이 전송되었습니다");
    await logEvent("approval_request", {
      approvalType: "customer_update",
      targetId: ref.id,
      changes,
      mode: "dup_update",
    });
  }
  document.getElementById("dup-modal").classList.add("hidden");
  document.getElementById("customer-create-modal").classList.add("hidden");
  pendingCreatePayload = pendingDupRef = pendingDupData = null;
  await loadCustomers();
}
async function onDupNew() {
  const payload = pendingCreatePayload;
  if (!payload) return;
  if (isAdmin) {
    await setDoc(doc(collection(db, "customers")), payload);
    showToast("동명이인 신규로 등록되었습니다");
    await logEvent("customer_add", {
      name: payload.name,
      birth: payload.birth,
      mode: "dup_new",
    });
  } else {
    const ok = await openConfirm({
      title: "승인 요청",
      message: "관리자의 승인이 필요한 사항입니다. 승인을 요청하시겠습니까?",
      variant: "warn",
      confirmText: "승인 요청",
      cancelText: "취소",
      defaultFocus: "cancel",
    });
    if (!ok) return;
    await setDoc(doc(collection(db, "approvals")), {
      type: "customer_add",
      payload,
      mode: "create_new",
      requestedBy: auth.currentUser?.email || "",
      requestedAt: Timestamp.now(),
      approved: false,
    });
    showToast("승인 요청이 전송되었습니다");
    await logEvent("approval_request", {
      approvalType: "customer_add",
      name: payload.name,
      birth: payload.birth,
      mode: "dup_new",
    });
  }
  document.getElementById("dup-modal").classList.add("hidden");
  document.getElementById("customer-create-modal").classList.add("hidden");
  pendingCreatePayload = pendingDupRef = pendingDupData = null;
  await loadCustomers();
}

// ===== 입력 보조: 자동 포맷 =====
// (1) 공통 유틸
function _pad2(s) {
  s = String(s || "");
  return s.length === 1 ? "0" + s : s.slice(0, 2);
}
function _clampMD(y, m, d) {
  const mm = parseInt(m, 10),
    dd = parseInt(d, 10);
  if (!(mm >= 1 && mm <= 12) || !(dd >= 1 && dd <= 31)) return null;
  return { y, m: _pad2(m), d: _pad2(d) };
}
// (2) 엑셀 업로드 전용: 주민번호에서 생년/성별 추출 (기존 동작 유지)
function extractBirthGenderFromRRN(rrn) {
  const m = String(rrn || "")
    .replace(/[^\d]/g, "")
    .match(/^(\d{2})(\d{2})(\d{2})(\d)/);
  if (!m) return null;
  const [, yy, mm, dd, gStr] = m;
  const g = Number(gStr);
  const cent = g === 1 || g === 2 ? "19" : g === 3 || g === 4 ? "20" : null;
  if (!cent) return null;
  const chk = _clampMD(cent + yy, mm, dd);
  if (!chk) return null;
  const gender = g === 1 || g === 3 ? "남" : "여";
  return { birth: `${chk.y}.${chk.m}.${chk.d}`, gender };
}

// (3) 수기 입력 전용: 엄격 모드(YYYYMMDD만 허용)
function birthDigits(s) {
  return String(s || "")
    .replace(/\D/g, "")
    .slice(0, 8);
}
// 입력 중: 자리수에 맞춰 점(.)만 삽입 (추정/보정 없음)
function formatBirthStrictInput(input) {
  const d = birthDigits(input);
  if (d.length <= 4) return d; // YYYY
  if (d.length <= 6) return `${d.slice(0, 4)}.${d.slice(4)}`; // YYYY.MM(또는 YYYY.M)
  return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}`; // YYYY.MM.D[ 또는 DD]
}
// 유효성: 정확히 8자리 + 실제 달력 날짜
function validateBirthStrict(input) {
  const d = birthDigits(input);
  if (d.length !== 8) return false;
  const y = +d.slice(0, 4),
    m = +d.slice(4, 6),
    day = +d.slice(6, 8);
  if (m < 1 || m > 12) return false;
  const maxDay = new Date(y, m, 0).getDate(); // 해당 월 마지막 날
  return day >= 1 && day <= maxDay;
}
// 확정 시: 보기 좋은 YYYY.MM.DD
function finalizeBirthStrict(input) {
  const d = birthDigits(input);
  if (d.length !== 8) return input;
  return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}`;
}

function formatMultiPhones(text, strict = false) {
  // 쉼표/슬래시/공백으로 분리된 여러 번호를 각각 포맷
  const tokens = String(text || "")
    .split(/[,\s/]+/)
    .filter(Boolean);
  if (!tokens.length) return "";
  return tokens.map((t) => formatPhoneDigits(t.replace(/\D/g, ""))).join(", ");
}
function formatPhoneDigits(d) {
  // 진행형 하이픈: 02 지역번호 케이스와 일반(휴대/지역 3자리) 케이스
  if (!d) return "";
  if (d.startsWith("02")) {
    if (d.length <= 2) return d;
    if (d.length <= 6) return `02-${d.slice(2)}`;
    // 02-XXXX-YYYY (마지막 4자리 고정, 진행형)
    const last = d.length >= 6 ? d.slice(-4) : "";
    const mid = d.slice(2, d.length - last.length);
    return last ? `02-${mid}-${last}` : `02-${mid}`;
  }
  // 일반 번호
  if (d.length <= 3) return d;
  if (d.length <= 7) return `${d.slice(0, 3)}-${d.slice(3)}`; // 1234 -> 123-4
  if (d.length <= 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`; // 12345678 -> 123-456-78
  return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7, 11)}`; // 11자리 → 3-4-4
}

// ── 전화번호 리스트 UI ──
function initPhoneList(wrapSel, addBtnSel, initial = []) {
  const wrap = document.querySelector(wrapSel);
  const addBtn = document.querySelector(addBtnSel);
  if (!wrap) return;
  wrap.innerHTML = "";

  const addRow = (val = "") => {
    // 1. 겉을 감싸는 div 생성 (기존 phone-row 대신 field-box 스타일 적용을 위한 래퍼)
    // 모달 디자인 통일성을 위해 margin-bottom(mb-2) 추가
    const row = document.createElement("div");
    row.className = "phone-row relative mb-2";

    // 2. 내부 HTML 구조 변경: .field-box > .field-input
    row.innerHTML = `
      <div class="field-box"> <input 
          type="text" 
          class="field-input phone-item" 
          placeholder="예) 01012345678" 
          value="${
            val ? formatPhoneDigits(String(val).replace(/\D/g, "")) : ""
          }"
        >
      </div>
    `;

    wrap.appendChild(row);

    // 입력 포맷팅 이벤트 연결
    const input = row.querySelector("input");
    input.addEventListener(
      "input",
      () => (input.value = formatPhoneDigits(input.value.replace(/\D/g, "")))
    );
    input.addEventListener(
      "blur",
      () => (input.value = formatPhoneDigits(input.value.replace(/\D/g, "")))
    );
  };

  if (initial.length) {
    initial.forEach((v) => addRow(v));
  } else {
    addRow(); // 기본 한 줄 생성
  }

  // 추가 버튼 이벤트 연결
  if (addBtn) {
    const newBtn = addBtn.cloneNode(true);
    addBtn.parentNode.replaceChild(newBtn, addBtn);
    newBtn.addEventListener("click", () => addRow());
  }
}

function getPhonesFromList(wrapSel) {
  return [...document.querySelectorAll(`${wrapSel} .phone-item`)]
    .map((i) => i.value.trim())
    .filter(Boolean);
}

function splitPhonesToArray(s) {
  if (!s) return [];
  return String(s)
    .split(/[,\s/]+/)
    .map((x) => x.replace(/\D/g, ""))
    .filter(Boolean);
}

// ── 상태 일괄 변경(배치, 500 제한 고려) ───────────────────────────────
async function batchUpdateStatus(ids = [], nextStatus = "중단", email = "") {
  if (!ids.length) return;
  const CHUNK = 450; // 안전 여유
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const batch = writeBatch(db);
    slice.forEach((id) => {
      const ref = doc(db, "customers", id);
      batch.update(ref, {
        status: nextStatus,
        updatedAt: new Date().toISOString(),
        updatedBy: email || auth.currentUser?.email || "unknown",
      });
    });
    await batch.commit();
  }
}

// ==========================================
// ✨ 커스텀 자동완성 (이용자 구분/분류)
// ==========================================

const TYPE_OPTIONS = [
  "긴급지원대상자",
  "기초생활보장수급자",
  "차상위계층",
  "저소득층",
  "기초생활보장수급탈락자",
];
const CATEGORY_OPTIONS = [
  "결식아동",
  "다문화가정",
  "독거어르신",
  "소년소녀가장",
  "외국인노동자",
  "재가장애인",
  "저소득가정",
  "조손가정",
  "한부모가정",
  "기타",
  "청장년1인가구",
  "미혼모부가구",
  "부부중심가구",
  "노인부부가구",
  "새터민가구",
  "공통체가구",
];

function setupAutocomplete(inputId, listId, options) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  if (!input || !list) return;

  // [유지] 목록을 body로 이동 (모달 밖으로 탈출)
  document.body.appendChild(list);
  list.style.position = "fixed";
  list.style.zIndex = "9999";
  list.style.width = "";

  const updatePosition = () => {
    const rect = input.getBoundingClientRect();
    list.style.top = `${rect.bottom + 4}px`;
    list.style.left = `${rect.left}px`;
    list.style.width = `${rect.width}px`;
  };

  const renderList = (filterText = "") => {
    // 빈 값일 때 전체 목록 보여주기 (선택 사항 - 필요 없으면 아래 조건문 사용)
    // const filtered = filterText ? options.filter(opt => opt.includes(filterText)) : options;

    // 현재: 검색어 포함 필터링
    const filtered = options.filter((opt) => opt.includes(filterText));

    if (filtered.length === 0) {
      list.classList.add("hidden");
      return;
    }

    list.innerHTML = "";
    filtered.forEach((opt) => {
      const div = document.createElement("div");
      // 스타일은 tw-input.css 따름
      div.className =
        "px-4 py-3 text-sm text-slate-700 dark:text-slate-200 cursor-pointer hover:bg-blue-50 dark:hover:bg-slate-700 transition-colors";
      div.textContent = opt;

      div.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = opt;
        list.classList.add("hidden");
      });

      list.appendChild(div);
    });

    updatePosition();
    list.classList.remove("hidden");
  };

  // 이벤트 리스너
  input.addEventListener("focus", () => {
    updatePosition();
    renderList(input.value);
  });
  input.addEventListener("input", () => {
    updatePosition();
    renderList(input.value);
  });

  // [수정] 스크롤 이벤트 개선
  // "목록 자체"를 스크롤할 때는 닫지 않고, "화면/모달"을 스크롤할 때만 닫음
  window.addEventListener(
    "scroll",
    (e) => {
      // 스크롤된 요소(e.target)가 리스트 자신이거나 리스트 안에 있는 요소면 무시
      if (e.target === list || list.contains(e.target)) {
        return;
      }
      // 그 외(배경, 모달 등) 스크롤이면 리스트 닫기 (위치 틀어짐 방지)
      list.classList.add("hidden");
    },
    true
  ); // true: 캡처링 모드 사용

  window.addEventListener("resize", () => list.classList.add("hidden"));

  // 포커스 잃으면 숨김
  input.addEventListener("blur", () => {
    setTimeout(() => list.classList.add("hidden"), 150);
  });
}

// [추가] 입력 시작 시 에러 상태 해제 리스너
const gSearchInput = document.getElementById("global-search");
if (gSearchInput) {
  gSearchInput.addEventListener("input", () => {
    toggleSearchError("global-search-group", false);
  });
}

const fSearchInput = document.getElementById("field-search");
if (fSearchInput) {
  fSearchInput.addEventListener("input", () => {
    toggleSearchError("field-search-group", false);
  });
}

// 초기화 실행 (DOM 로드 후)
document.addEventListener("DOMContentLoaded", () => {
  setupAutocomplete("create-type", "create-type-list", TYPE_OPTIONS);
  setupAutocomplete(
    "create-category",
    "create-category-list",
    CATEGORY_OPTIONS
  );

  setupAutocomplete("edit-type", "edit-type-list", TYPE_OPTIONS);
  setupAutocomplete("edit-category", "edit-category-list", CATEGORY_OPTIONS);
});

/* =========================================================
   [비상용] 일괄 복구 함수
   만약 엑셀 복구가 실패하면, 이 코드를 customers.js 맨 아래에 붙여넣으세요.
   그리고 크롬 콘솔창(F12)에 window.emergencyRestore() 를 입력하고 엔터치세요.
   ========================================================= */
window.emergencyRestore = async function () {
  // 1. 관리자 확인
  if (
    !confirm(
      "비상 복구를 시작하시겠습니까? 모든 '중단' 인원이 '지원'으로 변경됩니다."
    )
  )
    return;

  console.log("🚀 비상 복구 시작...");

  try {
    // 2. '중단' 상태인 모든 문서 찾기
    const q = query(collection(db, "customers"), where("status", "==", "중단"));
    const snapshot = await getDocs(q);
    const targetIds = snapshot.docs.map((d) => d.id);

    if (targetIds.length === 0) {
      console.log(
        "✅ '중단' 상태인 이용자가 없습니다. 복구할 필요가 없습니다."
      );
      alert("복구할 대상이 없습니다.");
      return;
    }

    console.log(
      `총 ${targetIds.length}명의 '중단' 인원을 발견했습니다. 복구를 진행합니다...`
    );

    // 3. 기존에 만들어둔 batchUpdateStatus 함수 재활용 (500개씩 끊어서 처리)
    // (email 인자는 'emergency-restore'로 남김)
    await batchUpdateStatus(targetIds, "지원", "emergency-restore");

    console.log("🎉 모든 복구가 완료되었습니다!");
    alert(`복구 완료! ${targetIds.length}명이 '지원' 상태로 변경되었습니다.`);

    // 4. 화면 새로고침
    window.location.reload();
  } catch (e) {
    console.error("❌ 복구 중 오류 발생:", e);
    alert("복구 실패. 콘솔을 확인하세요.");
  }
};
