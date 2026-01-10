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
} from "./components/comp.js";

// 🔍 검색용 메모리 저장
let customerData = [];
let pagesKnown = 1; // 렌더 직전 순간값으로 재계산해서 넣어줌

let displaydData = [];
let currentSort = { field: null, direction: "asc" };

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

async function fetchAndRenderPage() {
  if (!buildCurrentQuery) return;
  const base = collection(db, "customers");
  const cons = buildCurrentQuery(); // orderBy()/where()/limit(N+1)/startAfter() 포함
  // 표 영역에 국소 스켈레톤 표시
  let __cleanupSkel;
  try {
    __cleanupSkel = makeSectionSkeleton(
      document.getElementById("customer-table") ||
        document.querySelector("#customer-table"),
      10
    );
    const snap = await getDocs(query(base, ...cons));
    __hasNextPage = snap.size > pageSize;
    const docsForRender = __hasNextPage
      ? snap.docs.slice(0, pageSize)
      : snap.docs;
    lastPageCount = docsForRender.length;
    // 현재 페이지 커서 스냅샷(이전/다음 전용)
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
    // 다음 페이지를 위한 커서(현재 페이지의 lastDoc)를 기록
    pageCursors[currentPageIndex + 1] =
      docsForRender[docsForRender.length - 1] || null;
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
function resetCreateForm() {
  const set = (id, v = "") => {
    const el = document.getElementById(id);
    if (el) el.value = v;
  };
  set("create-name");
  set("create-birth");
  set("create-gender", "");
  set("create-status", "지원");
  set("create-region1");
  set("create-address");
  set("create-type");
  set("create-category");
  set("create-note");
  // 전화번호 입력 줄 초기화(빈 한 줄)
  try {
    initPhoneList("#create-phone-wrap", "#create-phone-add", []);
  } catch {}
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
  let __cleanupSkel;
  try {
    __cleanupSkel = makeSectionSkeleton(
      document.getElementById("customer-table") ||
        document.querySelector("#customer-table"),
      8
    );
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
  let __cleanupSkel;
  try {
    __cleanupSkel = makeSectionSkeleton(
      document.getElementById("customer-table") ||
        document.querySelector("#customer-table"),
      8
    );
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
  // 툴바
  document
    .getElementById("btn-customer-create")
    .addEventListener("click", () => {
      resetCreateForm();
      openCreateModal();
    });
  document
    .getElementById("btn-export-xlsx")
    .addEventListener("click", exportXlsx);
  // 모달 열고/닫기
  const modal = document.getElementById("customer-create-modal");
  const closeAll = () => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    resetCreateForm();
  };
  document
    .querySelectorAll("#create-modal-close")
    .forEach((el) => el.addEventListener("click", closeAll));
  // 탭 스위치
  modal.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      modal
        .querySelectorAll(".tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      modal
        .querySelectorAll(".tab-panel")
        .forEach((p) => p.classList.add("hidden"));
      modal.querySelector("#tab-" + tab.dataset.tab).classList.remove("hidden");
    });
  });
  // 직접 저장
  document
    .getElementById("create-modal-save")
    .addEventListener("click", saveCreateDirect);
  // 업로드 탭
  bindUploadTab();

  // 입력 중 자동 포맷팅(직접 입력 탭) — 엄격모드(YYYYMMDD만 허용)
  const birth = document.getElementById("create-birth");
  if (birth && !birth.dataset.strictBound) {
    birth.addEventListener("input", () => {
      birth.value = formatBirthStrictInput(birth.value); // 진행형: 점만 삽입
      birth.setCustomValidity("");
    });
    birth.addEventListener("blur", () => {
      // 확정: 8자리 유효성 검사
      if (!validateBirthStrict(birth.value)) {
        birth.setCustomValidity(
          "생년월일은 YYYYMMDD 형식(예: 19990203)으로 입력하세요."
        );
        birth.reportValidity();
      } else {
        birth.value = finalizeBirthStrict(birth.value); // YYYY.MM.DD로 보기 좋게
        birth.setCustomValidity("");
      }
    });
    birth.dataset.strictBound = "1";
  }

  // 전화번호 다중 입력 초기화
  initPhoneList("#create-phone-wrap", "#create-phone-add");

  // 동명이인 모달 버튼
  document.getElementById("dup-update")?.addEventListener("click", onDupUpdate);
  document.getElementById("dup-new")?.addEventListener("click", onDupNew);
  document.querySelectorAll("#dup-modal [data-close]")?.forEach((b) =>
    b.addEventListener("click", () => {
      document.getElementById("dup-modal").classList.add("hidden");
    })
  );

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
  // 기본 목록: nameLower ASC, 서버 페이지네이션
  resetPager("list:nameLower:asc", () => [
    ...roleConstraint(),
    orderBy("nameLower"),
    orderBy(documentId()),
  ]);
  updateSortIcons();
  try {
    await syncSupportCache();
  } catch {}
}

