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
  where,
  orderBy,
  limit,
  startAfter,
  startAt,
  endAt,
  documentId,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  showToast,
  renderCursorPager,
  initPageSizeSelect,
  openConfirm,
} from "./components/comp.js";

const productsCol = collection(db, "products");
const POLICY_DOC = doc(db, "stats", "categoryPolicies");

// 커서 기반 페이징 상태(A안)
let prodPage = 1;
let prodPageSize = 25;
const prodCursors = [null]; // 각 페이지의 시작 커서(startAfter 기준 Doc)
let prodLastDoc = null;
let prodHasPrev = false;
let prodHasNext = false;
let currentRows = []; // 현재 페이지 렌더 데이터
let editingProductId = null; // 수정할 상품 ID

// ✅ 엑셀 업로드용 상태
let parsedRows = []; // 파싱된 행 (정상 데이터만)
let parsedIssues = []; // 누락/형식오류 등 스킵된 행
// 수정 모달 변경 감지용 스냅샷
let editInitial = null;

const productList = document.getElementById("product-list");
const pagination = document.getElementById("pagination");

/* ---------------------------
  카테고리 인덱스 (meta/categories_products)
   - 진입 시 1회 로드(+ localStorage TTL 캐시)
   - 새 카테고리 등장 시에만 arrayUnion로 1회 업데이트
---------------------------- */
const CAT_DOC = doc(db, "meta", "categories_products");
const CAT_CACHE_KEY = "catIndex:products:v1";
let categoriesCache = [];
let policiesCache = {}; // { [category]: { mode:'one_per_category'|'one_per_price', active:true } }
let policyDirty = false;

function normalizeCategory(c) {
  return String(c || "")
    .trim()
    .replace(/\s+/g, " ");
}
function injectCategoriesToDOM(list) {
  const sel = document.getElementById("filter-category");
  if (sel) {
    const prev = sel.value;
    // 첫 옵션(전체 분류) 제외 삭제
    for (let i = sel.options.length - 1; i >= 1; i--) sel.remove(i);
    list.forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat;
      opt.textContent = cat;
      sel.appendChild(opt);
    });
    if (prev && list.includes(prev)) sel.value = prev;
  }
  const dl = document.getElementById("category-presets");
  if (dl) {
    dl.innerHTML = "";
    list.forEach((cat) => {
      const opt = document.createElement("option");
      opt.value = cat;
      dl.appendChild(opt);
    });
  }
}
async function loadCategoryIndex({ ttlMs = 86400000 } = {}) {
  const now = Date.now();
  try {
    const cached = JSON.parse(localStorage.getItem(CAT_CACHE_KEY) || "null");
    if (
      cached &&
      Array.isArray(cached.list) &&
      typeof cached.cachedAt === "number" &&
      now - cached.cachedAt < ttlMs
    ) {
      categoriesCache = cached.list;
      injectCategoriesToDOM(categoriesCache);
      return categoriesCache;
    }
  } catch {}
  try {
    const snap = await getDoc(CAT_DOC);
    const list =
      snap.exists() && Array.isArray(snap.data().list) ? snap.data().list : [];
    categoriesCache = list;
    injectCategoriesToDOM(list);
    localStorage.setItem(
      CAT_CACHE_KEY,
      JSON.stringify({ list, cachedAt: now })
    );
    return list;
  } catch (e) {
    console.error(e);
    return [];
  }
}
async function addCategoriesToIndex(cats) {
  const norm = Array.from(
    new Set((cats || []).map(normalizeCategory).filter(Boolean))
  );
  if (!norm.length) return;
  try {
    await updateDoc(CAT_DOC, {
      list: arrayUnion(...norm),
      updatedAt: serverTimestamp(),
    });
  } catch (e) {
    // 문서가 없으면 생성(merge)
    await setDoc(
      CAT_DOC,
      { list: arrayUnion(...norm), updatedAt: serverTimestamp() },
      { merge: true }
    );
  }
  // 로컬 캐시/DOM 즉시 갱신(추가 읽기 없이)
  categoriesCache = Array.from(new Set([...categoriesCache, ...norm]));
  injectCategoriesToDOM(categoriesCache);
  try {
    localStorage.setItem(
      CAT_CACHE_KEY,
      JSON.stringify({ list: categoriesCache, cachedAt: Date.now() })
    );
  } catch {}
}

