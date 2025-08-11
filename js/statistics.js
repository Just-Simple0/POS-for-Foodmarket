// statistics.js (finalized)

import { db } from "./components/firebase-config.js";
import {
  collection,
  getDocs,
  query,
  where,
  Timestamp,
  documentId,
  orderBy,
  startAfter,
  startAt,
  limit,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { showToast } from "./components/comp.js";

/* =====================================================
 * State
 * ===================================================== */
let allProvisionData = [];
let provisionData = [];
let visitData = [];
let lifeData = [];
let provisionCurrentPage = 1;
let visitCurrentPage = 1;
let lifeCurrentPage = 1;
let itemsPerPage = 20;

/* Life fallback (dev only). In production, keep false to avoid full scans */
const LIFE_DEBUG_FALLBACK = false;

/* =====================================================
 * Utils
 * ===================================================== */
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

function getCurrentQuarter() {
  const m = new Date().getMonth() + 1;
  if (m <= 3) return "Q1";
  if (m <= 6) return "Q2";
  if (m <= 9) return "Q3";
  return "Q4";
}

// 문자열 정규화 (통합 검색용)
function normalize(str) {
  return (
    str
      ?.toString()
      .toLowerCase()
      .replace(/[\s\-]/g, "") || ""
  );
}

function getFiscalPeriodKeys(n = 6) {
  const out = [];
  const today = new Date();

  for (let i = 0; i < n; i++) {
    const year = today.getFullYear() - i;
    const startYear = today.getMonth() + 1 >= 3 ? year : year - 1;
    const endYear = startYear + 1;
    out.push(`${String(startYear).slice(2)}-${String(endYear).slice(2)}`);
  }
  return [...new Set(out)];
}

function populateLifeYears() {
  const sel = document.getElementById("life-year-select");
  if (!sel) return;
  sel.innerHTML = "";

  const current = new Date().getFullYear();

  for (let y = current; y >= current - 5; y--) {
    const opt = document.createElement("option");
    opt.value = String(y);
    opt.textContent = String(y);
    sel.appendChild(opt);
  }
}

// Debounce for search
function debounce(fn, ms = 220) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// Simple loading indicator toggler (add .loading CSS in your stylesheet)
function setLoading(sectionId, on) {
  const el = document.getElementById(sectionId);
  if (!el) return;
  el.classList.toggle("loading", !!on);
}

/* =====================================================
 * Provision: server-side pagination (cursor)
 * ===================================================== */
let provCursor = {
  startTs: null,
  endTs: null,
  lastDoc: null,
  prevStack: [],
  serverMode: false,
};

function isProvisionClientFilteringOn() {
  const g = document.getElementById("global-search")?.value?.trim();
  const field = document.getElementById("field-select")?.value;
  const fv = document.getElementById("field-search")?.value?.trim();
  const advOpen = !document
    .getElementById("advanced-search")
    ?.classList?.contains("hidden");
  return g || (field && fv) || advOpen;
}

/* =====================================================
 * DOM Ready
 * ===================================================== */
document.addEventListener("DOMContentLoaded", async () => {
  // Daterangepicker.js 설정
  const startDateInput = $("#start-date-input");
  const endDateInput = $("#end-date-input");

  const today = moment();
  const startOfToday = today.clone().startOf("day");
  const startOfLastWeek = today.clone().subtract(6, "days").startOf("day");
  const startOfLastMonth = today.clone().subtract(1, "month").startOf("day");
  const startOfLast3Months = today.clone().subtract(3, "months").startOf("day");
  const startOfLast6Months = today.clone().subtract(6, "months").startOf("day");
  const startOfLastYear = today.clone().subtract(1, "year").startOf("day");

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

  // 초기 날짜 값
  startDateInput.val(today.format("YYYY.MM.DD"));
  endDateInput.val(today.format("YYYY.MM.DD"));

  // 초기 데이터 로드(오늘)
  await loadProvisionHistoryByRange(today.toDate(), today.toDate());
  await renderTopStatistics();
  calculateMonthlyVisitRate();
  await loadVisitLogTable(getCurrentPeriodKey());

  // 탭/필터
  const btnProvision = document.getElementById("btn-provision");
  const btnVisit = document.getElementById("btn-visit");
  const btnLife = document.getElementById("btn-life");

  const provisionSection = document.getElementById("provision-section");
  const visitSection = document.getElementById("visit-log-section");
  const lifeSection = document.getElementById("life-section");

  const filterProvision = document.getElementById("filter-provision");
  const filterVisit = document.getElementById("filter-visit");
  const filterLife = document.getElementById("filter-life");

  const fiscalSel = document.getElementById("fiscal-year-select");
  const lifeYearSel = document.getElementById("life-year-select");
  const lifeQuarterSel = document.getElementById("life-quarter-select");

  // 회계연도 옵션
  if (fiscalSel) {
    fiscalSel.innerHTML = "";
    getFiscalPeriodKeys(6).forEach((k) => {
      const o = document.createElement("option");
      o.value = k;
      o.textContent = k;
      fiscalSel.appendChild(o);
    });
  }
  // 생명사랑 연도 옵션
  populateLifeYears();

  function showTab(which) {
    btnProvision?.classList.toggle("active", which === "provision");
    btnVisit?.classList.toggle("active", which === "visit");
    btnLife?.classList.toggle("active", which === "life");

    provisionSection?.classList.toggle("hidden", which !== "provision");
    visitSection?.classList.toggle("hidden", which !== "visit");
    lifeSection?.classList.toggle("hidden", which !== "life");

    filterProvision?.classList.toggle("hidden", which !== "provision");
    filterVisit?.classList.toggle("hidden", which !== "visit");
    filterLife?.classList.toggle("hidden", which !== "life");
  }

  showTab("provision");

  btnProvision?.addEventListener("click", () => showTab("provision"));
  btnVisit?.addEventListener("click", () => {
    showTab("visit");
    loadVisitLogTable(fiscalSel?.value || getCurrentPeriodKey());
  });
  btnLife?.addEventListener("click", async () => {
    showTab("life");
    await loadLifeTable(lifeYearSel?.value, lifeQuarterSel?.value);
  });

  fiscalSel?.addEventListener("change", () => {
    if (btnVisit?.classList.contains("active"))
      loadVisitLogTable(fiscalSel.value);
  });
  lifeYearSel?.addEventListener("change", () => {
    if (btnLife?.classList.contains("active"))
      loadLifeTable(lifeYearSel.value, lifeQuarterSel.value);
  });
  lifeQuarterSel?.addEventListener("change", () => {
    if (btnLife?.classList.contains("active"))
      loadLifeTable(lifeYearSel.value, lifeQuarterSel.value);
  });

  if (lifeYearSel && lifeQuarterSel) {
    lifeYearSel.value = String(new Date().getFullYear());
    lifeQuarterSel.value = getCurrentQuarter();
  }

  const itemCountSelect = document.getElementById("item-count-select");
  itemCountSelect?.addEventListener("change", (e) => {
    itemsPerPage = parseInt(e.target.value);
    if (btnProvision?.classList.contains("active")) {
      renderProvisionTable();
    } else if (btnVisit?.classList.contains("active")) {
      renderVisitTable();
    } else {
      renderLifeTable();
    }
  });

  // 검색 디바운스
  const debouncedFilter = debounce(filterAndRender, 220);
  document
    .getElementById("global-search")
    ?.addEventListener("input", debouncedFilter);
  document
    .getElementById("exact-match")
    ?.addEventListener("change", filterAndRender);
  document
    .getElementById("field-select")
    ?.addEventListener("change", filterAndRender);
  document
    .getElementById("field-search")
    ?.addEventListener("input", debouncedFilter);
  document
    .getElementById("toggle-advanced-search")
    ?.addEventListener("click", () => {
      const adv = document.getElementById("advanced-search");
      adv?.classList.toggle("hidden");
      document.getElementById("toggle-advanced-search").textContent =
        adv?.classList.contains("hidden") ? "고급 검색 열기" : "고급 검색 닫기";
    });

  // XLSX export buttons (data → xlsx)
  document.getElementById("export-provision")?.addEventListener("click", () => {
    exportRowsXLSX(
      provisionData,
      [
        ["제공일", "date"],
        ["고객명", "name"],
        ["생년월일", "birth"],
        ["가져간 품목", "items"],
        ["처리자", "handler"],
      ],
      "물품_제공_내역.xlsx"
    );
  });
  document.getElementById("export-visit")?.addEventListener("click", () => {
    exportRowsXLSX(
      visitData,
      [
        ["고객명", "name"],
        ["생년월일", "birth"],
        ["방문일자", "dates"],
      ],
      "이용자별_방문_일자.xlsx"
    );
  });
  document.getElementById("export-life")?.addEventListener("click", () => {
    exportRowsXLSX(
      lifeData,
      [
        ["이름", "name"],
        ["생년월일", "birth"],
        ["성별", "gender"],
        ["이용자구분", "userType"],
        ["이용자분류", "userClass"],
      ],
      "생명사랑_제공_현황.xlsx"
    );
  });
});

/* =====================================================
 * Filter + render
 * ===================================================== */
function filterAndRender() {
  const globalKeyword = normalize(
    document.getElementById("global-search")?.value
  );
  const field = document.getElementById("field-select")?.value;
  const fieldValue = normalize(document.getElementById("field-search")?.value);
  const exactMatch = document.getElementById("exact-match")?.checked;

  let activeSection = "provision";
  if (document.getElementById("btn-visit")?.classList.contains("active"))
    activeSection = "visit";
  if (document.getElementById("btn-life")?.classList.contains("active"))
    activeSection = "life";

  const dataset =
    activeSection === "provision"
      ? provisionData
      : activeSection === "visit"
      ? visitData
      : lifeData;

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
  } else if (activeSection === "visit") {
    visitCurrentPage = 1;
    renderVisitTable(filtered);
  } else {
    lifeCurrentPage = 1;
    renderLifeTable(filtered);
  }
}

