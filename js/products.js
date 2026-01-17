import { db } from "./components/firebase-config.js";
import {
  collection,
  getDocs,
  getDoc,
  addDoc,
  setDoc,
  deleteDoc,
  updateDoc,
  doc,
  serverTimestamp,
  writeBatch,
  arrayUnion,
  query,
  orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  showToast,
  renderCursorPager,
  initPageSizeSelect,
  openConfirm,
  withLoading,
  makeGridSkeleton,
  setBusy,
} from "./components/comp.js";

const productsCol = collection(db, "products");
const POLICY_DOC = doc(db, "stats", "categoryPolicies");

// ===== 상태 관리 (Client-Side Paging & Search) =====
let allProducts = []; // 전체 상품 데이터 (메모리 캐시)
let filteredProducts = []; // 검색/필터 적용된 데이터
let currentPage = 1;
let pageSize = 20;
let totalPages = 1;

let editingProductId = null; // 수정할 상품 ID
let editInitial = null;

// 엑셀 관련 상태
let parsedRows = [];
let parsedIssues = [];

const productList = document.getElementById("product-list");
const pagination = document.getElementById("pagination");

/* ---------------------------
  카테고리 & 정책 캐시
---------------------------- */
const CAT_DOC = doc(db, "meta", "categories_products");
const CAT_CACHE_KEY = "catIndex:products:v1";
let categoriesCache = [];
let policiesCache = {};
let policyDirty = false;

function normalizeCategory(c) {
  return String(c || "")
    .trim()
    .replace(/\s+/g, " ");
}

/* ---------------------------
  1. 전체 데이터 로드 (최초 1회)
---------------------------- */
async function loadAllProducts() {
  const cleanup = makeGridSkeleton(productList, 12);

  try {
    // 쿼리: 전체 로드 (정렬은 클라이언트에서)
    const q = query(productsCol); // orderBy 없이 전체 가져옴
    const snap = await getDocs(q);

    allProducts = snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        ...data,
        // 검색 성능을 위해 소문자/공백제거 필드 미리 생성
        _searchName: (data.name || "").toLowerCase().replace(/\s+/g, ""),
        _searchBarcode: (data.barcode || "").trim(),
        // 정렬용 timestamp 처리
        _createdAt: data.createdAt?.seconds || 0,
      };
    });

    console.log(`📦 전체 상품 로드 완료: ${allProducts.length}건`);

    // 초기 필터링 및 렌더링
    applyFilters();
  } catch (e) {
    console.error("데이터 로드 실패:", e);
    showToast("데이터를 불러오지 못했습니다.", true);
  } finally {
    cleanup();
  }
}

/* ---------------------------
  2. 필터링 & 정렬 (Core Logic)
---------------------------- */
function applyFilters() {
  const nameQuery = (document.getElementById("product-name")?.value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "");
  const barcodeQuery = (
    document.getElementById("product-barcode")?.value || ""
  ).trim();
  const categoryQuery = (
    document.getElementById("filter-category")?.value || ""
  ).trim();
  const sortBy = document.getElementById("sort-select")?.value || "date";

  // 1. 필터링 (AND 조건)
  filteredProducts = allProducts.filter((p) => {
    // 바코드 검색 (일치)
    if (barcodeQuery && !p._searchBarcode.includes(barcodeQuery)) return false;
    // 상품명 검색 (단순 포함 - includes 방식) -> "간장" 검색 시 "조림간장" 노출됨
    if (nameQuery && !p._searchName.includes(nameQuery)) return false;
    // 카테고리 검색 (일치)
    if (categoryQuery && p.category !== categoryQuery) return false;
    return true;
  });

  // 2. 정렬
  filteredProducts.sort((a, b) => {
    switch (sortBy) {
      case "price": // 가격 오름차순
        return (a.price || 0) - (b.price || 0);
      case "name": // 이름 오름차순
        return (a.name || "").localeCompare(b.name || "");
      case "barcode": // 바코드 오름차순
        return (a.barcode || "").localeCompare(b.barcode || "");
      case "date": // 등록일 내림차순 (기본)
      default:
        return b._createdAt - a._createdAt;
    }
  });

  // 3. 페이지네이션 리셋 및 렌더링
  currentPage = 1;
  renderPage();
}

/* ---------------------------
  3. 페이지 렌더링
---------------------------- */
function renderPage() {
  const total = filteredProducts.length;
  totalPages = Math.max(1, Math.ceil(total / pageSize));

  // 현재 페이지 범위 계산
  const start = (currentPage - 1) * pageSize;
  const end = start + pageSize;
  const pageItems = filteredProducts.slice(start, end);

  // 리스트 그리기
  renderList(pageItems);

  // 페이지네이션 그리기
  renderPagination();
}