/* ---------------------------
   제한 정책 로드/렌더/저장
---------------------------- */
async function loadPolicies() {
  try {
    const snap = await getDoc(POLICY_DOC);
    const data = snap.exists() ? snap.data() : null;
    policiesCache = data && data.policies ? data.policies : {};
  } catch (e) {
    console.warn("loadPolicies failed:", e);
    policiesCache = {};
  }
}

// ---------------------------
// 페이지 탭 전환(상품 목록 / 제한 설정)
// ---------------------------
function bindPageTabs() {
  const bar = document.querySelector(".tabbar--products");
  if (!bar) return;
  const btnList = bar.querySelector('[data-tab="list"]');
  const btnPolicy = bar.querySelector('[data-tab="policy"]');
  const paneList = document.getElementById("tab-products");
  const panePolicy = document.getElementById("tab-policy");
  if (!btnList || !btnPolicy || !paneList || !panePolicy) return;
  const act = (which) => {
    const isList = which === "list";
    btnList.classList.toggle("active", isList);
    btnPolicy.classList.toggle("active", !isList);
    paneList.hidden = !isList;
    panePolicy.hidden = isList;
  };
  btnList.addEventListener("click", () => act("list"));
  btnPolicy.addEventListener("click", () => act("policy"));
  act("list"); // 기본: 목록 탭
}

function ensurePolicySectionVisible() {
  const sec = document.getElementById("category-policy-section");
  if (!sec) return;
  sec.classList.remove("hidden");
}
function renderPolicyEditor() {
  const box = document.getElementById("policy-table");
  const saveBtn = document.getElementById("policy-save-btn");
  const cancelBtn = document.getElementById("policy-cancel-btn");
  if (!box || !saveBtn || !cancelBtn) return;
  // 렌더 대상 카테고리 = 인덱스 + 기존 정책 키의 합집합
  const cats = Array.from(
    new Set([...(categoriesCache || []), ...Object.keys(policiesCache || {})])
  ).sort((a, b) => a.localeCompare(b));
  box.innerHTML = "";
  cats.forEach((cat, idx) => {
    const raw = policiesCache[cat] || {
      mode: "category",
      limit: 1,
      active: false,
    };
    // 하위호환: one_per_* → 새로운 포맷으로 정규화
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
    row.className = "policy-row";
    row.dataset.cat = cat;
    const name = `mode-${idx}`;
    row.innerHTML = `
      <div class="cat">${escapeHtml(cat || "(미분류)")}</div>
      <div class="seg" role="tablist" aria-label="제한 기준">
        <label class="opt ${pol.mode === "category" ? "active" : ""}">
          <input type="radio" name="${name}" class="policy-mode" value="category" ${
      pol.mode === "category" ? "checked" : ""
    }>
          분류당
        </label>
        <label class="opt ${pol.mode === "price" ? "active" : ""}">
          <input type="radio" name="${name}" class="policy-mode" value="price" ${
      pol.mode === "price" ? "checked" : ""
    }>
          가격당
        </label>
      </div>
      <input type="number" class="policy-limit" min="1" step="1" value="${
        pol.limit
      }">
      <label style="display:flex;align-items:center;gap:6px;justify-self:flex-end">
        <input type="checkbox" class="policy-active"${
          pol.active ? " checked" : ""
        }/>
        활성
      </label>
    `;
    // 토글 비주얼 active 처리
    row.querySelectorAll(`input[name="${name}"]`).forEach((r) => {
      r.addEventListener("change", (e) => {
        row
          .querySelectorAll(".seg .opt")
          .forEach((el) => el.classList.remove("active"));
        e.target.closest(".opt")?.classList.add("active");
        markPolicyDirty();
      });
    });
    // 변경 감지
    row
      .querySelector(".policy-limit")
      .addEventListener("input", () => markPolicyDirty());
    row
      .querySelector(".policy-active")
      .addEventListener("change", () => markPolicyDirty());

    box.appendChild(row);
  });
  saveBtn.disabled = true;
  // ✅ 변경 취소: 화면상의 편집값을 모두 버리고 마지막 저장 상태(policiesCache)로 복귀
  cancelBtn.onclick = () => {
    renderPolicyEditor(); // DOM을 policiesCache 기반으로 다시 그림
    policyDirty = false;
    saveBtn.disabled = true;
    showToast("변경 사항을 취소했습니다.");
  };
  saveBtn.onclick = savePolicies;
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
  box.querySelectorAll(".policy-row").forEach((row) => {
    const cat = (row.dataset.cat || "").trim();
    if (!cat) return;
    const modeEl = row.querySelector("input.policy-mode:checked");
    const mode = modeEl ? modeEl.value : "category"; // 'category' | 'price'
    const limit = Math.max(
      1,
      Math.floor(parseFloat(row.querySelector(".policy-limit")?.value || "1"))
    );
    const active = row.querySelector(".policy-active")?.checked ?? true;
    if (active) out[cat] = { mode, limit, active: true };
  });
  return out;
}
async function savePolicies() {
  try {
    const policies = collectPoliciesFromDOM();
    // 문서 전체를 새 값으로 교체(삭제 반영 위해 merge:false)
    await setDoc(
      POLICY_DOC,
      { policies, updatedAt: serverTimestamp() },
      { merge: false }
    );
    policiesCache = policies;
    policyDirty = false;
    document.getElementById("policy-save-btn").disabled = true;
    showToast("제한 규칙이 저장되었습니다.");
  } catch (e) {
    console.error(e);
    showToast("제한 규칙 저장 중 오류가 발생했습니다.", true);
  }
}