/* =====================================================
 * Top cards
 * ===================================================== */
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
  try {
    const customersSnap = await getDocs(
      query(collection(db, "customers"), where("status", "==", "지원"))
    );
    customersSnap.forEach((doc) => {
      const data = doc.data();
      const visits = data.visits?.[periodKey] || [];
      if (visits.includes(todayStr)) todayVisit++;
      if (visits.includes(yesterdayStr)) yesterdayVisit++;
      if (visits.some((v) => v.startsWith(currentYearMonth))) monthlyVisit++;
    });
  } catch (e) {
    console.error(e);
  }

  updateCard("#daily-visitors", todayVisit, yesterdayVisit, "명");
  const mv = document.querySelector("#monthly-visitors .value");
  if (mv) mv.textContent = `${monthlyVisit}명`;

  const todayStart = Timestamp.fromDate(new Date(todayStr + "T00:00:00"));
  const todayEnd = Timestamp.fromDate(new Date(todayStr + "T23:59:59"));
  const yStart = Timestamp.fromDate(new Date(yesterdayStr + "T00:00:00"));
  const yEnd = Timestamp.fromDate(new Date(yesterdayStr + "T23:59:59"));

  let todayItems = 0,
    yesterdayItems = 0;

  try {
    const todaySnap = await getDocs(
      query(
        collection(db, "provisions"),
        where("timestamp", ">=", todayStart),
        where("timestamp", "<=", todayEnd)
      )
    );
    todaySnap.forEach((doc) => {
      const data = doc.data();
      (data.items || []).forEach(
        (item) => (todayItems += Number(item.quantity || 0))
      );
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
      (data.items || []).forEach(
        (item) => (yesterdayItems += Number(item.quantity || 0))
      );
    });
  } catch (e) {
    console.error(e);
  }

  updateCard("#daily-items", todayItems, yesterdayItems, "개");
}

