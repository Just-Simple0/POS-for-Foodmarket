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

document.addEventListener("DOMContentLoaded", async () => {
  generateYearOptions();
  await renderTopStatistics(); // 일일/월간 통계
  calculateMonthlyVisitRate();
  loadProvisionHistory("daily");
  setupVisitTable(); // 고객 방문일자
});

function getCurrentPeriodKey(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;

  let startYear = month >= 3 ? year : year - 1;
  let endYear = startYear + 1;

  return `${String(startYear).slice(2)}-${String(endYear).slice(2)}`;
}

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

  // ───── 제공 물품 수량 계산 ─────
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
    (data.items || []).forEach((item) => {
      todayItems += item.quantity;
    });
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
    (data.items || []).forEach((item) => {
      yesterdayItems += item.quantity;
    });
  });

  updateCard("#daily-items", todayItems, yesterdayItems, "개");
}

// 🔧 증감 표시 함수
function updateCard(selector, todayVal, yesterVal, unit = "") {
  const card = document.querySelector(selector);
  const valueEl = card.querySelector(".value");

  valueEl.textContent = `${todayVal}${unit}`;

  const diff = todayVal - yesterVal;
  const percent = yesterVal > 0 ? ((diff / yesterVal) * 100).toFixed(1) : "0";

  let text = "";
  let className = "";

  if (diff > 0) {
    text = `▲ ${diff}${unit} (${percent}%) 증가`;
    className = "up";
  } else if (diff < 0) {
    text = `▼ ${Math.abs(diff)}${unit} (${percent}%) 감소`;
    className = "down";
  } else {
    text = `변동 없음`;
    className = "";
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

  let supportCustomerCount = 0;
  let visitedThisMonthCount = 0;

  snapshot.forEach((doc) => {
    const data = doc.data();
    if (data.status !== "지원") return;

    supportCustomerCount++;

    const visits = data.visits?.[periodKey];
    if (!Array.isArray(visits)) return;

    const visited = visits.some((dateStr) => dateStr.startsWith(thisMonth));
    if (visited) visitedThisMonthCount++;
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

// 유틸: 날짜 포맷
function formatDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// 메인 함수
async function loadProvisionHistory(period = "daily", yearRange = null) {
  const tableBody = document.querySelector("#provision-table tbody");
  tableBody.innerHTML = "";

  const today = new Date();
  let startDate;
  let endDate = new Date();

  if (period === "daily") {
    startDate = new Date(today);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(today);
    endDate.setHours(23, 59, 59, 999);
  } else if (period === "monthly") {
    startDate = new Date(today.getFullYear(), today.getMonth(), 1);
    endDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  } else if (period === "yearly" && yearRange) {
    const [startY, endY] = yearRange.split("-").map((v) => parseInt(v));
    startDate = new Date(`20${startY}-03-01T00:00:00`);
    endDate = new Date(`20${endY}-03-01T00:00:00`);
  } else {
    return;
  }

  const q = query(collection(db, "provisions"));
  const snapshot = await getDocs(q);

  snapshot.forEach((doc) => {
    const data = doc.data();
    const ts = data.timestamp?.toDate?.();

    if (!ts || ts < startDate || ts >= endDate) return;

    const formattedDate = formatDate(ts);

    const itemsText = data.items
      .map((item) => `${item.name} (${item.quantity})`)
      .join(", ");

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formattedDate}</td>
      <td>${data.customerName}</td>
      <td>${data.customerBirth}</td>
      <td>${itemsText}</td>
      <td>${data.handledBy}</td>
    `;
    tableBody.appendChild(tr);
  });
}

function generateYearOptions() {
  const now = new Date();
  const currentYear = now.getFullYear() % 100; // 25
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

document.querySelector("#provision-filter").addEventListener("change", (e) => {
  const value = e.target.value;
  const yearSelect = document.getElementById("year-range-select");

  if (value === "yearly") {
    yearSelect.classList.remove("hidden");
    loadProvisionHistory("yearly", yearSelect.value);
  } else {
    yearSelect.classList.add("hidden");
    loadProvisionHistory(value);
  }
});

document.querySelector("#year-range-select").addEventListener("change", (e) => {
  const selected = document.querySelector("#provision-filter").value;
  if (selected === "yearly") {
    loadProvisionHistory("yearly", e.target.value);
  }
});

function setupVisitTable() {
  // 고객 상태가 '지원'인 사람만, visitDates 출력
}
