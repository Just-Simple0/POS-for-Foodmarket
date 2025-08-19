import { db } from "./components/firebase-config.js";
import {
  collection,
  getDocs,
  addDoc,
  deleteDoc,
  updateDoc,
  doc,
  serverTimestamp,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { showToast } from "./components/comp.js";

const productsCol = collection(db, "products");

let allProducts = [];
let filteredProducts = [];
let currentPage = 1;
let editingProductId = null; // 수정할 상품 ID
const itemsPerPage = 25;

// ✅ 엑셀 업로드용 상태
let parsedRows = []; // 파싱된 행 (정상 데이터만)
let parsedIssues = []; // 누락/형식오류 등 스킵된 행

const productList = document.getElementById("product-list");
const pagination = document.getElementById("pagination");

/* ---------------------------
   상품 목록 로딩 / 필터 / 렌더
--------------------------- */
async function loadProducts() {
  const snapshot = await getDocs(productsCol);
  allProducts = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
  applyFiltersAndSort();
}

function applyFiltersAndSort() {
  const nameFilter = document
    .getElementById("product-name")
    .value.trim()
    .toLowerCase();
  const barcodeFilter = document.getElementById("product-barcode").value.trim();
  const sortBy = document.getElementById("sort-select")?.value || "price";

  filteredProducts = allProducts.filter((p) => {
    const nameMatch = p.name?.toLowerCase().includes(nameFilter);
    const barcodeMatch = barcodeFilter
      ? (p.barcode || "").includes(barcodeFilter)
      : true;
    return nameMatch && barcodeMatch;
  });

  filteredProducts.sort((a, b) => {
    if (sortBy === "price") return (a.price || 0) - (b.price || 0);
    if (sortBy === "name") return (a.name || "").localeCompare(b.name || "");
    if (sortBy === "barcode")
      return (a.barcode || "").localeCompare(b.barcode || "");
    if (sortBy === "date")
      return (b.lastestAt?.seconds || 0) - (a.lastestAt?.seconds || 0);
    return 0;
  });

  currentPage = 1;
  renderProducts();
}

function renderProducts() {
  productList.innerHTML = "";
  pagination.innerHTML = "";

  const start = (currentPage - 1) * itemsPerPage;
  const currentItems = filteredProducts.slice(start, start + itemsPerPage);

  currentItems.forEach((p) => {
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <div class="name">${escapeHtml(p.name || "")}</div>
      <div class="price">${(p.price || 0).toLocaleString()} 포인트</div>
      <div class="barcode">바코드: ${escapeHtml(p.barcode || "")}</div>
      <div>
        <button class="edit" data-id="${
          p.id
        }"><i class="fas fa-pen"></i> 수정</button>
        <button class="delete-btn" data-id="${
          p.id
        }"><i class="fas fa-trash"></i> 삭제</button>
      </div>
    `;
    productList.appendChild(card);
  });

  const totalPages = Math.ceil(filteredProducts.length / itemsPerPage);
  for (let i = 1; i <= totalPages; i++) {
    const btn = document.createElement("button");
    btn.innerText = i;
    if (i === currentPage) btn.classList.add("active");
    btn.addEventListener("click", () => {
      currentPage = i;
      renderProducts();
    });
    pagination.appendChild(btn);
  }
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
  applyFiltersAndSort();
});

document.getElementById("reset-btn").addEventListener("click", async () => {
  document.getElementById("product-name").value = "";
  document.getElementById("product-barcode").value = "";
  document.getElementById("sort-select").value = "price";
  await loadProducts();
  showToast(`초기화 완료 <i class='fas fa-check'></i>`);
});

document
  .getElementById("product-form")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("product-name").value.trim();
    const price = toInt(document.getElementById("product-price").value);
    const barcode = document.getElementById("product-barcode").value.trim();
    const createdAt = serverTimestamp();
    const lastestAt = serverTimestamp();

    if (!name || !barcode || !isValidPrice(price)) {
      showToast("상품명, 바코드는 필수이며 가격은 1 이상이어야 합니다.", true);
      return;
    }

    // 중복 바코드 검사
    const duplicate = allProducts.find((p) => p.barcode === barcode);
    if (duplicate) {
      showToast("⚠ 이미 등록된 바코드입니다.", true);
      return;
    }

    await addDoc(productsCol, { name, price, barcode, createdAt, lastestAt });
    e.target.reset();
    await loadProducts();
  });

productList.addEventListener("click", async (e) => {
  const id = e.target.dataset.id;
  if (e.target.classList.contains("delete-btn")) {
    if (confirm("정말 삭제하시겠습니까?")) {
      await deleteDoc(doc(db, "products", id));
      await loadProducts();
    }
  }
  if (e.target.classList.contains("edit")) {
    const product = allProducts.find((p) => p.id === id);
    if (!product) return;
    document.getElementById("edit-name").value = product.name;
    document.getElementById("edit-price").value = product.price;
    document.getElementById("edit-barcode").value = product.barcode;
    editingProductId = id;
    document.getElementById("edit-modal").classList.remove("hidden");
  }
});

document.getElementById("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("edit-name").value.trim();
  const price = toInt(document.getElementById("edit-price").value);
  const barcode = document.getElementById("edit-barcode").value.trim();
  const updatedAt = serverTimestamp();
  const lastestAt = serverTimestamp();

  if (!name || !barcode || !isValidPrice(price)) {
    showToast("수정값을 확인하세요.", true);
    return;
  }

  const ref = doc(db, "products", editingProductId);
  await updateDoc(ref, { name, price, barcode, updatedAt, lastestAt });

  document.getElementById("edit-modal").classList.add("hidden");
  editingProductId = null;
  await loadProducts();
});

document.getElementById("cancel-btn").addEventListener("click", () => {
  document.getElementById("edit-modal").classList.add("hidden");
  editingProductId = null;
});

/* ---------------------------
   엑셀 업로드 (신규)
--------------------------- */
const $file = document.getElementById("excel-file-input");
const $parseBtn = document.getElementById("excel-parse-btn");
const $importBtn = document.getElementById("excel-import-btn");
const $tmplBtn = document.getElementById("excel-template-btn");
const $preview = document.getElementById("excel-preview");
const $progress = document.getElementById("excel-progress");
const $updateDup = document.getElementById("excel-update-duplicates");

$tmplBtn.addEventListener("click", downloadTemplate);
$parseBtn.addEventListener("click", handleParse);
$importBtn.addEventListener("click", handleImport);

/** 템플릿 다운로드 (.xlsx) */
function downloadTemplate() {
  /* global XLSX */
  const ws = XLSX.utils.aoa_to_sheet([
    ["name", "price", "barcode"],
    ["콜라 500ml", 1200, "8801234567890"],
    ["초코파이", 500, "8809876543210"],
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
        (r) => `${escapeHtml(r.name)} / ${r.price} / ${escapeHtml(r.barcode)}`
      )
      .join("<br/>");
    $preview.innerHTML = `
      <div>미리보기: ${msg}</div>
      <div style="margin-top:6px; font-family:ui-monospace,Menlo,Consolas,monospace; color:#333;">${sample}</div>
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

  // 최신 목록 로드(중복 검사용)
  await loadProducts();
  const byBarcode = new Map(
    allProducts.map((p) => [String(p.barcode || ""), p])
  );

  const doUpdate = $updateDup.checked;
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
          if (doUpdate) {
            const ref = doc(db, "products", existing.id);
            batch.update(ref, {
              name: row.name,
              price: row.price,
              barcode: row.barcode,
              updatedAt: ts,
              lastestAt: ts,
            });
            updated++;
          } else {
            skipped++;
          }
        } else {
          const ref = doc(productsCol); // 랜덤 ID
          batch.set(ref, {
            name: row.name,
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

    await loadProducts();
    $progress.textContent = `완료: 추가 ${created.toLocaleString()} · 업데이트 ${updated.toLocaleString()} · 스킵 ${skipped.toLocaleString()}`;
    showToast(
      `엑셀 업로드 완료 (${created} 추가 / ${updated} 업데이트 / ${skipped} 스킵)`
    );
  } catch (e) {
    console.error(e);
    showToast("엑셀 업로드 중 오류가 발생했습니다.", true);
    $progress.textContent = "실패";
  } finally {
    $importBtn.disabled = false;
    $parseBtn.disabled = false;
  }
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
 *  허용 헤더: name/상품명, price/가격, barcode/바코드
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
    const barcode = String(obj.barcode ?? obj["바코드"] ?? "").trim();
    const priceRaw = obj.price ?? obj["가격"];
    const price = toInt(priceRaw);

    if (!name || !barcode || !isValidPrice(price)) {
      issues.push({ name, price: priceRaw, barcode, reason: "필수/형식 오류" });
      continue;
    }
    valid.push({ name, price, barcode });
  }

  // 파일 내 바코드 중복 → 마지막 값으로 사용 (또는 건너뛰기 전략 가능)
  const seen = new Map();
  for (const r of valid) seen.set(r.barcode, r); // 마지막 승리
  return { valid: Array.from(seen.values()), issues };
}

function toInt(v) {
  if (typeof v === "number") return Math.round(v);
  if (typeof v === "string") return Math.round(parseFloat(v.replace(/,/g, "")));
  return NaN;
}
function isValidPrice(n) {
  return Number.isFinite(n) && n > 0;
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
  const searchInput = document.getElementById("global-search");
  if (searchInput) {
    searchInput.focus();
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        document.getElementById("search-btn")?.click();
      }
    });
  }
  loadProducts();
});

document.getElementById("sort-select").addEventListener("change", () => {
  applyFiltersAndSort();
});