function formatDate(ts) {
  if (!ts) return "-";
  // Firestore Timestamp or Date object
  const date = ts.toDate ? ts.toDate() : new Date(ts.seconds * 1000 || ts);
  if (isNaN(date.getTime())) return "-";
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function renderList(rows) {
  if (rows.length === 0) {
    productList.innerHTML = `
      <div class="col-span-full py-24 flex flex-col items-center justify-center text-center select-none">
        <div class="w-20 h-20 bg-slate-50 dark:bg-slate-800 rounded-full flex items-center justify-center mb-4">
          <i class="fas fa-box-open text-3xl text-slate-300 dark:text-slate-600"></i>
        </div>
        <p class="text-slate-500 dark:text-slate-400 font-bold text-lg">조건에 맞는 상품이 없습니다.</p>
        <p class="text-slate-400 dark:text-slate-500 text-sm mt-1">검색어를 변경하거나 새로운 상품을 등록해보세요.</p>
      </div>
    `;
    return;
  }

  productList.innerHTML = rows
    .map(
      (p) => `
      <div class="card flex flex-col gap-4 group relative overflow-hidden" data-id="${p.id}">
        
        <div class="flex justify-between items-start gap-2">
          <div class="font-bold text-lg text-slate-800 dark:text-white leading-snug break-words line-clamp-2">
            ${escapeHtml(p.name || "")}
          </div>
          <span class="badge badge-sm badge-weak-grey shrink-0">
            ${escapeHtml(p.category || "미분류")}
          </span>
        </div>
        
        <div class="space-y-1.5">
          <div class="flex items-center gap-2">
            <div class="w-5 flex justify-center text-slate-400"><i class="fas fa-won-sign text-sm"></i></div>
            <span class="font-bold text-blue-600 dark:text-blue-400 text-lg">
              ${Number(p.price || 0).toLocaleString()}
            </span>
          </div>
          <div class="flex items-center gap-2">
            <div class="w-5 flex justify-center text-slate-400"><i class="fas fa-barcode text-sm"></i></div>
            <span class="font-mono text-sm text-slate-500 dark:text-slate-400 tracking-wide">
              ${escapeHtml(p.barcode || "")}
            </span>
          </div>
        </div>

        <div class="mt-auto pt-4 border-t border-slate-50 dark:border-slate-700/50 relative min-h-[48px]">
          
          <div class="absolute inset-x-0 bottom-0 top-4 flex items-center justify-between text-xs text-slate-400 transition-opacity duration-200 group-hover:opacity-0 pointer-events-none">
            <span><i class="far fa-clock mr-1"></i> 등록: ${formatDate(p.createdAt)}</span>
          </div>

          <div class="absolute inset-x-0 bottom-0 top-4 flex gap-2 opacity-0 group-hover:opacity-100 transition-all duration-200 z-10 bg-white dark:bg-slate-800">
            <button class="edit btn btn-primary-weak btn-sm flex-1" data-id="${p.id}">
              <i class="fas fa-pen"></i> 수정
            </button>
            <button class="delete-btn btn btn-danger-weak btn-sm flex-1" data-id="${p.id}">
              <i class="fas fa-trash"></i> 삭제
            </button>
          </div>

        </div>
      </div>
    `,
    )
    .join("");
}

function renderPagination() {
  renderCursorPager(
    pagination,
    {
      current: currentPage,
      pagesKnown: totalPages,
      hasPrev: currentPage > 1,
      hasNext: currentPage < totalPages,
    },
    {
      goFirst: () => {
        currentPage = 1;
        renderPage();
      },
      goPrev: () => {
        if (currentPage > 1) {
          currentPage--;
          renderPage();
        }
      },
      goNext: () => {
        if (currentPage < totalPages) {
          currentPage++;
          renderPage();
        }
      },
      goPage: (n) => {
        currentPage = n;
        renderPage();
      },
      goLast: () => {
        currentPage = totalPages;
        renderPage();
      },
    },
    { window: 5 },
  );
}

// ==========================================
// 4. 초기화 및 이벤트 바인딩
// ==========================================

document.addEventListener("DOMContentLoaded", () => {
  // 초기 데이터 로드 순서: 카테고리 -> 정책 -> 상품
  loadCategoryIndex().then(loadPolicies).then(renderPolicyEditor);
  loadAllProducts();
  bindPageTabs();

  // 검색/초기화 버튼
  document.getElementById("search-btn").addEventListener("click", applyFilters);
  document.getElementById("reset-btn").addEventListener("click", async () => {
    document.getElementById("product-name").value = "";
    document.getElementById("product-barcode").value = "";
    document.getElementById("filter-category").value = "";
    document.getElementById("sort-select").value = "date";
    applyFilters();
    showToast(`초기화 완료 <i class='fas fa-check'></i>`);
  });

  // 엔터 키 검색
  ["product-name", "product-barcode", "filter-category"].forEach((id) => {
    document.getElementById(id)?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        applyFilters();
      }
    });
  });

  // 정렬 및 페이지 사이즈 변경
  document
    .getElementById("sort-select")
    .addEventListener("change", applyFilters);

  initPageSizeSelect(document.getElementById("page-size"), (n) => {
    pageSize = n;
    // 페이지 사이즈 변경 시 1페이지로 리셋
    applyFilters();
  });

  // 모달 닫기 (바깥 클릭 & ESC)
  const createOverlay = document.getElementById("product-create-modal");
  createOverlay?.addEventListener("click", (e) => {
    if (e.target === createOverlay) attemptCloseCreate();
  });
  const editOverlay = document.getElementById("edit-modal");
  editOverlay?.addEventListener("click", (e) => {
    if (e.target === editOverlay) attemptCloseEdit();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!createOverlay?.classList.contains("hidden")) attemptCloseCreate();
      if (!editOverlay?.classList.contains("hidden")) attemptCloseEdit();
    }
  });
});

/* ---------------------------
   탭, 카테고리, 정책 로직
---------------------------- */
function bindPageTabs() {
  const bar = document.querySelector(".tabbar--products");
  if (!bar) return;
  const btnList = bar.querySelector('[data-tab="list"]');
  const btnPolicy = bar.querySelector('[data-tab="policy"]');
  const paneList = document.getElementById("tab-products");
  const panePolicy = document.getElementById("tab-policy");

  const act = (which) => {
    const isList = which === "list";
    btnList.classList.toggle("is-active", isList);
    btnPolicy.classList.toggle("is-active", !isList);
    paneList.hidden = !isList;
    panePolicy.hidden = isList;
  };
  btnList.addEventListener("click", () => act("list"));
  btnPolicy.addEventListener("click", () => act("policy"));
  act("list");
}

function ensurePolicySectionVisible() {
  const sec = document.getElementById("tab-policy");
  if (!sec) return;
  sec.classList.remove("hidden");
}