function updateCard(selector, todayVal, yesterVal, unit = "") {
  const card = document.querySelector(selector);
  if (!card) return;
  const valueEl = card.querySelector(".value");
  if (valueEl) valueEl.textContent = `${todayVal}${unit}`;
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
  try {
    const snapshot = await getDocs(
      query(collection(db, "customers"), where("status", "==", "지원"))
    );
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(
      now.getMonth() + 1
    ).padStart(2, "0")}`;
    const periodKey = getCurrentPeriodKey(now);
    let supportCustomerCount = 0,
      visitedThisMonthCount = 0;

    snapshot.forEach((doc) => {
      const data = doc.data();
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
  } catch (e) {
    console.error(e);
  }
}

/* =====================================================
 * Customers batched fetch for Life tab
 * ===================================================== */
async function fetchCustomersByIdsBatched(ids) {
  const out = {};
  const chunks = [];
  const arr = Array.from(new Set(ids)).filter(Boolean);

  for (let i = 0; i < arr.length; i += 10) chunks.push(arr.slice(i, i + 10));

  for (const batch of chunks) {
    const snap = await getDocs(
      query(collection(db, "customers"), where(documentId(), "in", batch))
    );
    snap.forEach((doc) => (out[doc.id] = doc.data()));
  }
  return out;
}

/* =====================================================
 * Provision: Load by range (server pagination aware)
 * ===================================================== */
async function loadProvisionHistoryByRange(startDate, endDate) {
  allProvisionData = [];
  provisionData = [];

  // 범위 보정
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  provCursor.startTs = Timestamp.fromDate(start);
  provCursor.endTs = Timestamp.fromDate(end);

  // 클라 필터가 꺼져있으면 서버 페이지네이션ON
  provCursor.serverMode = !isProvisionClientFilteringOn();
  provCursor.lastDoc = null;
  provCursor.prevStack = [];

  console.log(
    "[Provision] range:",
    start,
    "~",
    end,
    "serverMode:",
    provCursor.serverMode
  );

  try {
    setLoading("provision-section", true);
    if (provCursor.serverMode) {
      await loadProvisionPage("init");
    } else {
      const qy = query(
        collection(db, "provisions"),
        where("timestamp", ">=", provCursor.startTs),
        where("timestamp", "<=", provCursor.endTs)
      );
      const snapshot = await getDocs(qy);
      snapshot.forEach((doc) => {
        const data = doc.data();
        allProvisionData.push({
          date: formatDate(data.timestamp.toDate()),
          name: data.customerName,
          birth: data.customerBirth,
          items: (data.items || [])
            .map((i) => `${i.name} (${i.quantity})`)
            .join(", "),
          handler: data.handledBy,
          lifelove: data.lifelove ? "O" : "",
          quarterKey: data.quarterKey,
        });
      });
      allProvisionData.sort((a, b) => new Date(b.date) - new Date(a.date));
      provisionData = allProvisionData.slice();
      provisionCurrentPage = 1;
      filterAndRender();
    }
  } catch (e) {
    console.error(e);
    showToast?.("제공 내역을 불러오지 못했습니다.");
  } finally {
    setLoading("provision-section", false);
  }
}

// Cursor page loader
async function loadProvisionPage(direction) {
  const base = [
    where("timestamp", ">=", provCursor.startTs),
    where("timestamp", "<=", provCursor.endTs),
  ];

  let qy;
  if (direction === "init") {
    qy = query(
      collection(db, "provisions"),
      ...base,
      orderBy("timestamp", "desc"),
      limit(itemsPerPage)
    );
    provCursor.prevStack = [];
  } else if (direction === "next" && provCursor.lastDoc) {
    provCursor.prevStack.push(provCursor.lastDoc);
    qy = query(
      collection(db, "provisions"),
      ...base,
      orderBy("timestamp", "desc"),
      startAfter(provCursor.lastDoc),
      limit(itemsPerPage)
    );
  } else if (direction === "prev") {
    const prevCursor = provCursor.prevStack.pop();
    if (!prevCursor) return;
    qy = query(
      collection(db, "provisions"),
      ...base,
      orderBy("timestamp", "desc"),
      startAt(prevCursor),
      limit(itemsPerPage)
    );
  } else {
    return;
  }

  try {
    setLoading("provision-section", true);
    const snap = await getDocs(qy);
    const rows = [];
    snap.forEach((d) => {
      const data = d.data();
      rows.push({
        date: formatDate(data.timestamp.toDate()),
        name: data.customerName,
        birth: data.customerBirth,
        items: (data.items || [])
          .map((i) => `${i.name} (${i.quantity})`)
          .join(", "),
        handler: data.handledBy,
        lifelove: data.lifelove ? "O" : "",
        quarterKey: data.quarterKey,
      });
    });
    provisionData = rows;
    provisionCurrentPage = 1;
    provCursor.lastDoc = snap.docs[snap.docs.length - 1] || null;
    renderProvisionTable(provisionData);
    updateProvisionPagerButtons(
      !!provCursor.prevStack.length,
      !!provCursor.lastDoc
    );
  } catch (e) {
    console.error(e);
    showToast?.("제공 내역(페이지)을 불러오지 못했습니다.");
  } finally {
    setLoading("provision-section", false);
  }
}

function updateProvisionPagerButtons(hasPrev, hasNext) {
  const box = document.getElementById("provision-pagination");
  if (!box) return;
  const btns = box.querySelectorAll("button");
  const [prevBtn, , nextBtn] = btns; // prev, (info span), next
  if (prevBtn) prevBtn.disabled = !hasPrev;
  if (nextBtn) nextBtn.disabled = !hasNext;
}

/* =====================================================
 * Visit
 * ===================================================== */
async function loadVisitLogTable(periodKey) {
  try {
    setLoading("visit-log-section", true);
    visitData = [];
    const snapshot = await getDocs(
      query(collection(db, "customers"), where("status", "==", "지원"))
    );
    snapshot.forEach((doc) => {
      const data = doc.data();
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
  } catch (e) {
    console.error(e);
    showToast?.("방문 일자를 불러오지 못했습니다.");
  } finally {
    setLoading("visit-log-section", false);
  }
}

/* =====================================================
 * Life (lifelove)
 * ===================================================== */
function buildQuarterKey(year, q) {
  return `${String(year).trim()}-${String(q).trim()}`;
}

function quarterFromTimestamp(ts) {
  const m = ts.getMonth() + 1;
  if (m <= 3) return "Q1";
  if (m <= 6) return "Q2";
  if (m <= 9) return "Q3";
  return "Q4";
}

async function loadLifeTable(year, q) {
  lifeData = [];
  if (!year || !q) return;

  const quarterKey = buildQuarterKey(year, q);

  let provRows = [];
  try {
    const q1 = query(
      collection(db, "provisions"),
      where("lifelove", "==", true),
      where("quarterKey", "==", quarterKey)
    );
    const snap1 = await getDocs(q1);
    snap1.forEach((doc) => provRows.push(doc.data()));
    console.debug(
      "[Life][1] compound where count:",
      provRows.length,
      "key:",
      quarterKey
    );
  } catch (err) {
    console.warn("[Life][1] compound where error (index?)", err);
  }

  if (LIFE_DEBUG_FALLBACK && provRows.length === 0) {
    const allProvSnap = await getDocs(collection(db, "provisions"));
    const all = [];
    allProvSnap.forEach((doc) => all.push(doc.data()));
    const keyTrim = quarterKey.trim();
    provRows = all.filter(
      (d) =>
        (d.lifelove === true || d.lifelove === "true") &&
        typeof d.quarterKey === "string" &&
        d.quarterKey.trim() === keyTrim
    );
    console.debug("[Life][3] fallback full-scan:", provRows.length);
  }

  const needIds = provRows.map((p) => p.customerId).filter(Boolean);
  const customerMap = await fetchCustomersByIdsBatched(needIds);

  lifeData = provRows.map((p) => {
    const c = p.customerId ? customerMap[p.customerId] : null;
    return {
      name: c?.name ?? p.customerName ?? "",
      birth: c?.birth ?? p.customerBirth ?? "",
      gender: c?.gender ?? "",
      userType: c?.type ?? "",
      userClass: c?.category ?? "",
    };
  });

  lifeData.sort((a, b) => a.name.localeCompare(b.name, "ko"));
  lifeCurrentPage = 1;
  renderLifeTable();

  console.debug(
    "[Life][final] quarterKey:",
    quarterKey,
    "prov:",
    provRows.length,
    "rendered:",
    lifeData.length
  );
}

/* =====================================================
 * Renderers
 * ===================================================== */
function renderProvisionTable(data = provisionData) {
  const tbody = document.querySelector("#provision-table tbody");
  if (!tbody) return;
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

  // 서버 페이지네이션 모드면 버튼만 토글, 아닌 경우 기존 페이지네이션
  if (provCursor.serverMode) {
    updatePagination("provision", itemsPerPage, 1);
    updateProvisionPagerButtons(
      !!provCursor.prevStack.length,
      !!provCursor.lastDoc
    );
  } else {
    updatePagination("provision", data.length, provisionCurrentPage);
  }
}

function renderVisitTable(data = visitData) {
  const tbody = document.querySelector("#visit-log-table tbody");
  if (!tbody) return;
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

function renderLifeTable(data = lifeData) {
  const tbody = document.querySelector("#life-table tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const start = (lifeCurrentPage - 1) * itemsPerPage;
  const end = start + itemsPerPage;
  const pageItems = data.slice(start, end);

  pageItems.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.name}</td>
      <td>${row.birth}</td>
      <td>${row.gender}</td>
      <td>${row.userType}</td>
      <td>${row.userClass}</td>
    `;
    tbody.appendChild(tr);
  });

  updatePagination("life", data.length, lifeCurrentPage);
}