/* ---------------------------
    서버 커서 페이징(A안)
---------------------------- */
function resetProdPager() {
  prodPage = 1;
  prodCursors.length = 0;
  prodCursors.push(null);
  prodLastDoc = null;
  prodHasPrev = false;
  prodHasNext = false;
}

function buildProductQuery(direction = "init") {
  const nameFilter =
    document.getElementById("product-name")?.value.trim() || "";
  const barcodeFilter =
    document.getElementById("product-barcode")?.value.trim() || "";
  const sortBy = document.getElementById("sort-select")?.value || "date";
  const categoryFilter =
    document.getElementById("filter-category")?.value.trim() || "";

  const cons = [];
  // 필터 우선순위: barcode ===, 없으면 name 접두, 둘 다 없으면 정렬만
  let orders = [];
  if (barcodeFilter) {
    if (categoryFilter) cons.push(where("category", "==", categoryFilter));
    cons.push(where("barcode", "==", barcodeFilter));
    orders = [orderBy(documentId())]; // where== 필터 시 보조 정렬
  } else if (nameFilter) {
    // 이름 접두 검색: name 기준(대소문자 구분)
    if (categoryFilter) cons.push(where("category", "==", categoryFilter));
    cons.push(orderBy("name"));
    cons.push(startAt(nameFilter));
    cons.push(endAt(nameFilter + "\uf8ff"));
  } else {
    // 정렬 옵션
    if (categoryFilter) cons.push(where("category", "==", categoryFilter));
    if (sortBy === "price") orders = [orderBy("price", "asc")];
    else if (sortBy === "name") orders = [orderBy("name", "asc")];
    else if (sortBy === "barcode") orders = [orderBy("barcode", "asc")];
    else orders = [orderBy("createdAt", "desc")]; // date
  }
  cons.push(...orders);

  // 페이지 커서
  const after =
    direction === "next" || direction === "jump"
      ? prodLastDoc
      : prodCursors[prodPage - 1];
  if (after) cons.push(startAfter(after));
  cons.push(limit(prodPageSize));
  return query(productsCol, ...cons);
}
async function loadProducts(direction = "init") {
  const qy = buildProductQuery(direction);
  productList.innerHTML = "";
  try {
    const snap = await getDocs(qy);
    currentRows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    prodHasPrev = prodPage > 1;
    prodHasNext = currentRows.length === prodPageSize;
    prodLastDoc = snap.docs[snap.docs.length - 1] || null;
    // 페이지 시작 커서 기록(해당 페이지 첫 문서)
    if (!prodCursors[prodPage - 1] && snap.docs.length) {
      prodCursors[prodPage - 1] = snap.docs[0];
    }
    renderList();
    renderPagination();
  } catch (e) {
    console.error(e);
    showToast("상품 목록을 불러오지 못했습니다.", true);
  }
}

