import { db, auth } from "./components/firebase-config.js";
import {
  collection,
  setDoc,
  doc,
  getDocs,
  query,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// 🔍 검색용 메모리 저장
let customerData = [];

let currentPage = 1;
const itemPerPage = 50;

let displaydData = [];
let currentSort = { field: null, direction: "asc" };

document.getElementById("open-modal-btn").addEventListener("click", () => {
  document.getElementById("upload-modal").classList.remove("hidden");
});

document.getElementById("close-upload-modal").addEventListener("click", () => {
  document.getElementById("upload-modal").classList.add("hidden");
});

document.getElementById("upload-btn").addEventListener("click", async () => {
  const input = document.getElementById("file-upload");
  if (!input.files.length) return alert("파일을 선택하세요.");

  const reader = new FileReader();
  reader.onload = async function (e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: "array" });

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    await uploadToFirestore(rows);
    document.getElementById("upload-modal").classList.add("hidden");
    loadCustomers();
    alert("업로드 완료!");
  };
  reader.readAsArrayBuffer(input.files[0]);
});

async function uploadToFirestore(data) {
  const ref = collection(db, "customers");
  const user = auth.currentUser;
  const email = user?.email || "unknown";

  for (const row of data) {
    if (!row["이용자ID"]) continue;

    const payload = {
      name: row["이용자명"] || "",
      birth: row["생년월일"] || "",
      gender: row["성별"] || "",
      status: row["상태"] || "",
      address: row["주소"] || "",
      phone: row["전화번호"] || "",
      type: row["이용자구분"] || "",
      category: row["이용자분류"] || "",
      updateAt: new Date().toISOString(),
      updatedBy: email,
    };

    await setDoc(doc(ref, row["이용자ID"].toString()), payload);
  }
}

async function loadCustomers() {
  const ref = collection(db, "customers");
  const snapshot = await getDocs(query(ref));
  const data = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));
  customerData = data;
  displaydData = data;
  renderTable(data);
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
      <td>${c.id}</td>
      <td>${c.name}</td>
      <td>${c.birth}</td>
      <td>${c.gender}</td>
      <td class="${c.status === "지원" ? "status-green" : "status-red"}">${
      c.status
    }</td>
      <td>${c.address}</td>
      <td>${c.phone}</td>
      <td>${c.type}</td>
      <td>${c.category}</td>
    `;

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

const fieldMap = [
  "id",
  "name",
  "birth",
  "gender",
  "status",
  "address",
  "phone",
  "type",
  "category",
];
document.querySelectorAll("#customer-table thead th").forEach((th, index) => {
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
  const ths = document.querySelectorAll("#customer-table thead th");
  const arrows = { asc: "▲", desc: "▼" };
  const fieldMap = [
    "id",
    "name",
    "birth",
    "gender",
    "status",
    "address",
    "phone",
    "type",
    "category",
  ];

  ths.forEach((th, index) => {
    const field = fieldMap[index];
    if (field === currentSort.field) {
      th.innerHTML = `${th.dataset.label} ${arrows[currentSort.direction]}`;
    } else {
      th.innerHTML = `${th.dataset.label}`;
    }
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

// 초기 로딩
loadCustomers();
