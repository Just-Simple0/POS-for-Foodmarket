// statistics.js

import { db, auth } from "./components/firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  collection,
  getDocs,
  query,
  where,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { showToast } from "./components/comp.js";

let provisionData = [];
let visitData = [];
let provisionCurrentPage = 1;
let visitCurrentPage = 1;
let itemsPerPage = 20;

function formatDate(dateObj) {
  const yyyy = dateObj.getFullYear();
  const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
  const dd = String(dateObj.getDate()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd}`;
}

function getCurrentPeriodKey(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  let startYear = month >= 3 ? year : year - 1;
  let endYear = startYear + 1;
  return `${String(startYear).slice(2)}-${String(endYear).slice(2)}`;
}

// ✅ 문자열 정규화
function normalize(str) {
  return (
    str
      ?.toString()
      .toLowerCase()
      .replace(/[\s\-]/g, "") || ""
  );
}

document.addEventListener("DOMContentLoaded", async () => {
  // 🔄 Daterangepicker.js 설정
  const startDateInput = $("#start-date-input");
  const endDateInput = $("#end-date-input");

  const today = moment();
  const startOfToday = today.clone().startOf("day");
  const startOfLastWeek = today.clone().subtract(6, "days").startOf("day");
  const startOfLastMonth = today.clone().subtract(1, "month").startOf("day");
  const startOfLast3Months = today.clone().subtract(3, "months").startOf("day");
  const startOfLast6Months = today.clone().subtract(6, "months").startOf("day");
  const startOfLastYear = today.clone().subtract(1, "year").startOf("day");
  // Daterangepicker 초기화
  $("#start-date-input, #end-date-input").daterangepicker({
    locale: {
      format: "YYYY.MM.DD",
      separator: " ~ ",
      applyLabel: "확인",
      cancelLabel: "취소",
      fromLabel: "From",
      toLabel: "To",
      customRangeLabel: "직접 선택",
      weekLabel: "W",
      daysOfWeek: ["일", "월", "화", "수", "목", "금", "토"],
      monthNames: [
        "1월",
        "2월",
        "3월",
        "4월",
        "5월",
        "6월",
        "7월",
        "8월",
        "9월",
        "10월",
        "11월",
        "12월",
      ],
      firstDay: 1,
    },
    ranges: {
      오늘: [startOfToday, startOfToday],
      "1주일": [startOfLastWeek, today],
      "1개월": [startOfLastMonth, today],
      "3개월": [startOfLast3Months, today],
      "6개월": [startOfLast6Months, today],
      "1년": [startOfLastYear, today],
    },
    startDate: today,
    endDate: today,
    autoUpdateInput: false,
    alwaysShowCalendars: true,
  });

  // 날짜 선택 후 확인 버튼을 눌렀을 때 실행될 이벤트
  $("#start-date-input, #end-date-input").on(
    "apply.daterangepicker",
    function (ev, picker) {
      startDateInput.val(picker.startDate.format("YYYY.MM.DD"));
      endDateInput.val(picker.endDate.format("YYYY.MM.DD"));
      loadProvisionHistoryByRange(
        picker.startDate.toDate(),
        picker.endDate.toDate()
      );
    }
  );

  // 페이지 로드 시 초기 날짜 설정
  startDateInput.val(today.format("YYYY.MM.DD"));
  endDateInput.val(today.format("YYYY.MM.DD"));

  // 초기 데이터 로드 (오늘 날짜로)
  await loadProvisionHistoryByRange(today.toDate(), today.toDate());

  await renderTopStatistics();
  calculateMonthlyVisitRate();
  await loadVisitLogTable(getCurrentPeriodKey());

  // 🔁 토글 버튼
  const btnProvision = document.getElementById("btn-provision");
  const btnVisit = document.getElementById("btn-visit");
  const provisionSection = document.getElementById("provision-section");
  const visitSection = document.getElementById("visit-log-section");
  const itemCountSelect = document.getElementById("item-count-select");

  btnProvision.addEventListener("click", () => {
    btnProvision.classList.add("active");
    btnVisit.classList.remove("active");
    provisionSection.classList.remove("hidden");
    visitSection.classList.add("hidden");
  });

  btnVisit.addEventListener("click", () => {
    btnProvision.classList.remove("active");
    btnVisit.classList.add("active");
    provisionSection.classList.add("hidden");
    visitSection.classList.remove("hidden");
    loadVisitLogTable(getCurrentPeriodKey());
  });

  // 항목 수 변경
  itemCountSelect.addEventListener("change", (e) => {
    itemsPerPage = parseInt(e.target.value);
    if (btnProvision.classList.contains("active")) {
      renderProvisionTable();
    } else {
      renderVisitTable();
    }
  });

  // 🔍 검색 이벤트 등록
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
  document
    .getElementById("toggle-advanced-search")
    .addEventListener("click", () => {
      const adv = document.getElementById("advanced-search");
      adv.classList.toggle("hidden");
      document.getElementById("toggle-advanced-search").textContent =
        adv.classList.contains("hidden") ? "고급 검색 열기" : "고급 검색 닫기";
    });
});

// 🔄 통합 검색 및 필드별 검색 필터
function filterAndRender() {
  const globalKeyword = normalize(
    document.getElementById("global-search").value
  );
  const field = document.getElementById("field-select").value;
  const fieldValue = normalize(document.getElementById("field-search").value);
  const exactMatch = document.getElementById("exact-match").checked;

  const activeSection = document
    .getElementById("btn-provision")
    .classList.contains("active")
    ? "provision"
    : "visit";

  const dataset = activeSection === "provision" ? provisionData : visitData;

  const filtered = dataset.filter((item) => {
    const values = Object.values(item).map(normalize);

    const matchesGlobal =
      !globalKeyword ||
      values.some((v) =>
        exactMatch ? v === globalKeyword : v.includes(globalKeyword)
      );

    const matchesField =
      !field ||
      !fieldValue ||
      (exactMatch
        ? normalize(item[field]) === fieldValue
        : normalize(item[field]).includes(fieldValue));

    return matchesGlobal && matchesField;
  });

  if (activeSection === "provision") {
    provisionCurrentPage = 1;
    renderProvisionTable(filtered);
  } else {
    visitCurrentPage = 1;
    renderVisitTable(filtered);
  }
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

// 🔄 물품 제공 내역 불러오기 (범위)
async function loadProvisionHistoryByRange(startDate, endDate) {
  provisionData = [];

  // ✅ 시간 범위 보정
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const startTimestamp = Timestamp.fromDate(start);
  const endTimestamp = Timestamp.fromDate(end);

  const q = query(
    collection(db, "provisions"),
    where("timestamp", ">=", startTimestamp),
    where("timestamp", "<=", endTimestamp)
  );

  console.log("Loading provisions from", start, "to", end);

  const snapshot = await getDocs(q);

  snapshot.forEach((doc) => {
    const data = doc.data();
    provisionData.push({
      date: formatDate(data.timestamp.toDate()),
      name: data.customerName,
      birth: data.customerBirth,
      items: data.items.map((i) => `${i.name} (${i.quantity})`).join(", "),
      handler: data.handledBy,
    });
  });

  provisionData.sort((a, b) => new Date(b.date) - new Date(a.date));
  provisionCurrentPage = 1;
  filterAndRender();
}

// 🔄 고객별 방문 로그 불러오기
async function loadVisitLogTable(periodKey) {
  visitData = [];
  const snapshot = await getDocs(collection(db, "customers"));
  snapshot.forEach((doc) => {
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

  visitData.sort((a, b) => a.name.localeCompare(b.name));
  visitCurrentPage = 1;
  filterAndRender();
}

// 📋 테이블 렌더링 (Provision)
function renderProvisionTable(data = provisionData) {
  const tbody = document.querySelector("#provision-table tbody");
  tbody.innerHTML = "";
  const start = (provisionCurrentPage - 1) * itemsPerPage;
  const end = start + itemsPerPage;
  const pageItems = data.slice(start, end);

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

  updatePagination("provision", data.length, provisionCurrentPage);
}

// 📋 테이블 렌더링 (Visit)
function renderVisitTable(data = visitData) {
  const tbody = document.querySelector("#visit-log-table tbody");
  tbody.innerHTML = "";
  const start = (visitCurrentPage - 1) * itemsPerPage;
  const end = start + itemsPerPage;
  const pageItems = data.slice(start, end);

  pageItems.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.name}</td>
      <td>${row.birth}</td>
      <td>${row.dates}</td>
    `;
    tbody.appendChild(tr);
  });

  updatePagination("visit", data.length, visitCurrentPage);
}

// 🔢 페이지네이션 UI 생성
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
  info.innerHTML = `
    <input type="number" min="1" max="${totalPages}" value="${currentPage}" style="width:40px"> / ${totalPages} 페이지
  `;
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