// 카테고리 로드 및 자동완성
async function loadCategoryIndex({ ttlMs = 86400000 } = {}) {
  try {
    const snap = await getDoc(CAT_DOC);
    const list =
      snap.exists() && Array.isArray(snap.data().list) ? snap.data().list : [];
    categoriesCache = list;
    refreshAllAutocompletes();
    return list;
  } catch (e) {
    return [];
  }
}

async function addCategoriesToIndex(cats) {
  const norm = Array.from(
    new Set((cats || []).map(normalizeCategory).filter(Boolean)),
  );
  if (!norm.length) return;
  try {
    await updateDoc(CAT_DOC, {
      list: arrayUnion(...norm),
      updatedAt: serverTimestamp(),
    });
  } catch (e) {
    await setDoc(
      CAT_DOC,
      { list: arrayUnion(...norm), updatedAt: serverTimestamp() },
      { merge: true },
    );
  }
  categoriesCache = Array.from(new Set([...categoriesCache, ...norm]));
  refreshAllAutocompletes();
}

function refreshAllAutocompletes() {
  const cats = categoriesCache || [];
  setupAutocomplete("filter-category", "category-list-search", cats, () => {
    applyFilters(); // 선택 시 즉시 검색
  });
  setupAutocomplete("create-category", "category-list-create", cats);
  setupAutocomplete("edit-category", "category-list-edit", cats);
}

function setupAutocomplete(inputId, listId, options, onSelect = null) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  if (!input || !list) return;

  const cloneList = list.cloneNode(false);
  list.parentNode.replaceChild(cloneList, list);
  const newList = document.getElementById(listId);

  if (newList.parentNode !== document.body) document.body.appendChild(newList);
  newList.style.position = "fixed";
  newList.style.zIndex = "9999";
  newList.style.width = "";

  const updatePosition = () => {
    const rect = input.getBoundingClientRect();
    newList.style.top = `${rect.bottom + 4}px`;
    newList.style.left = `${rect.left}px`;
    newList.style.width = `${rect.width}px`;
  };

  const renderList = (filterText = "") => {
    const filtered = options.filter((opt) =>
      opt.toLowerCase().includes(filterText.toLowerCase()),
    );
    if (filtered.length === 0) {
      newList.classList.add("hidden");
      return;
    }
    newList.innerHTML = "";
    filtered.forEach((opt) => {
      const div = document.createElement("div");
      div.textContent = opt;
      div.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = opt;
        newList.classList.add("hidden");
        if (onSelect) onSelect(opt);
        input.dispatchEvent(new Event("change"));
      });
      newList.appendChild(div);
    });
    updatePosition();
    newList.classList.remove("hidden");
  };

  const onFocusOrInput = () => {
    updatePosition();
    renderList(input.value);
  };
  input.addEventListener("focus", onFocusOrInput);
  input.addEventListener("input", onFocusOrInput);
  window.addEventListener(
    "scroll",
    (e) => {
      if (e.target === newList || newList.contains(e.target)) return;
      newList.classList.add("hidden");
    },
    true,
  );
  window.addEventListener("resize", () => newList.classList.add("hidden"));
  input.addEventListener("blur", () =>
    setTimeout(() => newList.classList.add("hidden"), 150),
  );
}

// 정책(Policy) 관련
async function loadPolicies() {
  try {
    const snap = await getDoc(POLICY_DOC);
    const data = snap.exists() ? snap.data() : null;
    policiesCache = data && data.policies ? data.policies : {};
  } catch (e) {
    policiesCache = {};
  }
}

