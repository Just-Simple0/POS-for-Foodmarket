import { db, auth } from "./components/firebase-config.js";
import {
  collection,
  setDoc,
  doc,
  getDocs,
  query,
  Timestamp,
  updateDoc,
  deleteDoc,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { showToast } from "./components/comp.js";

// 🔍 검색용 메모리 저장
let customerData = [];

let currentPage = 1;
const itemPerPage = 50;

let displaydData = [];
let currentSort = { field: null, direction: "asc" };

// ===== 권한/역할 감지 & UI 토글 =====
let isAdmin = false;
async function detectRole() {
  const user = auth.currentUser;
  if (!user) return;
  const token = await user.getIdTokenResult().catch(() => null);
  const role = token?.claims?.role || "pending";
  isAdmin = role === "admin" || role === "manager";
  document.documentElement.classList.toggle("is-admin", isAdmin);
}

// ===== 등록하기 모달 바인딩 =====
function bindToolbarAndCreateModal() {
  // 툴바
  document
    .getElementById("btn-customer-create")
    .addEventListener("click", () => openCreateModal());
  document
    .getElementById("btn-export-xlsx")
    .addEventListener("click", exportXlsx);
  // 모달 열고/닫기
  const modal = document.getElementById("customer-create-modal");
  const closeAll = () => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  };
  document
    .getElementById("create-modal-close")
    .addEventListener("click", closeAll);
  document
    .getElementById("create-modal-close2")
    .addEventListener("click", closeAll);
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
}
function openCreateModal() {
  const modal = document.getElementById("customer-create-modal");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}
async function saveCreateDirect() {
  const email = auth.currentUser?.email || "unknown";
  const payload = {
    name: val("#create-name"),
    birth: val("#create-birth"),
    gender: val("#create-gender"),
    status: isAdmin ? val("#create-status") || "지원" : "지원",
    region1: val("#create-region1"),
    address: val("#create-address"),
    phone: val("#create-phone"),
    type: isAdmin ? val("#create-type") : "",
    category: isAdmin ? val("#create-category") : "",
    note: val("#create-note"),
    updatedAt: new Date().toISOString(),
    updatedBy: email,
  };
  if (!payload.name || !payload.birth) {
    return showToast("이용자명/생년월일은 필수입니다.", true);
  }
  // 문서ID를 name_birth 정규화 조합으로 생성(중복시 덮어쓰기)
  const id = slugId(payload.name, payload.birth);
  await setDoc(doc(collection(db, "customers"), id), payload);
  showToast("등록되었습니다");
  document.getElementById("customer-create-modal").classList.add("hidden");
  await loadCustomers();
}
function val(sel) {
  const el = document.querySelector(sel);
  return el ? el.value.trim() : "";
}
function slugId(name, birth) {
  return `${(name || "").trim()}_${(birth || "").replace(/[.\-]/g, "")}`;
}

async function loadCustomers() {
  const ref = collection(db, "customers");
  const snapshot = await getDocs(query(ref));
  const data = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  // 비관리자: status !== "지원"은 화면에서 베제
  const filtered = isAdmin
    ? data
    : data.filter((d) => (d.status || "") === "지원");
  customerData = filtered;
  displaydData = filtered;
  renderTable(filtered);
  updateSortIcons();
}

