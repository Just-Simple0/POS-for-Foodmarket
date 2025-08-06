import { db, auth } from "./components/firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  collection,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

let provisionData = [];
let visitData = [];
let provisionCurrentPage = 1;
let visitCurrentPage = 1;
let itemsPerPage = 20;

function getCurrentPeriodKey(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  let startYear = month >= 3 ? year : year - 1;
  let endYear = startYear + 1;
  return `${String(startYear).slice(2)}-${String(endYear).slice(2)}`;
}
document.addEventListener("DOMContentLoaded", async () => {
  generateYearOptions();
  await renderTopStatistics();
  calculateMonthlyVisitRate();
  await loadProvisionHistory("daily");
  await loadVisitLogTable(getCurrentPeriodKey());

  const btnProvision = document.getElementById("btn-provision");
  const btnVisit = document.getElementById("btn-visit");
  const periodFilter = document.getElementById("period-filter");
  const yearSelect = document.getElementById("year-range-select");
  const provisionSection = document.getElementById("provision-section");
  const visitSection = document.getElementById("visit-log-section");
  const itemCountSelect = document.getElementById("item-count-select");
  const searchProvision = document.getElementById("search-provision");
  const searchVisit = document.getElementById("search-visit");

  btnProvision.addEventListener("click", () => {
    btnProvision.classList.add("active");
    btnVisit.classList.remove("active");
    provisionSection.classList.remove("hidden");
    visitSection.classList.add("hidden");
    periodFilter.classList.remove("hidden");
    if (periodFilter.value === "yearly") {
      yearSelect.classList.remove("hidden");
      loadProvisionHistory("yearly", yearSelect.value);
    } else {
      yearSelect.classList.add("hidden");
      loadProvisionHistory(periodFilter.value);
    }
  });

  btnVisit.addEventListener("click", () => {
    btnProvision.classList.remove("active");
    btnVisit.classList.add("active");
    provisionSection.classList.add("hidden");
    visitSection.classList.remove("hidden");
    periodFilter.classList.add("hidden");
    yearSelect.classList.remove("hidden");
    loadVisitLogTable(yearSelect.value);
  });

  periodFilter.addEventListener("change", (e) => {
    const value = e.target.value;
    if (value === "yearly") {
      yearSelect.classList.remove("hidden");
      loadProvisionHistory("yearly", yearSelect.value);
    } else {
      yearSelect.classList.add("hidden");
      loadProvisionHistory(value);
    }
  });

  yearSelect.addEventListener("change", (e) => {
    if (btnProvision.classList.contains("active")) {
      loadProvisionHistory("yearly", e.target.value);
    } else {
      loadVisitLogTable(e.target.value);
    }
  });

  itemCountSelect.addEventListener("change", (e) => {
    itemsPerPage = parseInt(e.target.value);
    if (btnProvision.classList.contains("active")) {
      renderProvisionTable();
    } else {
      renderVisitTable();
    }
  });

  searchProvision.addEventListener("input", renderProvisionTable);
  searchVisit.addEventListener("input", renderVisitTable);
});

async function renderTopStatistics() {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const currentYearMonth = todayStr.slice(0, 7);
  const periodKey = getCurrentPeriodKey(today);

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  let todayVisit = 0,
    yesterdayVisit = 0,
    monthlyVisit = 0;

  const customersSnap = await getDocs(collection(db, "customers"));
  customersSnap.forEach((doc) => {
    const data = doc.data();
    if (data.status !== "지원") return;
    const visits = data.visits?.[periodKey] || [];
    if (visits.includes(todayStr)) todayVisit++;
    if (visits.includes(yesterdayStr)) yesterdayVisit++;
    if (visits.some((v) => v.startsWith(currentYearMonth))) monthlyVisit++;
  });

  updateCard("#daily-visitors", todayVisit, yesterdayVisit, "명");
  document.querySelector(
    "#monthly-visitors .value"
  ).textContent = `${monthlyVisit}명`;

  const todayStart = Timestamp.fromDate(new Date(todayStr + "T00:00:00"));
  const todayEnd = Timestamp.fromDate(new Date(todayStr + "T23:59:59"));
  const yStart = Timestamp.fromDate(new Date(yesterdayStr + "T00:00:00"));
  const yEnd = Timestamp.fromDate(new Date(yesterdayStr + "T23:59:59"));

  let todayItems = 0,
    yesterdayItems = 0;

  const todaySnap = await getDocs(
    query(
      collection(db, "provisions"),
      where("timestamp", ">=", todayStart),
      where("timestamp", "<=", todayEnd)
    )
  );
  todaySnap.forEach((doc) => {
    const data = doc.data();
    (data.items || []).forEach((item) => (todayItems += item.quantity));
  });

  const ySnap = await getDocs(
    query(
      collection(db, "provisions"),
      where("timestamp", ">=", yStart),
      where("timestamp", "<=", yEnd)
    )
  );
  ySnap.forEach((doc) => {
    const data = doc.data();
    (data.items || []).forEach((item) => (yesterdayItems += item.quantity));
  });

  updateCard("#daily-items", todayItems, yesterdayItems, "개");
}