function renderList() {
  const rows = currentRows || [];
  productList.innerHTML = rows
    .map(
      (p) => `
    <div class="product-card" data-id="${p.id}">
      <div class="name">${escapeHtml(p.name || "")}</div>
      <div class="category">분류: ${escapeHtml(p.category || "-")}</div>
      <div class="price">${Number(p.price || 0).toLocaleString()} 포인트</div>
      <div class="barcode">바코드: ${escapeHtml(p.barcode || "")}</div>
      <div><button class="edit" data-id="${
        p.id
      }" aria-label="상품 수정: ${escapeHtml(p.name || "")}">
          <i class="fas fa-pen"></i> 수정
        </button>
        <button class="delete-btn" data-id="${
          p.id
        }" aria-label="상품 삭제: ${escapeHtml(p.name || "")}">
          <i class="fas fa-trash"></i> 삭제
        </button>
      </div>
    </div>
  `
    )
    .join("");
}

function renderPagination() {
  const box = pagination;
  if (!box) return;
  const pagesKnown = prodCursors.length; // 지금까지 탐색된 페이지 수
  renderCursorPager(
    box,
    {
      current: prodPage,
      pagesKnown,
      hasPrev: prodHasPrev,
      hasNext: prodHasNext,
    },
    {
      goFirst: () => {
        if (!prodHasPrev) return;
        prodPage = 1;
        resetProdPager();
        loadProducts("init");
      },
      goPrev: () => {
        if (!prodHasPrev) return;
        prodPage = Math.max(1, prodPage - 1);
        loadProducts("prev");
      },
      goNext: () => {
        if (!prodHasNext) return;
        prodPage += 1;
        loadProducts("next");
      },
      goPage: (n) => {
        if (n === prodPage) return;
        // 이미 탐색된 범위만 점프 허용
        if (n > 0 && n <= prodCursors.length) {
          prodPage = n;
          loadProducts("jump");
        }
      },
    },
    { window: 5 }
  );
}

// XSS 회피용 간단 escape
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        m
      ])
  );
}

/* ---------------------------
    기본 기능 (검색/초기화/등록/수정/삭제)
--------------------------- */
document.getElementById("search-btn").addEventListener("click", () => {
  resetProdPager();
  loadProducts("init");
});

document.getElementById("reset-btn").addEventListener("click", async () => {
  document.getElementById("product-name").value = "";
  document.getElementById("product-barcode").value = "";
  document.getElementById("sort-select").value = "date";
  resetProdPager();
  await loadProducts("init");
  showToast(`초기화 완료 <i class='fas fa-check'></i>`);
});

// ====== 등록 모달(직접 입력 / 엑셀 업로드) ======
function resetCreateModal() {
  const m = document.getElementById("product-create-modal");
  if (!m) return;
  // 탭 초기화: '직접 입력' 활성
  const tabs = m.querySelectorAll(".tab");
  tabs.forEach((t) => t.classList.remove("active"));
  m.querySelector('.tab[data-tab="direct"]')?.classList.add("active");
  m.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
  m.querySelector("#tab-direct")?.classList.remove("hidden");
  // 폼/파일/미리보기 초기화
  document.getElementById("create-name")?.closest("form")?.reset?.();
  const file = document.getElementById("excel-file-input");
  if (file) file.value = "";
  const importBtn = document.getElementById("excel-import-btn");
  if (importBtn) importBtn.disabled = true;
  const preview = document.getElementById("excel-preview");
  const progress = document.getElementById("excel-progress");
  if (preview) preview.textContent = "";
  if (progress) progress.textContent = "";
  // 파싱 캐시 초기화
  parsedRows = [];
  parsedIssues = [];
}