// [수정] 정책 에디터 렌더링 (TDS 적용 완료 버전)
function renderPolicyEditor() {
  const box = document.getElementById("policy-table");
  const saveBtn = document.getElementById("policy-save-btn");
  const cancelBtn = document.getElementById("policy-cancel-btn");
  const syncBtn = document.getElementById("category-sync-btn");
  const searchVal =
    document.getElementById("policy-search")?.value.trim().toLowerCase() || "";

  if (!box || !saveBtn || !cancelBtn) return;

  let cats = Array.from(
    new Set([...(categoriesCache || []), ...Object.keys(policiesCache || {})]),
  ).sort((a, b) => a.localeCompare(b));
  if (searchVal) cats = cats.filter((c) => c.toLowerCase().includes(searchVal));

  box.className = "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5";
  box.innerHTML = "";

  if (cats.length === 0) {
    box.className = "block";
    const msg = searchVal
      ? "검색 결과가 없습니다."
      : "설정할 카테고리가 없습니다.";
    box.innerHTML = `
      <div class="py-24 text-center select-none opacity-60">
        <div class="w-16 h-16 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4 text-slate-300 dark:text-slate-600 text-2xl"><i class="fas fa-filter"></i></div>
        <p class="text-slate-500 dark:text-slate-400 font-medium">${msg}</p>
      </div>`;
    return;
  }

  cats.forEach((cat, idx) => {
    const raw = policiesCache[cat] || {
      mode: "category",
      limit: 1,
      active: false,
    };
    const pol = (() => {
      if (raw.mode === "one_per_category")
        return { mode: "category", limit: 1, active: raw.active !== false };
      if (raw.mode === "one_per_price")
        return { mode: "price", limit: 1, active: raw.active !== false };
      const lim =
        Number.isFinite(raw.limit) && raw.limit >= 1
          ? Math.floor(raw.limit)
          : 1;
      const mode = raw.mode === "price" ? "price" : "category";
      return { mode, limit: lim, active: raw.active !== false };
    })();

    const row = document.createElement("div");
    row.className = `card p-5 flex flex-col gap-4 relative group transition-all duration-200 border-2 ${pol.active ? "border-transparent hover:border-primary-100 dark:hover:border-primary-900/50" : "opacity-60 grayscale border-transparent bg-slate-50 dark:bg-slate-800/50"}`;
    row.dataset.cat = cat;
    const name = `mode-${idx}`;

    row.innerHTML = `
      <div class="flex justify-between items-start gap-3">
        <div class="flex items-center gap-3 overflow-hidden">
          <div class="w-10 h-10 rounded-full ${pol.active ? "bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400" : "bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-500"} flex items-center justify-center shrink-0 transition-colors"><i class="fas fa-box"></i></div>
          <div class="font-bold text-slate-800 dark:text-white text-base truncate" title="${escapeHtml(cat)}">${escapeHtml(cat || "(미분류)")}</div>
        </div>
        <button type="button" class="switch policy-active ${pol.active ? "is-checked" : ""}" role="switch" aria-checked="${pol.active}"><span class="switch-thumb"></span></button>
      </div>
      <div class="flex items-center gap-2 mt-auto pt-2">
        <div class="tabs-segmented tabs-segmented-full !p-1 !bg-slate-100 dark:!bg-slate-700/50 !rounded-lg flex-1">
          <label class="tab-item !py-1.5 !text-xs !rounded-md flex-1 justify-center ${pol.mode === "category" ? "is-active" : ""}">
            <input type="radio" name="${name}" class="sr-only policy-mode" value="category" ${pol.mode === "category" ? "checked" : ""}><span>분류당</span>
          </label>
          <label class="tab-item !py-1.5 !text-xs !rounded-md flex-1 justify-center ${pol.mode === "price" ? "is-active" : ""}">
            <input type="radio" name="${name}" class="sr-only policy-mode" value="price" ${pol.mode === "price" ? "checked" : ""}><span>가격당</span>
          </label>
        </div>
        <div class="flex items-center gap-1.5 w-20 shrink-0">
          <div class="field-box !h-9 !px-0 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600">
            <input type="number" class="field-input policy-limit text-center !p-0 font-bold text-slate-800 dark:text-white" min="1" max="99" value="${pol.limit}">
          </div>
          <span class="text-xs font-bold text-slate-400 select-none">개</span>
        </div>
      </div>
    `;

    const mark = () => {
      markPolicyDirty();
      const switchBtn = row.querySelector(".switch");
      const isActive = switchBtn.classList.contains("is-checked");
      if (!isActive) {
        row.classList.add("opacity-60", "grayscale");
        row.classList.remove("border-transparent", "hover:border-primary-100");
        row
          .querySelector(".w-10")
          .classList.replace("bg-blue-50", "bg-slate-200");
        row
          .querySelector(".w-10")
          .classList.replace("text-blue-600", "text-slate-500");
      } else {
        row.classList.remove("opacity-60", "grayscale");
        row.classList.add("border-transparent", "hover:border-primary-100");
        row
          .querySelector(".w-10")
          .classList.replace("bg-slate-200", "bg-blue-50");
        row
          .querySelector(".w-10")
          .classList.replace("text-slate-500", "text-blue-600");
      }
    };

    const switchBtn = row.querySelector(".switch");
    switchBtn.addEventListener("click", () => {
      switchBtn.classList.toggle("is-checked");
      switchBtn.setAttribute(
        "aria-checked",
        switchBtn.classList.contains("is-checked"),
      );
      mark();
    });

    row.querySelectorAll(`input[name="${name}"]`).forEach((radio) => {
      radio.addEventListener("change", (e) => {
        row
          .querySelectorAll(".tab-item")
          .forEach((t) => t.classList.remove("is-active"));
        e.target.closest(".tab-item").classList.add("is-active");
        mark();
      });
    });

    row.querySelector(".policy-limit").addEventListener("input", mark);
    row.querySelector(".policy-limit").addEventListener("change", (e) => {
      if (e.target.value < 1) e.target.value = 1;
      mark();
    });

    box.appendChild(row);
  });

  saveBtn.disabled = true;
  cancelBtn.onclick = () => {
    const searchEl = document.getElementById("policy-search");
    if (searchEl) searchEl.value = "";
    policyDirty = false;
    renderPolicyEditor();
    showToast("변경 사항을 취소했습니다.");
  };
  saveBtn.onclick = savePolicies;
  if (syncBtn) syncBtn.onclick = handleSyncCategories;
  ensurePolicySectionVisible();
}

function markPolicyDirty() {
  policyDirty = true;
  const btn = document.getElementById("policy-save-btn");
  if (btn) btn.disabled = false;
}

function collectPoliciesFromDOM() {
  const box = document.getElementById("policy-table");
  const out = {};
  if (!box) return out;
  box.querySelectorAll(".card").forEach((row) => {
    const cat = (row.dataset.cat || "").trim();
    if (!cat) return;
    const modeEl = row.querySelector("input.policy-mode:checked");
    const mode = modeEl ? modeEl.value : "category";
    const limit = Math.max(
      1,
      Math.floor(parseFloat(row.querySelector(".policy-limit")?.value || "1")),
    );
    const active =
      row.querySelector(".switch")?.classList.contains("is-checked") ?? true;
    if (active) out[cat] = { mode, limit, active: true };
  });
  return out;
}

async function savePolicies() {
  try {
    const policies = collectPoliciesFromDOM();
    await setDoc(
      POLICY_DOC,
      { policies, updatedAt: serverTimestamp() },
      { merge: false },
    );
    policiesCache = policies;
    policyDirty = false;
    document.getElementById("policy-save-btn").disabled = true;
    showToast("제한 규칙이 저장되었습니다.");
  } catch (e) {
    showToast("제한 규칙 저장 중 오류가 발생했습니다.", true);
  }
}

