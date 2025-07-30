import { db } from "./components/firebase-config.js";
import {
  collection,
  setDoc,
  doc,
  getDocs,
  query,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// 🔍 검색용 메모리 저장
let customerData = [];

let currentPage = 1;
const itemPerPage = 50;
let currentSort = { field: null, direction: "asc" };

document.getElementById("open-modal-btn").addEventListener("click", () => {
  document.getElementById("upload-modal").classList.remove("hidden");
});

document.getElementById("close-modal").addEventListener("click", () => {
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

  for (const row of data) {
    if (!row["이용자ID"]) continue;

    const payload = {
      name: row["이용자명"] || "",
      birth: row["생년월일"] || "",
      gender: row["성별"] || "",
      type: row["이용자구분"] || "",
      category: row["이용자분류"] || "",
      address: row["주소"] || "",
      phone: row["전화번호"] || "",
      status: row["상태"] || "",
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
  renderTable(data);
  updateSortIcons();
}

function renderTable(data) {
  const tbody = document.querySelector("#customer-table tbody");
  tbody.innerHTML = "";

  let sorted = [...data];

  if (currentSort.field) {
    sorted.sort((a, b) => {
      const valA = a[currentSort.field] || "";
      const valB = b[currentSort.field] || "";
      return currentSort.direction === "asc"
        ? valA.localeCompare(valB, "ko", { numeric: true })
        : valB.localeCompare(valA, "ko", { numeric: true });
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
      <td>${c.type}</td>
      <td>${c.category}</td>
      <td>${c.address}</td>
      <td>${c.phone}</td>
      <td>${c.status}</td>
    `;
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
    renderTable(customerData);
  });

  document.getElementById("next-btn").addEventListener("click", () => {
    currentPage++;
    renderTable(customerData);
  });
}

const fieldMap = [
  "id",
  "name",
  "birth",
  "gender",
  "type",
  "category",
  "address",
  "phone",
  "status",
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
    renderTable(customerData);
    updateSortIcons();
  });
});

function updateSortIcons() {
  const ths = document.querySelectorAll("#customer-table thead th");
  const arrows = { asc: "▲", desc: "▼" };
  const fieldMap = [
    "id",
    "name",
    "birth",
    "gender",
    "type",
    "category",
    "address",
    "phone",
    "status",
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

  const filtered = customerData.filter((c) => {
    // ✅ 전체 필드 통합 검색
    const matchesGlobal =
      !globalKeyword ||
      Object.values(c).some((v) => normalize(v).includes(globalKeyword));

    // ✅ 필드 선택 검색
    const matchesField =
      !field || !fieldValue || normalize(c[field]).includes(fieldValue);

    return matchesGlobal && matchesField;
  });

  currentPage = 1;
  renderTable(filtered);
}

document
  .getElementById("global-search")
  .addEventListener("input", filterAndRender);
document
  .getElementById("field-select")
  .addEventListener("change", filterAndRender);
document
  .getElementById("field-search")
  .addEventListener("input", filterAndRender);

// 초기 로딩
loadCustomers();