/* =====================================================
 * Export (data → xlsx)
 * ===================================================== */
function exportRowsXLSX(rows, headerMap, filename) {
  const data = rows.map((r) => {
    const o = {};
    headerMap.forEach(([label, key]) => (o[label] = r[key] ?? ""));
    return o;
  });
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, filename);
}

/* =====================================================
 * Pagination UI
 * ===================================================== */
function updatePagination(type, totalItems, currentPage) {
  const container = document.getElementById(`${type}-pagination`);
  if (!container) return;
  container.innerHTML = "";

  const serverMode = type === "provision" && provCursor.serverMode;
  const totalPages = serverMode ? 1 : Math.ceil(totalItems / itemsPerPage) || 1;

  const prevBtn = document.createElement("button");
  prevBtn.textContent = "이전";
  prevBtn.disabled = serverMode
    ? !provCursor.prevStack.length
    : currentPage === 1;
  prevBtn.addEventListener("click", () => {
    if (type === "provision") {
      if (serverMode) {
        loadProvisionPage("prev");
      } else {
        provisionCurrentPage--;
        renderProvisionTable();
      }
    } else if (type === "visit") {
      visitCurrentPage--;
      renderVisitTable();
    } else {
      lifeCurrentPage--;
      renderLifeTable();
    }
  });

  const nextBtn = document.createElement("button");
  nextBtn.textContent = "다음";
  nextBtn.disabled = serverMode
    ? !provCursor.lastDoc
    : currentPage === totalPages;
  nextBtn.addEventListener("click", () => {
    if (type === "provision") {
      if (serverMode) {
        loadProvisionPage("next");
      } else {
        provisionCurrentPage++;
        renderProvisionTable();
      }
    } else if (type === "visit") {
      visitCurrentPage++;
      renderVisitTable();
    } else {
      lifeCurrentPage++;
      renderLifeTable();
    }
  });

  const info = document.createElement("span");
  info.innerHTML = serverMode
    ? `서버 페이지네이션`
    : `<input type="number" min="1" max="${totalPages}" value="${currentPage}" style="width:40px"> / ${totalPages} 페이지`;
  const input = info.querySelector("input");
  if (input) {
    input.addEventListener("change", (e) => {
      let val = parseInt(e.target.value);
      if (val >= 1 && val <= totalPages) {
        if (type === "provision") {
          provisionCurrentPage = val;
          renderProvisionTable();
        } else if (type === "visit") {
          visitCurrentPage = val;
          renderVisitTable();
        } else {
          lifeCurrentPage = val;
          renderLifeTable();
        }
      }
    });
  }

  container.appendChild(prevBtn);
  container.appendChild(info);
  container.appendChild(nextBtn);
}