function isCreateDirty() {
  const has = (v) => v != null && String(v).trim() !== "";
  const name = document.getElementById("create-name")?.value ?? "";
  const priceVal = document.getElementById("create-price")?.value ?? "";
  const barcode = document.getElementById("create-barcode")?.value ?? "";
  const category = document.getElementById("create-category")?.value ?? "";
  const fileVal = document.getElementById("excel-file-input")?.value ?? "";
  const previewText =
    document.getElementById("excel-preview")?.textContent ?? "";
  const hasParsed = Array.isArray(parsedRows) && parsedRows.length > 0;
  return (
    has(name) ||
    has(priceVal) ||
    has(barcode) ||
    has(category) ||
    has(fileVal) ||
    has(previewText) ||
    hasParsed
  );
}
async function attemptCloseCreate() {
  const modal = document.getElementById("product-create-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  if (isCreateDirty()) {
    const ok = await openConfirm({
      title: "변경사항 경고",
      message: "입력/업로드 중인 내용이 있습니다. 닫으면 사라집니다. 닫을까요?",
      variant: "warn",
      confirmText: "닫기",
      cancelText: "계속 작성",
      allowOutsideClose: false,
      defaultFocus: "cancel",
    });
    if (!ok) return;
  }
  closeCreate();
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

document
  .getElementById("btn-product-create")
  ?.addEventListener("click", openCreate);
document
  .getElementById("product-create-close")
  ?.addEventListener("click", attemptCloseCreate);
document
  .getElementById("product-create-close-2")
  ?.addEventListener("click", attemptCloseCreate);
// 탭 스위치
document.querySelectorAll("#product-create-modal .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const modal = document.getElementById("product-create-modal");
    modal.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    modal
      .querySelectorAll(".tab-panel")
      .forEach((p) => p.classList.add("hidden"));
    modal.querySelector("#tab-" + tab.dataset.tab).classList.remove("hidden");
  });
});
// 직접 저장
document
  .getElementById("product-create-save")
  ?.addEventListener("click", async () => {
    const name = (document.getElementById("create-name")?.value || "").trim();
    const price = toNumber(
      document.getElementById("create-price")?.value || ""
    );
    const barcode = (
      document.getElementById("create-barcode")?.value || ""
    ).trim();
    const category = (
      document.getElementById("create-category")?.value || ""
    ).trim();
    const normCat = normalizeCategory(category);
    if (!name || !barcode || !isValidPrice(price)) {
      return showToast("상품명/바코드/가격을 확인해주세요.", true);
    }
    if (!isValidBarcode13(barcode)) {
      return showToast("유효한 바코드가 아닙니다.", true);
    }
    const dup = await getDocs(
      query(productsCol, where("barcode", "==", barcode), limit(1))
    );
    if (!dup.empty) return showToast("⚠ 이미 등록된 바코드입니다.", true);
    const ts = serverTimestamp();
    await addDoc(productsCol, {
      name,
      price,
      barcode,
      category: normCat,
      createdAt: ts,
      lastestAt: ts,
    });
    if (normCat) await addCategoriesToIndex([normCat]);
    showToast("등록되었습니다");
    closeCreate();
    resetProdPager();
    await loadProducts("init");
  });
// ===== 수정 모달 변경 감지/닫기 보조 =====
function readEditSnapshot() {
  const name = (document.getElementById("edit-name")?.value || "").trim();
  const price = String(
    toNumber(document.getElementById("edit-price")?.value || "")
  );
  const barcode = (document.getElementById("edit-barcode")?.value || "").trim();
  const category = (
    document.getElementById("edit-category")?.value || ""
  ).trim();
  const normCat = normalizeCategory(category);
  return { name, price, barcode, category };
}
function isEditDirty() {
  if (!editInitial) return false;
  const cur = readEditSnapshot();
  return ["name", "price", "barcode", "category"].some(
    (k) => (editInitial[k] ?? "") !== (cur[k] ?? "")
  );
}
async function attemptCloseEdit() {
  const modal = document.getElementById("edit-modal");
  if (!modal || modal.classList.contains("hidden")) return;
  if (isEditDirty()) {
    const ok = await openConfirm({
      title: "변경사항 경고",
      message: "변경사항이 저장되지 않았습니다. 닫을까요?",
      variant: "warn",
      confirmText: "닫기",
      cancelText: "계속 작성",
      allowOutsideClose: false,
      defaultFocus: "cancel",
    });
    if (!ok) return;
  }
  modal.classList.add("hidden");
  editingProductId = null;
  editInitial = null;
}