async function handleSyncCategories() {
  const ok = await openConfirm({
    title: "카테고리 및 정책 정리",
    message:
      "현재 사용되지 않는 분류와<br>상품이 없는 유령 정책을 모두 삭제합니다.",
    variant: "info",
    confirmText: "정리 시작",
  });
  if (!ok) return;

  await withLoading(async () => {
    // 1. 전체 상품 스캔하여 '실제 사용 중인 카테고리' 추출
    const snap = await getDocs(query(productsCol));
    const realCats = new Set();
    snap.forEach((d) => {
      const c = normalizeCategory(d.data().category);
      if (c) realCats.add(c);
    });
    const newList = Array.from(realCats).sort();

    // 2. 자동완성 목록 업데이트 (기존 로직)
    // (이 시점에서 meta/categories_products는 깨끗해짐)
    await updateDoc(CAT_DOC, { list: newList, updatedAt: serverTimestamp() });
    categoriesCache = newList;
    refreshAllAutocompletes();

    // 3. [추가] 정책(Policies) 데이터도 청소
    // 현재 저장된 정책들을 불러와서, realCats에 없는 키(Key)는 삭제
    let deletedPoliciesCount = 0;
    const cleanPolicies = {};

    // 캐시 혹은 DB에서 현재 정책 가져오기
    if (!policiesCache || Object.keys(policiesCache).length === 0) {
      const pSnap = await getDoc(POLICY_DOC);
      policiesCache =
        pSnap.exists() && pSnap.data().policies ? pSnap.data().policies : {};
    }

    Object.entries(policiesCache).forEach(([cat, pol]) => {
      // 실제 상품이 있는 카테고리라면 유지
      if (realCats.has(cat)) {
        cleanPolicies[cat] = pol;
      } else {
        // 상품이 없으면 정책 폐기 (유령 정책)
        deletedPoliciesCount++;
      }
    });

    // 4. 정리된 정책으로 DB 덮어쓰기
    if (deletedPoliciesCount > 0) {
      await setDoc(
        POLICY_DOC,
        { policies: cleanPolicies, updatedAt: serverTimestamp() },
        { merge: false },
      );
      policiesCache = cleanPolicies;
    }

    // 5. UI 리로드
    renderPolicyEditor();

    showToast(
      `정리 완료: 분류 ${newList.length}개 유지 / 유령 정책 ${deletedPoliciesCount}개 삭제`,
    );
  }, "데이터 분석 및 정리 중...");
}

/* ---------------------------
   등록 / 수정 / 삭제 모달 로직
---------------------------- */
// 등록 탭/모달 제어
function resetCreateModal() {
  const m = document.getElementById("product-create-modal");
  if (!m) return;

  const tabs = m.querySelectorAll(".tab-item");
  tabs.forEach((t) => t.classList.remove("is-active"));
  m.querySelector('.tab-item[data-tab="direct"]')?.classList.add("is-active");

  m.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
  m.querySelector("#tab-direct")?.classList.remove("hidden");

  const footerDirect = m.querySelector("#footer-direct");
  const footerUpload = m.querySelector("#footer-upload");
  if (footerDirect) footerDirect.classList.remove("hidden");
  if (footerUpload) {
    footerUpload.classList.add("hidden");
    footerUpload.classList.remove("flex");
  }

  ["create-name", "create-category", "create-price", "create-barcode"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    },
  );

  if (typeof resetUploaderUI === "function") resetUploaderUI();

  const progress = document.getElementById("excel-progress");
  if (progress) progress.textContent = "";
  parsedRows = [];
  parsedIssues = [];
}

const openCreate = () => {
  const m = document.getElementById("product-create-modal");
  resetCreateModal();
  m.classList.remove("hidden");
  m.setAttribute("aria-hidden", "false");
};
const closeCreate = () => {
  const m = document.getElementById("product-create-modal");
  m.classList.add("hidden");
  m.setAttribute("aria-hidden", "true");
  resetCreateModal();
};

function isCreateDirty() {
  const has = (v) => v != null && String(v).trim() !== "";
  const name = document.getElementById("create-name")?.value ?? "";
  const hasParsed = Array.isArray(parsedRows) && parsedRows.length > 0;
  return has(name) || hasParsed; // 간단 체크
}

async function attemptCloseCreate() {
  const modal = document.getElementById("product-create-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  if (isCreateDirty()) {
    const ok = await openConfirm({
      title: "변경사항 경고",
      message: "입력 중인 내용이 있습니다. 닫을까요?",
      variant: "warn",
      confirmText: "닫기",
      cancelText: "계속 작성",
    });
    if (!ok) return;
  }
  closeCreate();
}

document
  .getElementById("btn-product-create")
  ?.addEventListener("click", openCreate);
document
  .getElementById("product-create-close")
  ?.addEventListener("click", attemptCloseCreate);
document
  .getElementById("product-create-close-2")
  ?.addEventListener("click", attemptCloseCreate);

// 탭 스위치 (TDS)
const modal = document.getElementById("product-create-modal");
modal?.querySelectorAll(".tab-item").forEach((tab) => {
  tab.addEventListener("click", () => {
    modal
      .querySelectorAll(".tab-item")
      .forEach((t) => t.classList.remove("is-active"));
    tab.classList.add("is-active");
    const target = tab.dataset.tab;
    modal
      .querySelectorAll(".tab-panel")
      .forEach((p) => p.classList.add("hidden"));
    modal.querySelector("#tab-" + target).classList.remove("hidden");

    const footerDirect = modal.querySelector("#footer-direct");
    const footerUpload = modal.querySelector("#footer-upload");
    if (target === "upload") {
      footerDirect.classList.add("hidden");
      footerUpload.classList.remove("hidden");
      footerUpload.classList.add("flex");
    } else {
      footerDirect.classList.remove("hidden");
      footerUpload.classList.add("hidden");
      footerUpload.classList.remove("flex");
    }
  });
});