function renderTable(data) {
  const tbody = document.querySelector("#customer-table tbody");
  tbody.innerHTML = "";

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

  const start = (currentPage - 1) * itemPerPage;
  const end = start + itemPerPage;
  const paginated = sorted.slice(start, end);

  paginated.forEach((c) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${c.name || ""}</td>
      <td>${c.birth || ""}</td>
      <td>${c.gender || ""}</td>
      <td class="admin-only ${
        c.status === "지원" ? "status-green" : "status-red"
      }">${c.status || ""}</td>
      <td>${c.region1 || ""}</td>
      <td>${c.address || ""}</td>
      <td>${c.phone || ""}</td>
      <td class="admin-only">${c.type || ""}</td>
      <td class="admin-only">${c.category || ""}</td>
      <td>
        ${c.note || ""}
        <span class="row-actions">
          <button class="icon-btn" title="수정" data-edit="${
            c.id
          }"><i class="fas fa-edit"></i></button>
          <button class="icon-btn ${
            isAdmin ? "" : "admin-only"
          }" title="삭제" data-del="${
      c.id
    }"><i class="fas fa-trash-alt"></i></button>
        </span>
      </td>
    `;
    if (!isAdmin) {
      tr.querySelectorAll(".admin-only").forEach(
        (el) => (el.style.display = "none")
      );
    }
    tr.addEventListener("dblclick", () => openEditModal(c));

    tbody.appendChild(tr);
  });

  renderPagination(sorted.length);
}

function renderPagination(totalItems) {
  const totalPages = Math.ceil(totalItems / itemPerPage);
  const container = document.getElementById("pagination");

  container.innerHTML = `
    <button ${currentPage === 1 ? "disabled" : ""} id="prev-btn">이전</button>
    <span> ${currentPage} / ${totalPages} </span>
    <button ${
      currentPage === totalPages ? "disabled" : ""
    } id="next-btn">다음</button>
  `;

  document.getElementById("prev-btn")?.addEventListener("click", () => {
    currentPage--;
    renderTable(displaydData);
  });

  document.getElementById("next-btn").addEventListener("click", () => {
    currentPage++;
    renderTable(displaydData);
  });
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
  "note",
];
document.querySelectorAll("#customers-thead th").forEach((th, index) => {
  const field = fieldMap[index];

  th.style.cursor = "pointer";
  th.addEventListener("click", () => {
    if (currentSort.field === field) {
      currentSort.direction = currentSort.direction === "asc" ? "desc" : "asc";
    } else {
      currentSort.field = field;
      currentSort.direction = "asc";
    }
    renderTable(displaydData);
    updateSortIcons();
  });
});

function initCustomSelect(id, inputId = null) {
  const select = document.getElementById(id);
  const selected = select.querySelector(".selected");
  const options = select.querySelector(".options");
  const input = inputId ? document.getElementById(inputId) : null;

  if (selected) {
    selected.addEventListener("click", () => {
      options.classList.toggle("hidden");
    });

    options.querySelectorAll("div").forEach((opt) => {
      opt.addEventListener("click", () => {
        selected.textContent = opt.textContent;
        selected.dataset.value = opt.dataset.value;
        options.classList.add("hidden");
      });
    });
  }

  if (input) {
    options.querySelectorAll("div").forEach((opt) => {
      opt.addEventListener("click", () => {
        input.value = opt.dataset.value;
        options.classList.add("hidden");
      });
    });
    input.addEventListener("focus", () => options.classList.remove("hidden"));
    input.addEventListener("blur", () =>
      setTimeout(() => options.classList.add("hidden"), 150)
    );
  }
}

// 초기화
initCustomSelect("gender-select");
initCustomSelect("status-select");
initCustomSelect("type-select", "edit-type");
initCustomSelect("category-select", "edit-category");

// 모달 열기 시 데이터 설정
function openEditModal(customer) {
  document.getElementById("edit-id").value = customer.id;
  document.getElementById("edit-name").value = customer.name || "";
  document.getElementById("edit-birth").value = customer.birth || "";
  document.getElementById("edit-address").value = customer.address || "";
  document.getElementById("edit-phone").value = customer.phone || "";
  document.getElementById("edit-type").value = customer.type || "";
  document.getElementById("edit-category").value = customer.category || "";

  // 커스텀 select 초기화
  const genderSel = document.querySelector("#gender-select .selected");
  const statusSel = document.querySelector("#status-select .selected");
  genderSel.textContent = customer.gender || "선택";
  genderSel.dataset.value = customer.gender || "";
  statusSel.textContent = customer.status || "선택";
  statusSel.dataset.value = customer.status || "";

  document.getElementById("edit-modal").classList.remove("hidden");
}

// 저장 시 반영
document.getElementById("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("edit-id").value;
  const email = auth.currentUser?.email || "unknown";

  const ref = doc(db, "customers", id);
  const updateData = {
    name: document.getElementById("edit-name").value,
    birth: document.getElementById("edit-birth").value,
    gender:
      document.querySelector("#gender-select .selected")?.dataset.value || "",
    status:
      document.querySelector("#status-select .selected")?.dataset.value || "",
    address: document.getElementById("edit-address").value,
    phone: document.getElementById("edit-phone").value,
    type: document.getElementById("edit-type").value,
    category: document.getElementById("edit-category").value,
    updatedAt: new Date().toISOString(),
    updatedBy: email,
  };

  await setDoc(ref, updateData);
  document.getElementById("edit-modal").classList.add("hidden");
  await loadCustomers();
});

document.getElementById("close-edit-modal")?.addEventListener("click", () => {
  document.getElementById("edit-modal").classList.add("hidden");
});

function updateSortIcons() {
  const ths = document.querySelectorAll("#customer-thead th");
  const arrows = { asc: "▲", desc: "▼" };
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
    "note",
  ];

  ths.forEach((th, index) => {
    const field = fieldMap[index];
    th.classList.remove("sort-asc", "sort-desc");
    if (field === currentSort.field)
      th.classList.add(
        currentSort.direction === "asc" ? "sort-asc" : "sort-desc"
      );
    th.textContent = th.dataset.label;
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

function filterAndRender() {
  const globalKeyword = normalize(
    document.getElementById("global-search").value
  );
  const field = document.getElementById("field-select").value;
  const fieldValue = normalize(document.getElementById("field-search").value);
  const exactMatch = document.getElementById("exact-match").checked;

  const filtered = customerData.filter((c) => {
    const normalizeValue = (val) => normalize(val);

    // ✅ 전체 필드 통합 검색
    const matchesGlobal =
      !globalKeyword ||
      Object.values(c).some((v) =>
        exactMatch
          ? normalizeValue(v) === globalKeyword
          : normalizeValue(v).includes(globalKeyword)
      );

    // ✅ 필드 선택 검색
    const matchesField =
      !field ||
      !fieldValue ||
      (exactMatch
        ? normalizeValue(c[field]) === fieldValue
        : normalizeValue(c[field]).includes(fieldValue));

    return matchesGlobal && matchesField;
  });

  displaydData = filtered;
  currentPage = 1;
  renderTable(displaydData);
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
  .getElementById("global-search")
  .addEventListener("input", filterAndRender);
document
  .getElementById("exact-match")
  .addEventListener("change", filterAndRender);
document
  .getElementById("field-select")
  .addEventListener("change", filterAndRender);
document
  .getElementById("field-search")
  .addEventListener("input", filterAndRender);

// 초기 로딩 및 검색 필드 포커스
document.addEventListener("DOMContentLoaded", async () => {
  await detectRole();
  bindToolbarAndCreateModal();
  const searchInput = document.getElementById("global-search");
  if (searchInput) {
    searchInput.focus();
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        filterAndRender();
      }
    });
  }
  loadCustomers();
});

// ===== 삭제 =====
document.addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (!del) return;
  if (!isAdmin) return showToast("삭제 권한이 없습니다.", true);
  if (!confirm("이 이용자를 삭제하시겠습니까?")) return;
  await deleteDoc(doc(db, "customers", del.dataset.del));
  showToast("삭제되었습니다");
  await loadCustomers();
});

// ===== 업로드 탭(옵션: 상태 필드 없어도 허용 / 모두 ‘지원’) & 미리보기/실행 =====
function bindUploadTab() {
  const modal = document.getElementById("customer-create-modal");
  const fileEl = modal.querySelector("#upload-file");
  const preview = modal.querySelector("#upload-preview");
  const dryBtn = modal.querySelector("#btn-upload-dryrun");
  const execBtn = modal.querySelector("#btn-upload-exec");
  let dryRows = null;

  dryBtn.addEventListener("click", async () => {
    const f = fileEl.files?.[0];
    if (!f) return showToast("파일을 선택하세요.", true);
    dryRows = await parseAndNormalizeExcel(f, {
      allowMissingStatus: modal.querySelector("#opt-allow-missing-status")
        .checked,
      statusMode:
        modal.querySelector("input[name='opt-status-mode']:checked")?.value ||
        "none",
    });
    const total = dryRows.length;
    const keys = new Set(dryRows.map((r) => slugId(r.name, r.birth)));
    // 기존 문서 조회(간단히 전체 fetch 후 포함여부 판단 — 현 구조 유지)
    const all = (await getDocs(query(collection(db, "customers")))).docs.map(
      (d) => d.id
    );
    let dup = 0;
    keys.forEach((k) => {
      if (all.includes(k)) dup++;
    });
    const newCnt = total - dup;
    preview.textContent = `총 ${total}건 · 신규 ${newCnt}건 · 중복 ${dup}건`;
    execBtn.disabled = false;
  });

  execBtn.addEventListener("click", async () => {
    if (!dryRows) return;
    const email = auth.currentUser?.email || "unknown";
    for (const r of dryRows) {
      const id = slugId(r.name, r.birth);
      await setDoc(
        doc(collection(db, "customers"), id),
        { ...r, updatedAt: new Date().toISOString(), updatedBy: email },
        { merge: true }
      );
    }
    showToast("업로드가 완료되었습니다");
    await loadCustomers();
  });
}

async function parseAndNormalizeExcel(file, opts) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);
  const out = [];
  for (const row of rows) {
    const rec = {
      name: row["이용자명"] || row["이름"] || "",
      birth: row["생년월일"] || row["birth"] || "",
      gender: row["성별"] || "",
      status: row["상태"] || "",
      region1: row["행정구역"] || "",
      address: row["주소"] || "",
      phone: row["전화번호"] || row["전화"] || "",
      type: row["이용자구분"] || "",
      category: row["이용자분류"] || "",
      note: row["비고"] || "",
    };
    if (!rec.name || !rec.birth) continue; // 필수
    if (!rec.status && opts.allowMissingStatus) rec.status = "지원";
    if (opts.statusMode === "all-support") rec.status = "지원";
    out.push(rec);
  }
  return out;
}

// ===== 내보내기 =====
async function exportXlsx() {
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
}
function dateStamp() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(
    d.getHours()
  )}${z(d.getMinutes())}`;
}