productList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.classList.contains("delete-btn")) {
    const shouldGoPrev = currentRows.length === 1 && prodPage > 1;
    const ok = await openConfirm({
      title: "삭제 확인",
      message: "정말 삭제하시겠습니까?",
      variant: "danger",
      confirmText: "삭제",
      cancelText: "취소",
    });
    if (!ok) return;
    await deleteDoc(doc(db, "products", id));
    if (shouldGoPrev) {
      // 말단 페이지의 마지막 1건이었다면 이전 페이지로 이동(추가 읽기 없이 페이지 인덱스만 조정)
      prodPage = Math.max(1, prodPage - 1);
      await loadProducts("prev");
    } else {
      await loadProducts("init");
    }
  }
  if (btn.classList.contains("edit")) {
    let product = currentRows.find((p) => p.id === id);
    if (!product) {
      const snap = await getDoc(doc(db, "products", id));
      if (!snap.exists()) return;
      product = { id: snap.id, ...snap.data() };
    }
    document.getElementById("edit-name").value = product.name;
    const ec = document.getElementById("edit-category");
    if (ec) ec.value = product.category || "";
    document.getElementById("edit-price").value = product.price;
    document.getElementById("edit-barcode").value = product.barcode;
    editingProductId = id;
    editInitial = {
      name: product.name || "",
      price: String(product.price ?? ""),
      barcode: product.barcode || "",
      category: product.category || "",
    };
    document.getElementById("edit-modal").classList.remove("hidden");
  }
});

document.getElementById("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("edit-name").value.trim();
  const category = (
    document.getElementById("edit-category")?.value || ""
  ).trim();
  const price = toNumber(document.getElementById("edit-price").value);
  const barcode = document.getElementById("edit-barcode").value.trim();
  const updatedAt = serverTimestamp();
  const lastestAt = serverTimestamp();

  if (!name || !barcode || !isValidPrice(price)) {
    showToast("수정값을 확인하세요.", true);
    return;
  }
  if (!isValidBarcode13(barcode)) {
    showToast("유효한 바코드가 아닙니다.", true);
    return;
  }

  const ref = doc(db, "products", editingProductId);
  await updateDoc(ref, {
    name,
    category: normCat,
    price,
    barcode,
    updatedAt,
    lastestAt,
  });
  if (normCat) await addCategoriesToIndex([normCat]);

  document.getElementById("edit-modal").classList.add("hidden");
  editingProductId = null;
  editInitial = null;
  await loadProducts("init");
});

document
  .getElementById("cancel-btn")
  .addEventListener("click", attemptCloseEdit);

/* ---------------------------
    엑셀 업로드 (신규)
--------------------------- */
const $file = document.getElementById("excel-file-input");
const $parseBtn = document.getElementById("excel-parse-btn");
const $importBtn = document.getElementById("excel-import-btn");
const $tmplBtn = document.getElementById("excel-template-btn");
const $preview = document.getElementById("excel-preview");
const $progress = document.getElementById("excel-progress");

$tmplBtn.addEventListener("click", downloadTemplate);
$parseBtn.addEventListener("click", handleParse);
$importBtn.addEventListener("click", handleImport);