// 상품 저장 (직접 입력) - 로컬 캐시 즉시 업데이트
document
  .getElementById("product-create-save")
  ?.addEventListener("click", async () => {
    const name = (document.getElementById("create-name")?.value || "").trim();
    const price = toNumber(
      document.getElementById("create-price")?.value || "",
    );
    const barcode = (
      document.getElementById("create-barcode")?.value || ""
    ).trim();
    const category = (
      document.getElementById("create-category")?.value || ""
    ).trim();
    const normCat = normalizeCategory(category);

    if (!name || !barcode || !isValidPrice(price))
      return showToast("입력값을 확인하세요.", true);
    if (!isValidBarcode13(barcode))
      return showToast("유효한 바코드가 아닙니다.", true);

    if (allProducts.some((p) => p.barcode === barcode))
      return showToast("이미 등록된 바코드입니다.", true);

    try {
      const ts = serverTimestamp();
      const newDoc = {
        name,
        price,
        barcode,
        category: normCat,
        createdAt: ts,
        lastestAt: ts,
        nameTokens: [],
      };
      const ref = await addDoc(productsCol, newDoc);

      // 로컬 업데이트
      const localProd = {
        id: ref.id,
        ...newDoc,
        createdAt: new Date(),
        _searchName: name.toLowerCase().replace(/\s+/g, ""),
        _searchBarcode: barcode,
      };
      allProducts.unshift(localProd);
      if (normCat) await addCategoriesToIndex([normCat]);

      showToast("등록되었습니다");
      closeCreate();
      applyFilters();
    } catch (e) {
      console.error(e);
      showToast("등록 실패", true);
    }
  });

// 수정 모달
function openEditModal(product) {
  document.getElementById("edit-name").value = product.name;
  const ec = document.getElementById("edit-category");
  if (ec) ec.value = product.category || "";
  document.getElementById("edit-price").value = product.price;
  document.getElementById("edit-barcode").value = product.barcode;
  editingProductId = product.id;
  editInitial = {
    name: product.name,
    price: String(product.price),
    barcode: product.barcode,
    category: product.category,
  };
  document.getElementById("edit-modal").classList.remove("hidden");
}

async function attemptCloseEdit() {
  const modal = document.getElementById("edit-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  const cur = {
    name: document.getElementById("edit-name").value,
    price: String(toNumber(document.getElementById("edit-price").value)),
    barcode: document.getElementById("edit-barcode").value,
    category: document.getElementById("edit-category").value,
  };
  const isDirty = ["name", "price", "barcode", "category"].some(
    (k) => (editInitial[k] ?? "") !== (cur[k] ?? ""),
  );
  if (isDirty) {
    const ok = await openConfirm({
      title: "변경사항 경고",
      message: "저장하지 않고 닫으시겠습니까?",
      variant: "warn",
      confirmText: "닫기",
      cancelText: "계속",
    });
    if (!ok) return;
  }
  modal.classList.add("hidden");
  editingProductId = null;
}
document
  .getElementById("edit-modal-close")
  .addEventListener("click", attemptCloseEdit);

// 수정 저장
document
  .getElementById("edit-modal-save")
  .addEventListener("click", async () => {
    const name = document.getElementById("edit-name").value.trim();
    const category = (
      document.getElementById("edit-category")?.value || ""
    ).trim();
    const price = toNumber(document.getElementById("edit-price").value);
    const barcode = document.getElementById("edit-barcode").value.trim();

    if (!name || !barcode || !isValidPrice(price))
      return showToast("입력값을 확인하세요.", true);
    if (!isValidBarcode13(barcode))
      return showToast("유효한 바코드가 아닙니다.", true);

    try {
      await updateDoc(doc(db, "products", editingProductId), {
        name,
        category,
        price,
        barcode,
        updatedAt: serverTimestamp(),
      });

      const idx = allProducts.findIndex((p) => p.id === editingProductId);
      if (idx !== -1) {
        allProducts[idx] = {
          ...allProducts[idx],
          name,
          category,
          price,
          barcode,
          _searchName: name.toLowerCase().replace(/\s+/g, ""),
          _searchBarcode: barcode,
        };
      }
      if (category) await addCategoriesToIndex([category]);

      document.getElementById("edit-modal").classList.add("hidden");
      editingProductId = null;
      applyFilters();
      showToast("수정되었습니다.");
    } catch (e) {
      showToast("수정 실패", true);
    }
  });

// 삭제 로직
productList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = btn.dataset.id;

  if (btn.classList.contains("delete-btn")) {
    const ok = await openConfirm({
      title: "삭제 확인",
      message: "정말 삭제하시겠습니까?",
      variant: "danger",
      confirmText: "삭제",
      cancelText: "취소",
    });
    if (!ok) return;
    try {
      await deleteDoc(doc(db, "products", id));
      allProducts = allProducts.filter((p) => p.id !== id);
      applyFilters();
      showToast("삭제되었습니다");
    } catch (e) {
      showToast("삭제 실패", true);
    }
  } else if (btn.classList.contains("edit")) {
    const product = allProducts.find((p) => p.id === id);
    if (product) openEditModal(product);
  }
});

/* ---------------------------
   Excel Upload Logic
---------------------------- */
const $file = document.getElementById("excel-file-input");
const $parseBtn = document.getElementById("excel-parse-btn");
const $importBtn = document.getElementById("excel-import-btn");
const $tmplBtn = document.getElementById("excel-template-btn");
const $preview = document.getElementById("excel-preview");
const $progress = document.getElementById("excel-progress");

const uploaderBox = document.querySelector("#tab-upload .uploader");
const uiIconWrap = document.getElementById("upload-ui-icon-wrapper");
const uiIcon = document.getElementById("upload-ui-icon");
const uiTextMain = document.getElementById("upload-ui-text-main");
const uiTextSub = document.getElementById("upload-ui-text-sub");

$tmplBtn?.addEventListener("click", downloadTemplate);
$parseBtn?.addEventListener("click", handleParse);
$importBtn?.addEventListener("click", handleImport);

