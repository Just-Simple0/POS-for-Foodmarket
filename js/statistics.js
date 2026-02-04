// statistics.js (finalized)

import { db } from "./components/firebase-config.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  Timestamp,
  documentId,
  orderBy,
  startAfter,
  endBefore,
  limit,
  getCountFromServer,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  showToast,
  renderCursorPager,
  initPageSizeSelect,
  withLoading,
  makeSectionSkeleton,
} from "./components/comp.js";

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
let itemsPerPage = 20; // #item-count-select와 연동

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

// ===== Date helpers =====
function toDayNumber(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return x.getFullYear() * 10000 + (x.getMonth() + 1) * 100 + x.getDate();
}
function dayRange(d) {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const e = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return [s, e];
}
function monthRange(d) {
  const s = new Date(d.getFullYear(), d.getMonth(), 1);
  const e = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return [s, e];
}
// 'YYYY-MM' 키 (월간 캐싱용)
function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function formatYearMonth(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yyyy}.${mm}`;
}
// 로컬(KST) 기준 키/표시 포맷
function dateKey8Local(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`; // 'YYYYMMDD'
}
function formatDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}.${m}.${day}`; // 'YYYY.MM.DD'
}

// ===== Top-cards core =====
// 1순위 stats_daily / 2순위 visits count agg / 3순위 provisions 기간 + 고객Set
async function getDailyVisitorsCount(db, date) {
  const day = toDayNumber(date);
  // stats_daily
  try {
    const s = await getDoc(doc(db, "stats_daily", String(day)));
    if (s.exists() && typeof s.data().uniqueVisitors === "number")
      return s.data().uniqueVisitors;
  } catch (e) {
    /* pass */
  }
  // visits count
  try {
    const qv = query(
      collection(db, "visits"),
      where("day", ">=", day),
      where("day", "<=", day)
    );
    const agg = await getCountFromServer(qv);
    if (typeof agg.data().count === "number") return agg.data().count;
  } catch (e) {
    /* pass */
  }
  // provisions fallback
  const [start, end] = dayRange(date);
  const qp = query(
    collection(db, "provisions"),
    where("timestamp", ">=", start),
    where("timestamp", "<", end)
  );
  const snap = await getDocs(qp);
  const uniq = new Set();
  snap.forEach((d) => {
    const v = d.data();
    if (v?.customerId) uniq.add(v.customerId);
  });
  return uniq.size;
}

async function getMonthlyVisitorsCount(db, anyDateInMonth) {
  // stats_daily 합산(최대 31건)
  let sum = 0,
    used = 0;
  const [ms, me] = monthRange(anyDateInMonth);
  for (let d = new Date(ms); d < me; d.setDate(d.getDate() + 1)) {
    const day = toDayNumber(d);
    try {
      const s = await getDoc(doc(db, "stats_daily", String(day)));
      if (s.exists() && typeof s.data().uniqueVisitors === "number") {
        sum += s.data().uniqueVisitors;
        used++;
      }
    } catch (e) {
      /*pass*/
    }
  }
  if (used > 0) return sum;
  // visits count agg (월 범위)
  try {
    const dmin = toDayNumber(ms);
    const dmax = toDayNumber(
      new Date(me.getFullYear(), me.getMonth(), me.getDate() - 1)
    );
    const qv = query(
      collection(db, "visits"),
      where("day", ">=", dmin),
      where("day", "<=", dmax)
    );
    const agg = await getCountFromServer(qv);
    if (typeof agg.data().count === "number") return agg.data().count;
  } catch (e) {
    /*pass*/
  }
  // provisions fallback (월 범위 + 고유 고객)
  const qp = query(
    collection(db, "provisions"),
    where("timestamp", ">=", ms),
    where("timestamp", "<", me)
  );
  const ps = await getDocs(qp);
  const uniq = new Set();
  ps.forEach((d) => {
    const v = d.data();
    if (v?.customerId) uniq.add(v.customerId);
  });
  return uniq.size;
}

// ─────────────────────────────────────────────────────────
// ✅ stats_daily 월 합계(고객 수) with 캐시 (중복 읽기 방지)
//   - 같은 달은 최초 1회만 네트워크 읽고, 이후 재사용
//   - 내부적으로 문서 ID(YYYYMMDD)를 10개씩 끊어 in-쿼리(batch)로 조회
const __statsDailyMonthCache = { key: null, sum: null };
async function getMonthlyVisitorsFromStatsDaily(baseDate = new Date()) {
  const mkey = monthKey(baseDate);
  if (
    __statsDailyMonthCache.key === mkey &&
    __statsDailyMonthCache.sum != null
  ) {
    return __statsDailyMonthCache.sum; // 캐시 히트
  }
  const [ms, me] = monthRange(baseDate);
  const ids = [];
  for (let d = new Date(ms); d < me; d.setDate(d.getDate() + 1)) {
    ids.push(dateKey8Local(d)); // 'YYYYMMDD'
  }
  let sum = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const snap = await getDocs(
      query(collection(db, "stats_daily"), where(documentId(), "in", batch))
    );
    snap.forEach((ds) => {
      sum += Number(ds.data()?.uniqueVisitors || 0);
    });
  }
  __statsDailyMonthCache.key = mkey;
  __statsDailyMonthCache.sum = sum;
  return sum;
}

/* =====================================================
 * 공통: pagebar(A안) 렌더 도우미
 * ===================================================== */
function renderSimplePagerA(containerId, current, totalPages, onMove) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const hasPrev = current > 1;
  const hasNext = current < totalPages;
  renderCursorPager(
    el,
    { current, pagesKnown: totalPages, hasPrev, hasNext },
    {
      goFirst: () => onMove(1),
      goPrev: () => onMove(Math.max(1, current - 1)),
      goPage: (n) => onMove(Math.min(Math.max(1, n), totalPages)),
      goNext: () => onMove(Math.min(totalPages, current + 1)),
      goLast: () => onMove(totalPages),
    },
    { window: 5 }
  );
}

/* =====================================================
 * Provision: server-side pagination (cursor)
 * ===================================================== */
let provCursor = {
  startTs: null,
  endTs: null,
  firstDoc: null,
  lastDoc: null,
  serverMode: false,
  page: 1,
  totalPages: 1,
  hasNext: false,
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
      daysOfWeek: ["토", "일", "월", "화", "수", "목", "금"],
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

  // 초기 데이터 로드(오늘) — 전역 로딩 오버레이
  await withLoading(async () => {
    await loadProvisionHistoryByRange(today.toDate(), today.toDate());
    await renderTopStatistics();
    await calculateMonthlyVisitRate();
    await loadVisitLogTable(getCurrentPeriodKey());
  }, "통계 데이터 로딩 중...");

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
    itemsPerPage = parseInt(e.target.value, 10) || 20;
    if (btnProvision?.classList.contains("active")) {
      if (provCursor.serverMode) {
        provCursor.firstDoc = null;
        provCursor.lastDoc = null;
        provCursor.page = 1;
        // 페이지 크기가 바뀌면 총 페이지도 다시 산출
        computeProvisionTotalPages().then(() => loadProvisionPage("init"));
      } else {
        provisionCurrentPage = 1;
        renderProvisionTable();
      }
    } else if (btnVisit?.classList.contains("active")) {
      visitCurrentPage = 1;
      renderVisitTable();
    } else {
      lifeCurrentPage = 1;
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
    exportProvisionXLSX(provisionData, "물품_제공_내역.xlsx");
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
  // ✅ ‘일일 방문 인원’ 카드 클릭 → 월별 일일 데이터 모달 (현재 월)
  document
    .getElementById("daily-visitors")
    ?.addEventListener("click", () => openMonthlyDailyModal(new Date()));
  // 모달 닫기/배경 클릭
  document
    .getElementById("monthly-daily-close")
    ?.addEventListener("click", closeMonthlyDailyModal);
  document
    .getElementById("monthly-daily-modal")
    ?.addEventListener("click", (e) => {
      if (e.target?.id === "monthly-daily-modal") closeMonthlyDailyModal();
    });
  // 이전/다음 달
  document
    .getElementById("monthly-daily-prev")
    ?.addEventListener("click", async () => {
      if (!__modalMonth) return;
      __modalMonth = new Date(
        __modalMonth.getFullYear(),
        __modalMonth.getMonth() - 1,
        1
      );
      const mi = document.getElementById("monthly-daily-input");
      if (mi) {
        mi.value = `${__modalMonth.getFullYear()}-${String(
          __modalMonth.getMonth() + 1
        ).padStart(2, "0")}`;
      }
      await refreshMonthlyDailyModal();
    });
  document
    .getElementById("monthly-daily-next")
    ?.addEventListener("click", async () => {
      if (!__modalMonth) return;
      __modalMonth = new Date(
        __modalMonth.getFullYear(),
        __modalMonth.getMonth() + 1,
        1
      );
      const mi = document.getElementById("monthly-daily-input");
      if (mi) {
        mi.value = `${__modalMonth.getFullYear()}-${String(
          __modalMonth.getMonth() + 1
        ).padStart(2, "0")}`;
      }
      await refreshMonthlyDailyModal();
    });
  // 달력(month input)으로 월 직접 선택
  document
    .getElementById("monthly-daily-input")
    ?.addEventListener("change", async (e) => {
      const val = String(e.target.value || ""); // 'YYYY-MM'
      const m = /^(\d{4})-(\d{2})$/.exec(val);
      if (!m) return;
      const y = Number(m[1]),
        mm = Number(m[2]);
      __modalMonth = new Date(y, mm - 1, 1);
      await refreshMonthlyDailyModal();
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
    // 품목 배열은 검색용으로 itemsText를 사용
    const values = [];
    for (const [k, v] of Object.entries(item)) {
      if (k === "items" && Array.isArray(v)) {
        values.push(
          normalize(
            item.itemsText ||
              v.map((it) => `${it.name} (${it.quantity})`).join(", ")
          )
        );
      } else {
        values.push(normalize(v));
      }
    }
    const matchesGlobal =
      !globalKeyword ||
      values.some((v) =>
        exactMatch ? v === globalKeyword : v.includes(globalKeyword)
      );
    // 필드 지정이 items인 경우 배열 → itemsText로 검색
    let fieldTarget = "";
    if (field === "items") {
      fieldTarget = normalize(
        item.itemsText ||
          (Array.isArray(item.items)
            ? item.items.map((it) => `${it.name} (${it.quantity})`).join(", ")
            : "")
      );
    } else {
      fieldTarget = normalize(item[field]);
    }
    const matchesField =
      !field ||
      !fieldValue ||
      (exactMatch
        ? fieldTarget === fieldValue
        : fieldTarget.includes(fieldValue));
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
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const todayStr = today.toISOString().slice(0, 10);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  // 방문자 수: stats_daily → visits → provisions 폴백
  // 월간은 캐시 지원 함수 사용(중복 읽기 방지)
  const [todayVisit, yesterdayVisit, monthlyVisit] = await Promise.all([
    getDailyVisitorsCount(db, today),
    getDailyVisitorsCount(db, yesterday),
    getMonthlyVisitorsFromStatsDaily(today),
  ]);

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

/* =====================================================
 * Modal: 월별 일일 방문 인원(stats_daily) — common.css 모달 사용
 * ===================================================== */
let __modalMonth = null; // 모달의 기준 월(매달 1일)
let __modalBusy = false; // 중복 로딩 방지

async function openMonthlyDailyModal(baseDate = new Date()) {
  __modalMonth = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
  const titleEl = document.getElementById("monthly-daily-title");
  if (titleEl) titleEl.textContent = "월별 일일 방문 인원";
  const mi = document.getElementById("monthly-daily-input");
  if (mi) {
    mi.value = `${__modalMonth.getFullYear()}-${String(
      __modalMonth.getMonth() + 1
    ).padStart(2, "0")}`;
  }
  await refreshMonthlyDailyModal();
  document.getElementById("monthly-daily-modal")?.classList.remove("hidden");
}
function closeMonthlyDailyModal() {
  document.getElementById("monthly-daily-modal")?.classList.add("hidden");
}
async function refreshMonthlyDailyModal() {
  if (__modalBusy) return;
  __modalBusy = true;
  const rows = await fetchMonthDailyCounts(__modalMonth);
  renderMonthlyDailyTable(rows, /*desc=*/ false);
  __modalBusy = false;
}
// stats_daily에서 월 범위의 일자별 방문 인원 수 집계(없으면 0)
async function fetchMonthDailyCounts(monthDate) {
  const [ms, me] = monthRange(monthDate);
  // YYYYMMDD id 목록 (로컬 기준)
  const ids = [];
  for (let d = new Date(ms); d < me; d.setDate(d.getDate() + 1)) {
    ids.push(dateKey8Local(d));
  }
  const results = {}; // 'YYYY.MM.DD' -> count
  // Firestore 'in' 최대 10개 → 10개씩 끊어서 조회
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const snap = await getDocs(
      query(collection(db, "stats_daily"), where(documentId(), "in", batch))
    );
    snap.forEach((ds) => {
      const id8 = ds.id; // 'YYYYMMDD'
      const y = id8.slice(0, 4),
        m = id8.slice(4, 6),
        d = id8.slice(6, 8);
      const key = `${y}.${m}.${d}`;
      const v = Number(ds.data()?.uniqueVisitors || 0);
      results[key] = v;
    });
  }
  // 빠진 날짜(문서 없음)는 0으로 채워서 정렬된 배열 반환
  const out = [];
  for (let d = new Date(ms); d < me; d.setDate(d.getDate() + 1)) {
    const key = formatDateLocal(d);
    out.push({ date: key, count: results[key] || 0 });
  }
  return out;
}
function renderMonthlyDailyTable(rows, desc = false) {
  const tbody = document.querySelector("#monthly-daily-table tbody");
  const totalEl = document.getElementById("monthly-daily-total");
  if (!tbody) return;
  tbody.innerHTML = "";
  let sum = 0;
  const data = desc ? [...rows].reverse() : rows;
  data.forEach((r) => {
    sum += r.count;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${
      r.date
    }</td><td class="num">${r.count.toLocaleString()}</td>`;
    tbody.appendChild(tr);
  });
  if (totalEl) totalEl.textContent = sum.toLocaleString();
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
    const now = new Date();
    const [ms, me] = monthRange(now);
    // 1) 해당 월 방문 인원: stats_daily 합산값(캐시 포함)
    const visitedThisMonthCount = await getMonthlyVisitorsFromStatsDaily(now);
    // 2) 지원 고객 수 (count aggregation)
    const agg = await getCountFromServer(
      query(collection(db, "customers"), where("status", "==", "지원"))
    );
    const supportCustomerCount = Number(agg.data().count || 0);
    const rate =
      supportCustomerCount > 0
        ? ((visitedThisMonthCount / supportCustomerCount) * 100).toFixed(1)
        : "0";
    // UI 반영
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
  provCursor.firstDoc = null;
  provCursor.lastDoc = null;
  provCursor.page = 1;
  provCursor.totalPages = 1;

  console.log(
    "[Provision] range:",
    start,
    "~",
    end,
    "serverMode:",
    provCursor.serverMode
  );

  // 섹션 스켈레톤 (표 영역에 국소 로딩)
  const __cleanupSkel = makeSectionSkeleton(
    document.getElementById("provision-section"),
    10
  );
  try {
    if (provCursor.serverMode) {
      await computeProvisionTotalPages();
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
        const itemsArr = (data.items || []).map((i) => ({
          name: i.name || "",
          quantity: Number(i.quantity || 0),
          price: Number(i.price || 0),
          total: Number(i.quantity || 0) * Number(i.price || 0),
        }));
        allProvisionData.push({
          date: formatDate(data.timestamp.toDate()),
          name: data.customerName,
          birth: data.customerBirth,
          items: itemsArr,
          itemsText: itemsArr
            .map((it) => `${it.name} (${it.quantity})`)
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
    __cleanupSkel?.();
  }
}

// 총 문서 수 → 총 페이지 수 계산 (count() 1회)
async function computeProvisionTotalPages() {
  try {
    const qCount = query(
      collection(db, "provisions"),
      where("timestamp", ">=", provCursor.startTs),
      where("timestamp", "<=", provCursor.endTs)
    );
    const agg = await getCountFromServer(qCount);
    const total = Number(agg.data().count || 0);
    provCursor.totalPages = Math.max(1, Math.ceil(total / itemsPerPage));
    return provCursor.totalPages;
  } catch (e) {
    console.warn("[Provision] totalPages count failed", e);
    provCursor.totalPages = 1;
    return 1;
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
      limit(itemsPerPage + 1)
    );
    provCursor.page = 1;
  } else if (direction === "next" && provCursor.lastDoc) {
    qy = query(
      collection(db, "provisions"),
      ...base,
      orderBy("timestamp", "desc"),
      startAfter(provCursor.lastDoc),
      limit(itemsPerPage + 1)
    );
    provCursor.page += 1;
  } else if (direction === "prev") {
    qy = query(
      collection(db, "provisions"),
      ...base,
      orderBy("timestamp", "desc"),
      // 현재 페이지 첫 문서 기준 이전 묶음 로드
      endBefore(provCursor.firstDoc),
      limit(itemsPerPage + 1)
    );
    provCursor.page = Math.max(1, provCursor.page - 1);
  } else if (direction === "last") {
    // 마지막 페이지: 오래된 순(asc)으로 가져와 꼬리만 취해 역순 표시
    // (쿼리 1회로 끝 페이지 접근)
    qy = query(
      collection(db, "provisions"),
      ...base,
      orderBy("timestamp", "asc"),
      limit(itemsPerPage + 1)
    );
    // page 번호를 미리 끝으로
    provCursor.page = provCursor.totalPages;
  } else {
    return;
  }

  const __cleanupSkel = makeSectionSkeleton(
    document.getElementById("provision-section"),
    8
  );
  try {
    const snap = await getDocs(qy);

    // --- look-ahead 해석 + 정렬 보정 ---
    // 기본은 내림차순 쿼리. 'last'는 asc로 받았으니 역순으로 바꿔서 렌더한다.
    let docsOrderedDesc =
      direction === "last" ? [...snap.docs].reverse() : snap.docs;
    const hasNext = docsOrderedDesc.length > itemsPerPage;
    const docsForRender = hasNext
      ? docsOrderedDesc.slice(0, itemsPerPage)
      : docsOrderedDesc;

    const rows = [];
    docsForRender.forEach((d) => {
      const data = d.data();
      const itemsArr = (data.items || []).map((i) => ({
        name: i.name || "",
        quantity: Number(i.quantity || 0),
        price: Number(i.price || 0),
        total: Number(i.quantity || 0) * Number(i.price || 0),
      }));
      rows.push({
        date: formatDate(data.timestamp.toDate()),
        name: data.customerName,
        birth: data.customerBirth,
        items: itemsArr,
        itemsText: itemsArr
          .map((it) => `${it.name} (${it.quantity})`)
          .join(", "),
        handler: data.handledBy,
        lifelove: data.lifelove ? "O" : "",
        quarterKey: data.quarterKey,
      });
    });
    provisionData = rows;
    provisionCurrentPage = 1; // 서버 페이지 결과는 한 화면 분량 그대로
    // 커서 업데이트(현 페이지 첫/마지막 문서; 내림차순 기준)
    provCursor.firstDoc = docsForRender[0] || null;
    provCursor.lastDoc = docsForRender[docsForRender.length - 1] || null;

    provCursor.hasNext = provCursor.page < provCursor.totalPages;

    renderProvisionTable(provisionData);
    renderProvisionPagerA();
  } catch (e) {
    console.error(e);
    showToast?.("제공 내역(페이지)을 불러오지 못했습니다.");
  } finally {
    __cleanupSkel?.();
  }
}

// A안: Provision 서버 페이저 렌더
function renderProvisionPagerA() {
  const boxId = "provision-pagination";
  const current = provCursor.page || 1;
  const hasPrev = current > 1;
  const hasNext = current < (provCursor.totalPages || 1);
  const known = provCursor.totalPages || 1; // 총 페이지 수 확정 기반
  renderCursorPager(
    document.getElementById(boxId),
    { current, pagesKnown: known, hasPrev, hasNext },
    {
      goFirst: () => {
        if (hasPrev) {
          provCursor.firstDoc = null;
          provCursor.lastDoc = null;
          provCursor.page = 1;
          loadProvisionPage("init");
        }
      },
      goPrev: () => {
        if (hasPrev) loadProvisionPage("prev");
      },
      goNext: () => {
        if (hasNext) loadProvisionPage("next");
      },
      // 숫자 점프: 가까운 방향으로 연속 이동(최대 몇 번 안 됨)
      goPage: async (n) => {
        if (n === current) return;
        if (n < 1 || n > known) return;
        while (provCursor.page < n && provCursor.page < known) {
          await loadProvisionPage("next");
        }
        while (provCursor.page > n && provCursor.page > 1) {
          await loadProvisionPage("prev");
        }
      },
      goLast: () => {
        if (hasNext) loadProvisionPage("last");
      },
    },
    { window: 5 } // 슬라이딩 5칸
  );
}

/* =====================================================
 * Visit
 * ===================================================== */
async function loadVisitLogTable(periodKey) {
  let __cleanupSkel;
  try {
    __cleanupSkel = makeSectionSkeleton(
      document.getElementById("visit-log-section"),
      10
    );
    visitData = [];
    // visits에서 회계연도(periodKey)로 직접 조회 → 고객별 그룹핑
    const qv = query(
      collection(db, "visits"),
      where("periodKey", "==", periodKey),
      orderBy("day", "asc")
    );
    const snap = await getDocs(qv);
    if (snap.empty) {
      renderVisitTable([]);
      return;
    }
    const byCustomer = new Map(); // id -> { dates: Set<string> }
    const idSet = new Set();
    snap.forEach((d) => {
      const v = d.data();
      const cid = v.customerId;
      if (!cid) return;
      idSet.add(cid);
      const holder = byCustomer.get(cid) || { dates: new Set() };
      // 날짜 포맷: YYYY-MM-DD → YYYY.MM.DD
      let ds = v.dateKey;
      if (!ds && typeof v.day === "number") {
        const y = Math.floor(v.day / 10000),
          m = Math.floor((v.day % 10000) / 100),
          dd = v.day % 100;
        ds = `${y}-${String(m).padStart(2, "0")}-${String(dd).padStart(
          2,
          "0"
        )}`;
      }
      if (ds) holder.dates.add(ds.replace(/-/g, "."));
      byCustomer.set(cid, holder);
    });
    // 고객 메타 배치 조회
    const cmap = await fetchCustomersByIdsBatched([...idSet]);
    // 테이블 행 생성
    visitData = [...byCustomer.entries()].map(([cid, rec]) => {
      const c = cmap[cid] || {};
      const dates = [...rec.dates].sort().join(", ");
      return { name: c.name || "-", birth: c.birth || "-", dates };
    });
    visitData.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    visitCurrentPage = 1;
    renderVisitTable(visitData);
  } catch (e) {
    console.error(e);
    showToast?.("방문 일자를 불러오지 못했습니다.");
  } finally {
    __cleanupSkel?.();
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

  // Life 섹션 국소 스켈레톤
  const __cleanupSkel = makeSectionSkeleton(
    document.getElementById("life-section"),
    10
  );
  try {
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
  } finally {
    __cleanupSkel?.();
  }
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
  const pageItems = provCursor.serverMode ? data : data.slice(start, end);

  // 한 record(제공건) → 품목 수만큼 행 생성, 메타 컬럼은 rowspan
  pageItems.forEach((row, groupIdx) => {
    const items =
      Array.isArray(row.items) && row.items.length > 0
        ? row.items
        : [{ name: "-", quantity: "", price: "", total: "" }];
    const span = items.length + 1;
    const sumQty = items.reduce(
      (acc, it) => acc + (Number(it.quantity) || 0),
      0
    );
    const sumTotal = items.reduce(
      (acc, it) => acc + (Number(it.total) || 0),
      0
    );

    items.forEach((it, idx) => {
      const tr = document.createElement("tr");
      if (idx === 0) {
        tr.classList.add("group-sep");
        tr.innerHTML += `<td class="nowrap" rowspan="${span}">${row.date}</td>`;
        tr.innerHTML += `<td class="nowrap" rowspan="${span}">${row.name}</td>`;
        tr.innerHTML += `<td class="nowrap" rowspan="${span}">${row.birth}</td>`;
      }
      tr.innerHTML += `<td class="items-name">${it.name ?? ""}</td>`;
      tr.innerHTML += `<td class="num">${
        it.quantity !== "" ? Number(it.quantity).toLocaleString() : ""
      }</td>`;
      tr.innerHTML += `<td class="num">${
        it.price !== "" ? Number(it.price).toLocaleString() : ""
      }</td>`;
      tr.innerHTML += `<td class="num">${
        it.total !== "" ? Number(it.total).toLocaleString() : ""
      }</td>`;
      if (idx === 0) {
        tr.innerHTML += `<td class="nowrap" rowspan="${span}">${
          row.handler ?? ""
        }</td>`;
      }
      tbody.appendChild(tr);
    });
    // ▶ 소계(총합) 행 추가: 좌/우의 rowspan 셀이 이 행까지 덮고 있으므로 가운데 4칸만 출력
    const trTotal = document.createElement("tr");
    trTotal.classList.add("subtotal");
    trTotal.innerHTML += `<td class="subtotal-label">소계</td>`;
    trTotal.innerHTML += `<td class="num">${sumQty.toLocaleString()}</td>`;
    trTotal.innerHTML += `<td class="num"></td>`;
    trTotal.innerHTML += `<td class="num">${sumTotal.toLocaleString()}</td>`;
    tbody.appendChild(trTotal);
  });

  // 서버 페이지네이션 모드면 버튼만 토글, 아닌 경우 기존 페이지네이션
  if (provCursor.serverMode) {
    renderProvisionPagerA();
  } else {
    const totalPages = Math.max(1, Math.ceil(data.length / itemsPerPage));
    renderSimplePagerA(
      "provision-pagination",
      provisionCurrentPage,
      totalPages,
      (to) => {
        provisionCurrentPage = to;
        renderProvisionTable(data);
      }
    );
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

  const totalPages = Math.max(1, Math.ceil(data.length / itemsPerPage));
  renderSimplePagerA("visit-pagination", visitCurrentPage, totalPages, (to) => {
    visitCurrentPage = to;
    renderVisitTable(data);
  });
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

  const totalPages = Math.max(1, Math.ceil(data.length / itemsPerPage));
  renderSimplePagerA("life-pagination", lifeCurrentPage, totalPages, (to) => {
    lifeCurrentPage = to;
    renderLifeTable(data);
  });
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

// 품목을 행으로 펼쳐서 내보내기
function exportProvisionXLSX(rows, filename) {
  const flat = [];
  rows.forEach((r) => {
    const items =
      Array.isArray(r.items) && r.items.length
        ? r.items
        : [{ name: "-", quantity: "", price: "", total: "" }];
    const sumQty = items.reduce(
      (acc, it) => acc + (Number(it.quantity) || 0),
      0
    );
    const sumTotal = items.reduce(
      (acc, it) => acc + (Number(it.total) || 0),
      0
    );

    items.forEach((it, idx) => {
      flat.push({
        제공일: idx === 0 ? r.date : "",
        고객명: idx === 0 ? r.name : "",
        생년월일: idx === 0 ? r.birth : "",
        "가져간 품목명": it.name ?? "",
        수량: it.quantity ?? "",
        "개당 가격": it.price ?? "",
        총가격: it.total ?? "",
        처리자: idx === 0 ? r.handler ?? "" : "",
      });
    });
    // ▶ 소계 행을 별도로 추가
    flat.push({
      제공일: "",
      고객명: "",
      생년월일: "",
      "가져간 품목명": "소계",
      수량: sumQty,
      "개당 가격": "",
      총가격: sumTotal,
      처리자: "",
    });
  });
  const ws = XLSX.utils.json_to_sheet(flat);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, filename);
}