function updateCard(selector, todayVal, yesterVal, unit = "") {
  const card = document.querySelector(selector);
  const valueEl = card.querySelector(".value");
  valueEl.textContent = `${todayVal}${unit}`;
  const diff = todayVal - yesterVal;
  const percent = yesterVal > 0 ? ((diff / yesterVal) * 100).toFixed(1) : "0";
  let text = "",
    className = "";
  if (diff > 0) {
    text = `▲ ${diff}${unit} (${percent}%) 증가`;
    className = "up";
  } else if (diff < 0) {
    text = `▼ ${Math.abs(diff)}${unit} (${percent}%) 감소`;
    className = "down";
  } else {
    text = `변동 없음`;
  }

  let changeEl = card.querySelector(".change");
  if (!changeEl) {
    changeEl = document.createElement("p");
    changeEl.classList.add("change");
    card.appendChild(changeEl);
  }
  changeEl.textContent = text;
  changeEl.className = "change " + className;
}

async function calculateMonthlyVisitRate() {
  const customersRef = collection(db, "customers");
  const snapshot = await getDocs(customersRef);
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    "0"
  )}`;
  const periodKey = getCurrentPeriodKey(now);
  let supportCustomerCount = 0,
    visitedThisMonthCount = 0;

  snapshot.forEach((doc) => {
    const data = doc.data();
    if (data.status !== "지원") return;
    supportCustomerCount++;
    const visits = data.visits?.[periodKey];
    if (!Array.isArray(visits)) return;
    if (visits.some((dateStr) => dateStr.startsWith(thisMonth)))
      visitedThisMonthCount++;
  });

  const rate =
    supportCustomerCount > 0
      ? ((visitedThisMonthCount / supportCustomerCount) * 100).toFixed(1)
      : "0";
  const rateEl = document.createElement("p");
  rateEl.className = "sub-info";
  rateEl.innerHTML = `<i class="fas fa-chart-pie"></i> 방문률: ${rate}%`;
  const card = document.getElementById("monthly-visitors");
  if (card) card.appendChild(rateEl);
}

async function loadProvisionHistory(period = "daily", yearRange = null) {
  provisionData = [];
  const today = new Date();
  let startDate;
  let endDate = new Date();

  if (period === "daily") {
    startDate = new Date(today);
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);
  } else if (period === "monthly") {
    startDate = new Date(today.getFullYear(), today.getMonth(), 1);
    endDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  } else if (period === "yearly" && yearRange) {
    const [startY, endY] = yearRange.split("-").map((v) => parseInt(v));
    startDate = new Date(`20${startY}-03-01T00:00:00`);
    endDate = new Date(`20${endY}-03-01T00:00:00`);
  } else return;

  const snapshot = await getDocs(query(collection(db, "provisions")));
  snapshot.forEach((doc) => {
    const data = doc.data();
    const ts = data.timestamp?.toDate?.();
    if (!ts || ts < startDate || ts >= endDate) return;
    provisionData.push({
      date: formatDate(ts),
      name: data.customerName,
      birth: data.customerBirth,
      items: data.items.map((i) => `${i.name} (${i.quantity})`).join(", "),
      handler: data.handledBy,
    });
  });

  // timestamp 기준 정렬
  provisionData.sort((a, b) => new Date(b.date) - new Date(a.date));
  provisionCurrentPage = 1;
  renderProvisionTable();
}

function renderProvisionTable() {
  const tbody = document.querySelector("#provision-table tbody");
  const keyword = document
    .getElementById("search-provision")
    .value.trim()
    .toLowerCase();
  tbody.innerHTML = "";

  const filtered = provisionData.filter((row) =>
    Object.values(row).some((v) => v.toLowerCase().includes(keyword))
  );

  const start = (provisionCurrentPage - 1) * itemsPerPage;
  const end = start + itemsPerPage;
  const pageItems = filtered.slice(start, end);

  pageItems.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.date}</td>
      <td>${row.name}</td>
      <td>${row.birth}</td>
      <td>${row.items}</td>
      <td>${row.handler}</td>
    `;
    tbody.appendChild(tr);
  });

  updatePagination("provision", filtered.length, provisionCurrentPage);
}