function resetUploaderUI() {
  if (!uploaderBox) return;
  uploaderBox.classList.add(
    "border-slate-200",
    "dark:border-slate-700",
    "bg-slate-50/50",
    "dark:bg-slate-800/50",
  );
  uploaderBox.classList.remove(
    "border-blue-500",
    "bg-blue-50/30",
    "dark:bg-blue-900/10",
  );
  uiIconWrap.classList.add(
    "bg-blue-50",
    "text-blue-500",
    "dark:bg-blue-900/20",
  );
  uiIconWrap.classList.remove(
    "bg-green-100",
    "text-green-600",
    "dark:bg-green-900/30",
    "dark:text-green-400",
  );
  uiIcon.className = "fas fa-cloud-upload-alt text-xl";
  uiTextMain.textContent = "엑셀 파일을 이곳에 드래그하거나 클릭하세요";
  uiTextMain.classList.remove("text-blue-600", "dark:text-blue-400");
  uiTextSub.textContent = ".xlsx, .xls, .csv 파일만 지원됩니다.";
  uiTextSub.classList.remove("text-blue-400");
  renderEmptyState();
  $file.value = "";
  $importBtn.disabled = true;
  parsedRows = [];
}

$file?.addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) {
    uploaderBox.classList.remove(
      "border-slate-200",
      "dark:border-slate-700",
      "bg-slate-50/50",
      "dark:bg-slate-800/50",
    );
    uploaderBox.classList.add(
      "border-blue-500",
      "bg-blue-50/30",
      "dark:bg-blue-900/10",
    );
    uiIconWrap.classList.remove(
      "bg-blue-50",
      "text-blue-500",
      "dark:bg-blue-900/20",
    );
    uiIconWrap.classList.add(
      "bg-green-100",
      "text-green-600",
      "dark:bg-green-900/30",
      "dark:text-green-400",
    );
    uiIcon.className = "fas fa-file-excel text-2xl";
    uiTextMain.textContent = file.name;
    uiTextMain.classList.add("text-blue-600", "dark:text-blue-400");
    const kb = (file.size / 1024).toFixed(1);
    uiTextSub.textContent = `${kb} KB · 클릭하여 변경 가능`;
    uiTextSub.classList.add("text-blue-400");
    $preview.innerHTML = `
      <div class="w-full h-full flex flex-col items-center justify-center text-center p-6 select-none animate-fade-in">
        <div class="w-16 h-16 rounded-full bg-blue-50 dark:bg-slate-700 shadow-sm flex items-center justify-center border border-blue-100 dark:border-slate-600 mb-4">
          <i class="fas fa-check text-3xl text-blue-500 dark:text-blue-400"></i>
        </div>
        <p class="text-slate-900 dark:text-slate-200 font-bold text-lg mb-1">파일이 선택되었습니다.</p>
        <p class="text-slate-500 dark:text-slate-400 text-sm">아래 <span class="text-blue-600 dark:text-blue-400 font-bold">[파일 검사 및 미리보기]</span> 버튼을 눌러주세요.</p>
      </div>`;
    $importBtn.disabled = true;
    parsedRows = [];
  } else {
    resetUploaderUI();
  }
});

async function handleParse() {
  $progress.textContent = "";
  parsedRows = [];
  parsedIssues = [];
  const file = $file.files?.[0];
  if (!file) {
    showToast("엑셀 파일을 선택해 주세요.", true);
    renderEmptyState();
    return;
  }
  try {
    const rows = await readExcel(file);
    if (!rows.length) {
      $preview.innerHTML = `<div class="h-full flex items-center justify-center text-rose-500 font-medium"><i class="fas fa-exclamation-circle mr-2"></i>데이터가 비어 있습니다.</div>`;
      $importBtn.disabled = true;
      return;
    }
    const normalized = normalizeRows(rows);
    parsedRows = normalized.valid;
    parsedIssues = normalized.issues;

    // 테이블 렌더링
    const tableBodyHtml = parsedRows
      .map(
        (r, i) => `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors border-b border-slate-100 dark:border-slate-700 last:border-0">
        <td class="px-4 py-2 text-center text-slate-400 text-xs">${i + 1}</td>
        <td class="px-4 py-2 font-medium text-slate-800 dark:text-slate-200">${escapeHtml(r.name)}</td>
        <td class="px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">${escapeHtml(r.barcode)}</td>
        <td class="px-4 py-2 text-slate-600 dark:text-slate-400 text-xs">${escapeHtml(r.category || "-")}</td>
        <td class="px-4 py-2 text-right font-medium text-slate-700 dark:text-slate-300">${(r.price || 0).toLocaleString()}</td>
      </tr>`,
      )
      .join("");

    $preview.innerHTML = `
      <div class="flex flex-col h-full">
        <div class="px-4 py-3 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 flex flex-wrap gap-3 text-xs font-medium">
          <span class="text-slate-600 dark:text-slate-300">총 ${rows.length}행</span>
          <span class="text-blue-600 dark:text-blue-400">정상 ${parsedRows.length}</span>
          ${parsedIssues.length ? `<span class="text-rose-500">오류 ${parsedIssues.length}</span>` : ""}
        </div>
        <div class="flex-1 overflow-auto custom-scrollbar bg-white dark:bg-slate-900">
          <table class="table w-full text-sm text-left border-collapse">
            <thead class="sticky top-0 z-10 bg-slate-100 dark:bg-slate-800 text-xs uppercase text-slate-500 dark:text-slate-400 font-semibold shadow-sm">
              <tr><th class="px-4 py-2 text-center w-12">No.</th><th class="px-4 py-2">상품명</th><th class="px-4 py-2">바코드</th><th class="px-4 py-2">분류</th><th class="px-4 py-2 text-right">가격</th></tr>
            </thead>
            <tbody class="divide-y divide-slate-100 dark:divide-slate-700">${tableBodyHtml}</tbody>
          </table>
        </div>
      </div>`;
    $importBtn.disabled = parsedRows.length === 0;
    showToast("엑셀 파싱 완료");
  } catch (e) {
    console.error(e);
    $preview.innerHTML = `<div class="h-full flex flex-col items-center justify-center text-rose-500 gap-2"><i class="fas fa-times-circle text-2xl"></i><span>오류 발생</span></div>`;
    $importBtn.disabled = true;
  }
}