/** 템플릿 다운로드 (.xlsx) */
function downloadTemplate() {
  /* global XLSX */
  const ws = XLSX.utils.aoa_to_sheet([
    ["name", "category", "price", "barcode"],
    ["콜라 500ml", "음료", 1200, "8801234567890"],
    ["초코파이", "과자", 500, "8809876543210"],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "products");
  XLSX.writeFile(wb, "products_template.xlsx");
}

/** 엑셀 파싱 */
async function handleParse() {
  $preview.innerHTML = "";
  $progress.textContent = "";
  parsedRows = [];
  parsedIssues = [];

  const file = $file.files?.[0];
  if (!file) {
    showToast("엑셀 파일을 선택해 주세요.", true);
    return;
  }

  try {
    const rows = await readExcel(file);
    if (!rows.length) {
      $preview.innerHTML =
        "<span style='color:#d32f2f'>표 데이터가 비어 있습니다.</span>";
      $importBtn.disabled = true;
      return;
    }

    const normalized = normalizeRows(rows);
    parsedRows = normalized.valid;
    parsedIssues = normalized.issues;

    // 미리보기
    const dupInFile = countDuplicatesBy(parsedRows, "barcode");
    const msg = [
      `총 ${rows.length.toLocaleString()}행`,
      `정상 ${parsedRows.length.toLocaleString()}행`,
      parsedIssues.length
        ? `스킵 ${parsedIssues.length.toLocaleString()}행`
        : null,
      Object.keys(dupInFile).length
        ? `파일 내 중복 바코드 ${Object.values(dupInFile).reduce(
            (a, b) => a + b,
            0
          )}개`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");

    const sample = parsedRows
      .slice(0, 5)
      .map(
        (r) =>
          `${escapeHtml(r.name)} / ${escapeHtml(r.category || "-")} / ${
            r.price
          } / ${escapeHtml(r.barcode)}`
      )
      .join("<br/>");
    $preview.innerHTML = `
      <div>미리보기: ${msg}</div>
      <div style="margin-top:6px; color:#333;">${sample}</div>
    `;

    $importBtn.disabled = parsedRows.length === 0;
    showToast("엑셀 파싱 완료");
  } catch (e) {
    console.error(e);
    $preview.innerHTML =
      "<span style='color:#d32f2f'>파일을 읽는 중 오류가 발생했습니다.</span>";
    $importBtn.disabled = true;
  }
}

/** 업로드 실행 */
async function handleImport() {
  if (!parsedRows.length) {
    showToast("먼저 미리보기를 실행해 주세요.", true);
    return;
  }

  // 서버에서 기존 바코드 조회(10개 단위 where('in'))
  const byBarcode = await fetchExistingByBarcode(
    parsedRows.map((r) => r.barcode)
  );

  let created = 0,
    updated = 0,
    skipped = 0;

  // Firestore 배치(500 제한) → 400으로 쪼개기
  const CHUNK = 400;
  const chunks = [];
  for (let i = 0; i < parsedRows.length; i += CHUNK)
    chunks.push(parsedRows.slice(i, i + CHUNK));

  $progress.textContent = `0 / ${parsedRows.length} 처리 중...`;
  $importBtn.disabled = true;
  $parseBtn.disabled = true;

  try {
    for (let ci = 0; ci < chunks.length; ci++) {
      const batch = writeBatch(db);
      const rows = chunks[ci];

      rows.forEach((row) => {
        const existing = byBarcode.get(row.barcode);
        const ts = serverTimestamp();
        if (existing) {
          // ✅ 기존 바코드면 항상 업데이트(분류 포함)
          const ref = doc(db, "products", existing.id);
          batch.update(ref, {
            name: row.name,
            category: row.category, // ← 추가
            price: row.price,
            barcode: row.barcode,
            updatedAt: ts,
            lastestAt: ts,
          });
          updated++;
        } else {
          const ref = doc(productsCol); // 랜덤 ID
          batch.set(ref, {
            name: row.name,
            category: row.category,
            price: row.price,
            barcode: row.barcode,
            createdAt: ts,
            lastestAt: ts,
          });
          created++;
        }
      });

      await batch.commit();
      $progress.textContent = `${Math.min(
        (ci + 1) * CHUNK,
        parsedRows.length
      )} / ${parsedRows.length} 처리 중...`;
    }

    // 업로드에 포함된 새 카테고리를 한 번에 인덱스에 합치기(쓰기 1회)
    const catsToIndex = Array.from(
      new Set(
        parsedRows.map((r) => normalizeCategory(r.category)).filter(Boolean)
      )
    );
    if (catsToIndex.length) await addCategoriesToIndex(catsToIndex);

    $progress.textContent = `완료: 추가 ${created.toLocaleString()} · 업데이트 ${updated.toLocaleString()}`;
    showToast(`엑셀 업로드 완료 (${created} 추가 / ${updated} 업데이트)`);
    // ✅ 업로드 성공 후 모달 닫기 + 초기화
    closeCreate();
    resetProdPager();
    await loadProducts("init");
  } catch (e) {
    console.error(e);
    showToast("엑셀 업로드 중 오류가 발생했습니다.", true);
    $progress.textContent = "실패";
  } finally {
    $importBtn.disabled = false;
    $parseBtn.disabled = false;
  }
}

/** 기존 바코드들을 Firestore에서 조회(Map(barcode -> {id,...})) */
async function fetchExistingByBarcode(barcodes) {
  const uniq = Array.from(new Set(barcodes.filter(Boolean).map(String)));
  const map = new Map();
  // where in 은 10개 제한 → 청크 처리
  for (let i = 0; i < uniq.length; i += 10) {
    const chunk = uniq.slice(i, i + 10);
    const snap = await getDocs(
      query(productsCol, where("barcode", "in", chunk))
    );
    snap.forEach((d) => {
      const data = d.data();
      map.set(String(data.barcode || ""), { id: d.id, ...data });
    });
  }
  return map;
}

/* ---------------------------
    엑셀 읽기/정규화 유틸
--------------------------- */
function readExcel(file) {
  /* global XLSX */
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const isCsv = /\.csv$/i.test(file.name);
    reader.onload = () => {
      try {
        const data = reader.result;
        const wb = XLSX.read(data, { type: isCsv ? "binary" : "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: "" }); // 첫 시트만
        resolve(rows);
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = reject;
    if (isCsv) reader.readAsBinaryString(file);
    else reader.readAsArrayBuffer(file);
  });
}

/** 헤더 매핑 + 형식 검증
 *  허용 헤더: name/상품명, category/분류, price/가격, barcode/바코드
 */
function normalizeRows(rows) {
  const valid = [];
  const issues = [];

  for (const raw of rows) {
    // 키를 소문자 trim
    const obj = {};
    for (const k of Object.keys(raw)) {
      obj[k.trim().toLowerCase()] = raw[k];
    }
    const name = String(obj.name ?? obj["상품명"] ?? "").trim();
    const category = normalizeCategory(
      String(obj.category ?? obj["분류"] ?? "")
    );
    const barcode = String(obj.barcode ?? obj["바코드"] ?? "").trim();
    const priceRaw = obj.price ?? obj["가격"];
    const price = toNumber(priceRaw);

    if (
      !name ||
      !barcode ||
      !isValidPrice(price) ||
      !isValidBarcode13(barcode)
    ) {
      issues.push({ name, price: priceRaw, barcode, reason: "필수/형식 오류" });
      continue;
    }
    valid.push({ name, category, price, barcode });
  }

  // 파일 내 바코드 중복 → 마지막 값으로 사용 (또는 건너뛰기 전략 가능)
  const seen = new Map();
  for (const r of valid) seen.set(r.barcode, r); // 마지막 승리
  return { valid: Array.from(seen.values()), issues };
}

function toNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseFloat(v.replace(/,/g, ""));
  return NaN;
}
function isValidPrice(n) {
  return Number.isFinite(n) && n >= 0;
}

// EAN-13 체크섬 검증: 12자리 가중합(1,3 반복)의 보정값이 마지막 자리와 일치
function isValidBarcode13(s) {
  const str = String(s || "").trim();
  if (!/^\d{13}$/.test(str)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const n = str.charCodeAt(i) - 48; // fast parse
    sum += i % 2 === 0 ? n : n * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === str.charCodeAt(12) - 48;
}

function countDuplicatesBy(arr, key) {
  const map = {};
  arr.forEach((o) => {
    const k = String(o[key] ?? "");
    map[k] = (map[k] || 0) + 1;
  });
  Object.keys(map).forEach((k) => {
    if (map[k] < 2) delete map[k];
  });
  return map;
}

/* ---------------------------
    초기 포커스/엔터 검색 및 로딩
--------------------------- */
document.addEventListener("DOMContentLoaded", () => {
  // 카테고리 인덱스 로드(캐시 우선, 미스 시 1회 읽기)
  loadCategoryIndex()
    .then(loadPolicies)
    .then(renderPolicyEditor)
    .catch(console.error);
  bindPageTabs();
  // 이름/바코드에서 Enter → 검색
  ["product-name", "product-barcode"].forEach((id) => {
    const el = document.getElementById(id);
    if (el)
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          document.getElementById("search-btn")?.click();
        }
      });
  });
  // 🧯 모달 바깥 클릭으로 닫기 (등록/수정 모달 공통)
  const createOverlay = document.getElementById("product-create-modal");
  createOverlay?.addEventListener("click", (e) => {
    if (e.target === createOverlay) attemptCloseCreate();
  });
  const editOverlay = document.getElementById("edit-modal");

  editOverlay?.addEventListener("click", (e) => {
    if (e.target === editOverlay) attemptCloseEdit();
  });
  // Esc로 닫기
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!createOverlay?.classList.contains("hidden")) attemptCloseCreate();
    if (!editOverlay?.classList.contains("hidden")) attemptCloseEdit();
  });
  // 페이지 사이즈 셀렉트(A안 공통)
  initPageSizeSelect(document.getElementById("page-size"), (n) => {
    prodPageSize = n;
    resetProdPager();
    loadProducts("init");
  });
  resetProdPager();
  loadProducts("init");
});

document.getElementById("sort-select").addEventListener("change", () => {
  resetProdPager();
  loadProducts("init");
});

// 분류 필터 변경 시 즉시 서버 쿼리 (읽기 최소화를 위해 클라이언트 후처리 없음)
document.getElementById("filter-category")?.addEventListener("change", () => {
  resetProdPager();
  loadProducts("init");
});