function renderTable(data) {
  const tbody = document.querySelector("#customer-table tbody");
  tbody.innerHTML = "";
  customerData = data; // 현재 데이터 보관

  // 정렬 로직 (기존 유지)
  let sorted = [...data];
  if (currentSort.field) {
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

  // [수정] 빈 상태(Empty State) 여백 확대 (py-16 -> py-32)
  if (sorted.length === 0) {
    tbody.innerHTML = `
      <tr class="customer-empty-state">
        <td colspan="12" class="py-12 text-center select-none pointer-events-none">
          <div class="flex flex-col items-center gap-3 text-slate-300 dark:text-slate-600">
            <div class="w-16 h-16 rounded-full bg-slate-50 dark:bg-slate-700/50 flex items-center justify-center mb-1">
              <i class="fas fa-users-slash text-3xl text-slate-200 dark:text-slate-600"></i>
            </div>
            <p class="text-slate-400 dark:text-slate-500 font-medium text-base">
              조건에 맞는 이용자가 없습니다.
            </p>
          </div>
        </td>
      </tr>`;
    updatePagerUI();
    return;
  }

  sorted.forEach((c) => {
    const tr = document.createElement("tr");

    // [수정] 줄바꿈 방지: whitespace-nowrap 추가
    tr.className =
      "border-b border-slate-50 dark:border-slate-700/50 hover:bg-slate-50/80 dark:hover:bg-slate-700/30 transition-colors group whitespace-nowrap";

    // 상태 배지 스타일 (기존 유지)
    let statusClass =
      "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300";

    if (c.status === "지원")
      statusClass =
        "bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-500/30";
    else if (c.status === "중단" || c.status === "제외")
      statusClass =
        "bg-rose-100 text-rose-700 border border-rose-200 dark:bg-rose-900/30 dark:text-rose-400 dark:border-rose-500/30";
    else if (c.status === "사망")
      statusClass =
        "bg-gray-100 text-gray-500 border border-gray-200 line-through dark:bg-slate-700 dark:text-slate-500 dark:border-slate-600";

    tr.innerHTML = `
      <td class="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">${
        c.name || ""
      }</td>
      <td class="px-4 py-3 text-slate-600 dark:text-slate-400">${
        c.birth || ""
      }</td>
      <td class="px-4 py-3 sm:table-cell text-slate-600 dark:text-slate-400">${
        c.gender || ""
      }</td>
      
      <td class="px-4 py-3 hidden [.is-admin_&]:sm:table-cell">
        <span class="px-2.5 py-0.5 rounded-md font-bold text-xs ${statusClass}">${
      c.status || ""
    }</span>
      </td>
      
      <td class="px-4 py-3 text-slate-600 dark:text-slate-400">${
        c.region1 || ""
      }</td>
      <td class="px-4 py-3 text-left md:table-cell text-slate-600 dark:text-slate-400" title="${
        c.address || ""
      }">${c.address || ""}</td>
      <td class="px-4 py-3 md:table-cell text-slate-600 dark:text-slate-400 tracking-tight">${
        c.phone || ""
      }</td>
      
      <td class="px-4 py-3 hidden [.is-admin_&]:md:table-cell text-slate-600 dark:text-slate-400">${
        c.type || ""
      }</td>
      <td class="px-4 py-3 hidden [.is-admin_&]:md:table-cell text-slate-600 dark:text-slate-400">${
        c.category || ""
      }</td>
      
      <td class="px-4 py-3 lg:table-cell text-slate-500 dark:text-slate-500 text-xs">${
        c.lastVisit || "-"
      }</td>
      <td class="px-4 py-3 text-left lg:table-cell text-slate-500 dark:text-slate-500 text-xs" title="${
        c.note || ""
      }">${c.note || ""}</td>
      
      <td class="px-4 py-3 text-center">
        <div class="flex justify-center gap-2 opacity-60 group-hover:opacity-100 transition-opacity">
          <button class="btn btn-primary-weak h-8 w-8 rounded-lg flex items-center justify-center p-0" title="수정" data-edit="${
            c.id
          }">
            <i class="fas fa-edit"></i>
          </button>
          <button class="btn btn-danger-weak h-8 w-8 rounded-lg flex items-center justify-center p-0 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30" title="삭제" data-del="${
            c.id
          }">
            <i class="fas fa-trash-alt"></i>
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
    th.addEventListener("click", () => {
      if (currentSort.field === field) {
        currentSort.direction =
          currentSort.direction === "asc" ? "desc" : "asc";
      } else {
        currentSort.field = field;
        currentSort.direction = "asc";
      }
      renderTable(displaydData);
      updateSortIcons();
    });
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
document.getElementById("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("edit-id").value;
  const email = auth.currentUser?.email || "unknown";

  const ref = doc(db, "customers", id);
  const phoneVals = getPhonesFromList("#edit-phone-wrap");
  const picked = parsePhonesPrimarySecondary(...phoneVals);
  const region1Val = (
    document.getElementById("edit-region1")?.value || ""
  ).trim();
  // 생년월일 엄격 검증(YYYYMMDD)
  const editBirthRaw = document.getElementById("edit-birth").value;
  if (!validateBirthStrict(editBirthRaw)) {
    showToast("생년월일은 YYYYMMDD 형식(예: 19990203)으로 입력하세요.", true);
    return;
  }
  const editBirth = finalizeBirthStrict(editBirthRaw);
  const updateData = {
    name: document.getElementById("edit-name").value,
    birth: editBirth,
    gender: document.getElementById("edit-gender").value || "",
    status: document.getElementById("edit-status").value || "",
    region1: region1Val,
    regionLower: region1Val ? region1Val.toLowerCase() : "",
    address: document.getElementById("edit-address").value,
    phone: picked.display,
    phonePrimary: picked.prim || "",
    phoneSecondary: picked.sec || "",
    type: document.getElementById("edit-type").value,
    category: document.getElementById("edit-category").value,
    note: document.getElementById("edit-note").value,
    updatedAt: new Date().toISOString(),
    updatedBy: email,
    // 🔎 인덱스 필드
    nameLower: normalize(document.getElementById("edit-name").value),
    regionLower: normalize(document.getElementById("edit-region1").value),
    ...buildPhoneIndexFields(picked.display),
  };

  if (isAdmin) {
    await updateDoc(ref, updateData);
    showToast("수정되었습니다");
    try {
      if (updateData.status === "지원")
        await idbPutAll([toCacheShape({ id, ...updateData })]);
    } catch {}

    await logEvent("customer_update", { targetId: id, changes: updateData });
  } else {
    // 변경분만 추출하여 승인요청
    const before = editingOriginal || {};
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
      if ((updateData[k] ?? "") !== (before[k] ?? ""))
        changes[k] = updateData[k] ?? "";
    });
    if (Object.keys(changes).length === 0) {
      showToast("변경된 내용이 없습니다");
      return;
    }
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
      targetId: id,
      changes,
      requestedBy: auth.currentUser?.email || "",
      requestedAt: Timestamp.now(),
      approved: false,
    });
    showToast("승인 요청이 전송되었습니다");
    await logEvent("approval_request", {
      approvalType: "customer_update",
      targetId: id,
      changes,
    });
  }
  document.getElementById("edit-modal").classList.add("hidden");
  await refreshAfterMutation();
});

document.getElementById("close-edit-modal")?.addEventListener("click", () => {
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
let __searchTimer = null;
async function runServerSearch() {
  const gInput = document.getElementById("global-search");
  const fSelect = document.getElementById("field-select");
  const fInput = document.getElementById("field-search");
  const exact = document.getElementById("exact-match")?.checked;
  const globalKeyword = normalize(gInput?.value || "");
  const field = fSelect?.value || "";
  const fieldRaw = (fInput?.value || "").trim();
  const fieldValue = normalize(fieldRaw);

  // 검색 조건이 없으면 서버 페이지 목록 초기화
  if (!globalKeyword && (!field || !fieldValue)) {
    resetPager("list:nameLower:asc", () => [
      ...roleConstraint(),
      orderBy("nameLower"),
      orderBy(documentId()),
    ]);
    return;
  }

  const base = collection(db, "customers");
  const cons = [];
  if (!isAdmin) cons.push(where("status", "==", "지원"));

  // 1) 글로벌 키워드(로컬 캐시에서 통합검색) 우선
  if (globalKeyword) {
    const localRows = await localUnifiedSearch(globalKeyword);
    displaydData = localRows;
    renderTable(localRows);
    // 로컬 검색이므로 서버 페이지네이션 비활성화 및 페이저 초기화
    buildCurrentQuery = null;
    currentPageIndex = 0;
    lastPageCount = 0;
    pagesKnown = 1;
    updatePagerUI();
    // 관리자일 때 0건이면 고급 검색 유도 배너 노출
    const hint = document.getElementById("search-hint");
    if (hint) {
      if (isAdmin && localRows.length === 0) {
        hint.classList.remove("hidden");
        const raw = (
          document.getElementById("global-search").value || ""
        ).trim();
        hint.innerHTML =
          `캐싱된 데이터에서 검색 결과가 없습니다. ` +
          ` <span class="underline cursor-pointer" id="open-adv">고급 검색을 통해 검색하기</span>`;
        hint.querySelector("#open-adv")?.addEventListener("click", () => {
          const adv = document.getElementById("advanced-search");
          adv.classList.remove("hidden");
          const btn = document.getElementById("toggle-advanced-search");
          if (btn) btn.textContent = "고급 검색 닫기";
          // 휴리스틱: 숫자→전화 / '동|구' 포함→행정구역 / 기타→이름
          const digits = raw.replace(/\D/g, "");
          const sel = document.getElementById("field-select");
          const inp = document.getElementById("field-search");
          if (digits.length >= 3) {
            sel.value = "phone";
            inp.value = raw;
          } else if (/[동구읍면]$/.test(raw)) {
            sel.value = "region1";
            inp.value = raw;
          } else {
            sel.value = "name";
            inp.value = raw;
          }
        });
      } else {
        hint.classList.add("hidden");
        hint.innerHTML = "";
      }
    }
    return; // 로컬로 처리했으니 서버 질의 종료
  } else if (field && fieldValue) {
    // 2) 필드 검색 → 서버 페이지네이션으로 전환
    const identityParts = [];
    if (!isAdmin) identityParts.push("role:user");
    identityParts.push(`field:${field}`, `value:${fieldValue}`);
    const identity = identityParts.join("|");
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
          // 비고는 부분검색 인덱스가 없으니 '정확히 일치'로 서버 질의
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
          // 서버 인덱스가 없는 필드는 로컬 필터(최소화)
          buildCurrentQuery = null;
          renderTable(
            customerData.filter((c) =>
              normalize(c[field] || "").includes(fieldValue)
            )
          );
          // 로컬 결과이므로 페이저를 초기화
          currentPageIndex = 0;
          lastPageCount = 0;
          __hasNextPage = false;
          pagesKnown = 1;
          updatePagerUI();
          return [];
      }
      return cons2;
    });
  }
  // 필드 검색은 서버 질의이므로 배너 숨김
  const hint = document.getElementById("search-hint");
  if (hint) {
    hint.classList.add("hidden");
    hint.innerHTML = "";
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
      ? "고급 검색 열기"
      : "고급 검색 닫기";
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
  let dryRows = null;
  let lastOptions = null;
  let lastDeactivateTargets = [];

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
    dryRows = await parseAndNormalizeExcel(f, lastOptions);
    const total = dryRows.length;
    const keys = new Set(dryRows.map((r) => slugId(r.name, r.birth)));
    // 기존 문서 조회: 권한에 맞춰 범위를 제한(비관리자는 '지원'만 읽기 가능)
    const base = collection(db, "customers");
    const q = isAdmin
      ? query(base)
      : query(base, where("status", "==", "지원"));
    const all = (await getDocs(q)).docs.map((d) => d.id);
    let dup = 0;
    keys.forEach((k) => {
      if (all.includes(k)) dup++;
    });
    const newCnt = total - dup;
    // ‘업로드 제외 기존 지원 → 중단’ 대상 계산(해당 모드일 때만)
    lastDeactivateTargets = [];
    if (lastOptions.statusMode === "all-support-stop-others") {
      const supportIds = (
        await getDocs(query(base, where("status", "==", "지원")))
      ).docs.map((d) => d.id);
      lastDeactivateTargets = supportIds.filter((id) => !keys.has(id));
    }
    const stopCnt = lastDeactivateTargets.length;
    preview.textContent =
      `총 ${total}건 · 신규 ${newCnt}건 · 중복 ${dup}건` +
      (lastOptions.statusMode === "all-support-stop-others"
        ? ` · ‘중단’ 대상 ${stopCnt}건`
        : "");
    execBtn.disabled = false;
  });

  execBtn.addEventListener("click", async () => {
    if (!dryRows) return;
    if (isAdmin) {
      // 관리자: 즉시 반영
      const email = auth.currentUser?.email || "unknown";
      for (const r of dryRows) {
        const id = slugId(r.name, r.birth);
        await setDoc(
          doc(collection(db, "customers"), id),
          { ...r, updatedAt: new Date().toISOString(), updatedBy: email },
          { merge: true }
        );
      }
      // 옵션: 업로드에 포함되지 않은 기존 ‘지원’을 일괄 ‘중단’으로 변경
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
      await loadCustomers();
    } else {
      // 비관리자: 승인요청으로 전환
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
      await setDoc(doc(collection(db, "approvals")), {
        type: "customer_bulk_upload",
        payload: {
          rows: dryRows,
          options: lastOptions,
          // 관리자가 승인 처리 시 사용할 ‘중단’ 대상
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
        deactivateOthers: lastOptions?.statusMode === "all-support-stop-others",
        deactivateCount: lastDeactivateTargets?.length || 0,
      });
      // 비관리자는 실제 반영이 아니므로 목록 재조회만(또는 그대로 유지)
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

// ===== 내보내기 =====
async function exportXlsx() {
  const btn = document.getElementById("btn-export-xlsx");
  setBusy(btn, true);

  const rows = displaydData.map((c) => ({
    이용자명: c.name || "",
    생년월일: c.birth || "",
    성별: c.gender || "",
    상태: c.status || "",
    행정구역: c.region1 || "",
    주소: c.address || "",
    전화번호: c.phone || "",
    이용자구분: c.type || "",
    이용자분류: c.category || "",
    비고: c.note || "",
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "customers");
  XLSX.writeFile(wb, `customers_${dateStamp()}.xlsx`);
  setBusy(btn, false);
}
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
    const row = document.createElement("div");
    // [수정] 레이아웃 클래스
    row.className = "phone-row relative";

    // [수정] 다크 모드 입력창 스타일 주입
    // (html 파일의 정적 input들과 동일한 클래스 적용)
    const inputClass = "phone-item input";

    row.innerHTML = `<input type="text" class="${inputClass}" placeholder="예) 01012345678" value="${
      val ? formatPhoneDigits(String(val).replace(/\D/g, "")) : ""
    }">`;

    wrap.appendChild(row);
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
    addRow();
  }

  // 기존 리스너 중복 방지 (replaceWith cloneNode 기법 대신 간단히 처리)
  if (addBtn) {
    // 기존 리스너 제거가 어려우므로, 새로 고침 로직상 이 함수가 자주 호출된다면
    // addBtn.onclick = ... 방식을 쓰거나, 외부에서 호출 제어가 필요함.
    // 현재 구조에서는 DOMContentLoaded에서 한 번 호출되므로 addEventListener도 무방.
    // 안전을 위해 cloneNode로 리스너 초기화 후 재할당
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