async function handleImport() {
  if (!parsedRows.length) return showToast("미리보기를 실행해 주세요.", true);

  // 기존 바코드 조회 (서버)
  const uniq = Array.from(new Set(parsedRows.map((r) => r.barcode)));
  const map = new Map();
  for (let i = 0; i < uniq.length; i += 10) {
    const chunk = uniq.slice(i, i + 10);
    const snap = await getDocs(
      query(productsCol, where("barcode", "in", chunk)),
    );
    snap.forEach((d) => map.set(d.data().barcode, d.id));
  }

  const CHUNK = 400;
  let created = 0,
    updated = 0;
  $progress.textContent = "업로드 시작...";
  $importBtn.disabled = true;
  $parseBtn.disabled = true;

  await withLoading(async () => {
    try {
      const chunks = [];
      for (let i = 0; i < parsedRows.length; i += CHUNK)
        chunks.push(parsedRows.slice(i, i + CHUNK));

      for (const rows of chunks) {
        const batch = writeBatch(db);
        rows.forEach((r) => {
          const id = map.get(r.barcode);
          const ts = serverTimestamp();
          if (id) {
            batch.update(doc(db, "products", id), {
              name: r.name,
              category: r.category,
              price: r.price,
              barcode: r.barcode,
              updatedAt: ts,
              lastestAt: ts,
            });
            updated++;
          } else {
            const newRef = doc(productsCol);
            batch.set(newRef, {
              name: r.name,
              category: r.category,
              price: r.price,
              barcode: r.barcode,
              createdAt: ts,
              lastestAt: ts,
              nameTokens: [],
            });
            created++;
          }
        });
        await batch.commit();
      }

      const newCats = Array.from(
        new Set(parsedRows.map((r) => r.category).filter(Boolean)),
      );
      if (newCats.length) await addCategoriesToIndex(newCats);

      showToast(`완료: ${created}건 추가, ${updated}건 업데이트`);
      closeCreate();
      // 전체 리로드로 데이터 싱크
      loadAllProducts();
    } catch (e) {
      console.error(e);
      showToast("업로드 실패", true);
    } finally {
      $importBtn.disabled = false;
      $parseBtn.disabled = false;
      $progress.textContent = "";
    }
  }, "업로드 중...");
}

// 엑셀 유틸
function readExcel(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const wb = XLSX.read(reader.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        // 헤더 찾기 로직 생략(약식) -> 첫행 or 자동탐지
        // 본문 길이가 너무 길어져서 핵심 로직만:
        const header = json[0].map((v) => String(v).trim());
        const data = json.slice(1).map((r) => {
          const o = {};
          header.forEach((h, i) => (o[h] = r[i]));
          return o;
        });
        resolve(data);
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}
function normalizeRows(rows) {
  const valid = [];
  const issues = [];
  for (const r of rows) {
    // 키 매핑 (한글->영문)
    const obj = {};
    for (const k of Object.keys(r)) obj[k.trim()] = r[k];

    const name = String(obj["상품명"] || obj.name || "").trim();
    const category = normalizeCategory(
      String(obj["분류"] || obj.category || ""),
    );
    const barcode = String(obj["바코드"] || obj.barcode || "").trim();
    const price = toNumber(obj["가격"] || obj.price);

    if (
      !name ||
      !barcode ||
      !isValidPrice(price) ||
      !isValidBarcode13(barcode)
    ) {
      issues.push({ name, barcode, price, reason: "오류" });
      continue;
    }
    valid.push({ name, category, barcode, price });
  }
  const seen = new Map();
  valid.forEach((v) => seen.set(v.barcode, v));
  return { valid: Array.from(seen.values()), issues };
}
async function downloadTemplate() {
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("상품등록");
    sheet.columns = [
      { header: "상품명", key: "name", width: 20 },
      { header: "바코드", key: "barcode", width: 18 },
      { header: "분류", key: "category", width: 15 },
      { header: "가격", key: "price", width: 10 },
    ];
    sheet.addRow({
      name: "새우깡",
      barcode: "8801234567890",
      category: "과자",
      price: 1,
    });
    const buffer = await workbook.xlsx.writeBuffer();
    saveAs(new Blob([buffer]), "products_template.xlsx");
  } catch (e) {
    console.error(e);
  }
}

function renderEmptyState() {
  if (!$preview) return;
  $preview.innerHTML = `
    <div class="w-full h-full flex flex-col items-center justify-center text-center p-6 select-none animate-fade-in">
      <div class="w-16 h-16 rounded-full bg-white dark:bg-slate-700 shadow-sm flex items-center justify-center border border-slate-100 dark:border-slate-600 mb-4">
        <i class="fas fa-file-excel text-3xl text-slate-300 dark:text-slate-500"></i>
      </div>
      <p class="text-slate-900 dark:text-slate-200 font-bold text-lg mb-1">데이터 미리보기</p>
      <p class="text-slate-500 dark:text-slate-400 text-sm">상단에서 엑셀 파일을 선택하고<br><span class="text-blue-600 dark:text-blue-400 font-semibold">[미리보기]</span> 버튼을 눌러주세요.</p>
    </div>`;
}

// Helper Utils
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        m
      ],
  );
}
function toNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v.replace(/,/g, ""));
  return NaN;
}
function isValidPrice(n) {
  return Number.isFinite(n) && n >= 0;
}
function isValidBarcode13(s) {
  if (!/^\d{13}$/.test(s)) return false;
  const arr = s.split("").map(Number);
  const check = arr.pop();
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += i % 2 === 0 ? arr[i] : arr[i] * 3;
  return (10 - (sum % 10)) % 10 === check;
}
function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}