async function loadVisitLogTable(periodKey) {
  visitData = [];
  const customersSnap = await getDocs(collection(db, "customers"));
  customersSnap.forEach((doc) => {
    const data = doc.data();
    if (data.status !== "지원") return;
    const visits = data.visits?.[periodKey];
    if (!Array.isArray(visits) || visits.length === 0) return;
    visitData.push({
      name: data.name,
      birth: data.birth,
      dates: visits.slice().sort().join(", "),
    });
  });

  // 이름 기준 정렬
  visitData.sort((a, b) => a.name.localeCompare(b.name));
  visitCurrentPage = 1;
  renderVisitTable();
}

function renderVisitTable() {
  const tbody = document.querySelector("#visit-log-table tbody");
  const keyword = document
    .getElementById("search-visit")
    .value.trim()
    .toLowerCase();
  tbody.innerHTML = "";

  const filtered = visitData.filter((row) =>
    Object.values(row).some((v) => v.toLowerCase().includes(keyword))
  );

  const start = (visitCurrentPage - 1) * itemsPerPage;
  const end = start + itemsPerPage;
  const pageItems = filtered.slice(start, end);

  pageItems.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.name}</td>
      <td>${row.birth}</td>
      <td>${row.dates}</td>
    `;
    tbody.appendChild(tr);
  });

  updatePagination("visit", filtered.length, visitCurrentPage);
}

function updatePagination(type, totalItems, currentPage) {
  const container = document.getElementById(`${type}-pagination`);
  container.innerHTML = "";

  const totalPages = Math.ceil(totalItems / itemsPerPage);

  const prevBtn = document.createElement("button");
  prevBtn.textContent = "이전";
  prevBtn.disabled = currentPage === 1;
  prevBtn.addEventListener("click", () => {
    if (type === "provision") {
      provisionCurrentPage--;
      renderProvisionTable();
    } else {
      visitCurrentPage--;
      renderVisitTable();
    }
  });

  const nextBtn = document.createElement("button");
  nextBtn.textContent = "다음";
  nextBtn.disabled = currentPage === totalPages;
  nextBtn.addEventListener("click", () => {
    if (type === "provision") {
      provisionCurrentPage++;
      renderProvisionTable();
    } else {
      visitCurrentPage++;
      renderVisitTable();
    }
  });

  const info = document.createElement("span");
  info.innerHTML = ` <input type="number" min="1" max="${totalPages}" value="${currentPage}" style="width:40px"> / ${totalPages} 페이지 `;
  const input = info.querySelector("input");
  input.addEventListener("change", (e) => {
    let val = parseInt(e.target.value);
    if (val >= 1 && val <= totalPages) {
      if (type === "provision") {
        provisionCurrentPage = val;
        renderProvisionTable();
      } else {
        visitCurrentPage = val;
        renderVisitTable();
      }
    }
  });

  container.appendChild(prevBtn);
  container.appendChild(info);
  container.appendChild(nextBtn);
}

function generateYearOptions() {
  const now = new Date();
  const currentYear = now.getFullYear() % 100;
  const select = document.getElementById("year-range-select");
  if (!select) return;
  select.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    const start = currentYear - i;
    const end = start + 1;
    const option = document.createElement("option");
    option.value = `${start}-${end}`;
    option.textContent = `${start}-${end}`;
    select.appendChild(option);
  }
}

function formatDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
