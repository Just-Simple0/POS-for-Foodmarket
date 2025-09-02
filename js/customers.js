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
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { showToast } from "./components/comp.js";

// 🔍 검색용 메모리 저장
let customerData = [];

let currentPage = 1;
const itemPerPage = 50;

let displaydData = [];
let currentSort = { field: null, direction: "asc" };

let pendingCreatePayload = null;
let pendingDupRef = null;
let pendingDupData = null;
let editingOriginal = null;

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

  // 입력 중 자동 포맷팅(직접 입력 탭)
  const birth = document.getElementById("create-birth");
  birth?.addEventListener(
    "input",
    () => (birth.value = formatBirth(birth.value))
  );
  birth?.addEventListener(
    "blur",
    () => (birth.value = formatBirth(birth.value, true))
  );
  const phone = document.getElementById("create-phone");
  phone?.addEventListener(
    "input",
    () => (phone.value = formatMultiPhones(phone.value))
  );
  phone?.addEventListener(
    "blur",
    () => (phone.value = formatMultiPhones(phone.value, true))
  );

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
  const payload = {
    name: val("#create-name"),
    birth: formatBirth(val("#create-birth"), true),
    gender: val("#create-gender"),
    status: val("#create-status") || "지원",
    region1: val("#create-region1"),
    address: val("#create-address"),
    phone: formatMultiPhones(val("#create-phone"), true),
    type: val("#create-type"),
    category: val("#create-category"),
    note: val("#create-note"),
    updatedAt: new Date().toISOString(),
    updatedBy: email,
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
    await logEvent("customer_add", {
      target: id,
      name: payload.name,
      birth: payload.birth,
      status: payload.status,
    });
  } else {
    if (!confirm("관리자의 승인이 필요한 사항입니다. 승인을 요청하시겠습니까?"))
      return;
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
  const base = collection(db, "customers");
  // 규칙과 일치하도록 쿼리 단계에서 필터링
  const q = isAdmin ? query(base) : query(base, where("status", "==", "지원"));
  const snap = await getDocs(q);
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  customerData = rows;
  displaydData = rows;
  renderTable(rows);
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
      <td class="td-admin-only ${
        c.status === "지원" ? "status-green" : "status-red"
      }">${c.status || ""}</td>
      <td>${c.region1 || ""}</td>
      <td>${c.address || ""}</td>
      <td>${c.phone || ""}</td>
      <td class="td-admin-only">${c.type || ""}</td>
      <td class="td-admin-only">${c.category || ""}</td>
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
  editingOriginal = { ...customer }; // 편집 취소 시 복원용
  const idInput = document.getElementById("edit-id");
  if (idInput) idInput.value = customer.id || "";
  document.getElementById("edit-name").value = customer.name || "";
  document.getElementById("edit-birth").value = customer.birth || "";
  document.getElementById("edit-region1").value = customer.region1 || "";
  document.getElementById("edit-address").value = customer.address || "";
  document.getElementById("edit-phone").value = customer.phone || "";
  document.getElementById("edit-type").value = customer.type || "";
  document.getElementById("edit-category").value = customer.category || "";
  document.getElementById("edit-note").value = customer.note || "";

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
    birth: formatBirth(document.getElementById("edit-birth").value, true),
    gender:
      document.querySelector("#gender-select .selected")?.dataset.value || "",
    status:
      document.querySelector("#status-select .selected")?.dataset.value || "",
    address: document.getElementById("edit-address").value,
    phone: formatMultiPhones(document.getElementById("edit-phone").value, true),
    type: document.getElementById("edit-type").value,
    category: document.getElementById("edit-category").value,
    note: document.getElementById("edit-note").value,
    updatedAt: new Date().toISOString(),
    updatedBy: email,
  };

  if (isAdmin) {
    await updateDoc(ref, updateData);
    showToast("수정되었습니다");
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
    if (!confirm("관리자의 승인이 필요한 사항입니다. 승인을 요청하시겠습니까?"))
      return;
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
  await loadCustomers();
});

document.getElementById("close-edit-modal")?.addEventListener("click", () => {
  document.getElementById("edit-modal").classList.add("hidden");
});

function updateSortIcons() {
  const ths = document.querySelectorAll("#customers-thead th");
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

// 초기 로딩: 인증 준비(onAuthStateChanged) 후 역할/목록 로드
document.addEventListener("DOMContentLoaded", () => {
  onAuthStateChanged(auth, async (user) => {
    await applyRoleFromUser(user);
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
});

// ===== 삭제 =====
document.addEventListener("click", async (e) => {
  const del = e.target.closest("[data-del]");
  if (!del) return;
  if (isAdmin) {
    if (!confirm("이 이용자를 삭제하시겠습니까?")) return;
    await deleteDoc(doc(db, "customers", del.dataset.del));
    showToast("삭제되었습니다");
    await logEvent("customer_delete", { targetId: del.dataset.del });
    await loadCustomers();
  } else {
    if (!confirm("관리자의 승인이 필요한 사항입니다. 승인을 요청하시겠습니까?"))
      return;
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
    preview.textContent = `총 ${total}건 · 신규 ${newCnt}건 · 중복 ${dup}건`;
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
      showToast("업로드가 완료되었습니다");
      await logEvent("customer_add", { mode: "bulk", count: dryRows.length });
      await loadCustomers();
    } else {
      // 비관리자: 승인요청으로 전환
      if (
        !confirm(
          "관리자의 승인이 필요한 사항입니다. 승인요청을 보내시겠습니까?"
        )
      )
        return;
      await setDoc(doc(collection(db, "approvals")), {
        type: "customer_bulk_upload",
        payload: { rows: dryRows, options: lastOptions },
        requestedBy: auth.currentUser?.email || "",
        requestedAt: Timestamp.now(),
        approved: false,
      });
      showToast("업로드 승인 요청이 전송되었습니다");
      await logEvent("approval_request", {
        approvalType: "customer_bulk_upload",
        count: dryRows.length,
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
    const telCell = pick(row, "전화", "연락처", "집", "연락처1"); // 유선
    const hpCell = pick(row, "핸드폰", "휴대폰", "모바일", "연락처2"); // 휴대폰
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
    if (!birth) continue; // 생년월일은 필수

    // 상태 기본값(옵션/파일명 기반)
    if (!status) {
      if (opts.statusMode === "all-support") status = "지원";
      else if (opts.allowMissingStatus) status = "지원";
    }

    // 연락처 파싱: 대표 1개  보조 1개
    const p = parsePhonesPrimarySecondary(telCell, hpCell);
    const phoneDisplay = p.display; // "010-.... / 053-...." 형식

    out.push({
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
    });
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
    if (!confirm("관리자의 승인이 필요한 사항입니다. 승인을 요청하시겠습니까?"))
      return;
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
    if (!confirm("관리자의 승인이 필요한 사항입니다. 승인을 요청하시겠습니까?"))
      return;
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
function formatBirth(v, strict = false) {
  const d = String(v || "")
    .replace(/\D/g, "")
    .slice(0, 8);
  if (d.length <= 4) return d;
  if (d.length <= 6) return `${d.slice(0, 4)}.${d.slice(4)}`;
  return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}`;
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
