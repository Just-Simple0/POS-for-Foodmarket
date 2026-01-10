import {
  collection,
  query,
  getDocs,
  where,
  Timestamp,
  documentId,
  orderBy,
  limit,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { db } from "./components/firebase-config.js";
import { withLoading, makeSectionSkeleton } from "./components/comp.js";

// 로컬(KST) 기준 날짜 키: 'YYYY-MM-DD'
function dateKeyLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 로컬(KST) 기준 날짜 숫자키: 'YYYYMMDD'
function dateKey8Local(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

async function loadRecentProducts() {
  const productsRef = collection(db, "products");
  const q = query(productsRef, orderBy("lastestAt", "desc"), limit(6));
  const listEl = document.getElementById("recent-products-list");
  // 리스트 영역 스켈레톤
  let __skList;
  try {
    __skList = makeSectionSkeleton(listEl, 6);
    const snapshot = await getDocs(q);
    listEl.innerHTML = ""; // 기존 내용 초기화

    if (snapshot.empty) {
      // [수정] 다크모드 텍스트 색상 적용
      listEl.innerHTML =
        '<li class="text-slate-400 dark:text-slate-500 text-sm py-4 text-center">최근 내역이 없습니다.</li>';
      return;
    }

    snapshot.forEach((doc) => {
      const data = doc.data();
      const dataObj = data.lastestAt?.toDate?.();
      const formatted = `${dataObj.getFullYear()}.${String(
        dataObj.getMonth() + 1
      ).padStart(2, "0")}.${String(dataObj.getDate()).padStart(2, "0")}`;

      const li = document.createElement("li");
      // [수정] 다크모드 배경, 보더, 호버 색상 적용
      li.className =
        "flex items-center justify-between py-3 px-3.5 bg-slate-50 dark:bg-slate-700/50 hover:bg-blue-50 dark:hover:bg-blue-900/20 border border-slate-100 dark:border-slate-700 hover:border-blue-100 dark:hover:border-blue-800 rounded-xl transition-colors duration-200 group/item";

      // [수정] 텍스트 및 배지 다크모드 적용
      li.innerHTML = `
        <span class="font-medium text-slate-700 dark:text-slate-200 group-hover/item:text-blue-700 dark:group-hover/item:text-blue-400 truncate mr-2">${data.name}</span>
        <span class="text-xs font-medium text-slate-400 dark:text-slate-400 bg-white dark:bg-slate-800 px-2 py-1 rounded-md border border-slate-100 dark:border-slate-600 whitespace-nowrap">${formatted}</span>
      `;
      listEl.appendChild(li);
    });
  } catch (e) {
    console.error(e);
  } finally {
    __skList?.();
  }
}

function navigateTo(url) {
  window.location.href = url;
}
function onCardActivate(el, cb) {
  el.addEventListener("click", cb);
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      cb();
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
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
  // 초기 로딩을 전역 오버레이로 묶어 사용자가 '모두 로드된 뒤' 이용하게 함
  await withLoading(async () => {
    await loadDashboardData();
    await loadRecentProducts();
    setExpiryInfo();
  }, "대시보드 데이터 불러오는 중…");

  // 통계로 이동
  const visitCard = document.getElementById("visit-card");
  const itemCard = document.getElementById("item-card");
  if (visitCard) onCardActivate(visitCard, () => navigateTo("statistics.html"));
  if (itemCard) onCardActivate(itemCard, () => navigateTo("statistics.html"));

  // 상품 페이지로 이동
  const recentProductCard = document.getElementById("recent-product-card");
  if (recentProductCard)
    onCardActivate(recentProductCard, () =>
      navigateTo("products.html?sort=latest")
    );

  // 날짜 계산기 모달 오픈
  const expiryCard = document.getElementById("expiry-base-card");
  if (expiryCard) onCardActivate(expiryCard, () => openExpiryModal());
});

async function loadDashboardData() {
  let __skVisit, __skItems;
  try {
    __skVisit = makeSectionSkeleton(document.getElementById("visit-card"), 6);
    __skItems = makeSectionSkeleton(document.getElementById("item-card"), 6);
    const { visitData, todayItemsMap, todayItemsTotal, prevItemsTotal } =
      await fetchProvisionStats();

    renderVisitSection(visitData);
    renderItemSection(todayItemsMap, todayItemsTotal, prevItemsTotal);
  } catch (err) {
    console.error(err);
    renderVisitSection([]);
    renderItemSection({}, 0, 0);
  } finally {
    __skVisit?.();
    __skItems?.();
  }
}

async function fetchProvisionStats() {
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 9);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(today);
  endDate.setHours(23, 59, 59, 999);

  const todayStr = dateKeyLocal(today);
  const countsByDate = {};
  const todayItemsMap = {};
  let prevItemsTotal = 0;
  let todayItemsTotal = 0;

  try {
    const dayIds = [];
    for (
      let d = new Date(startDate);
      d <= endDate;
      d.setDate(d.getDate() + 1)
    ) {
      dayIds.push(dateKey8Local(d));
    }
    const dailySnap = await getDocs(
      query(collection(db, "stats_daily"), where(documentId(), "in", dayIds))
    );
    dailySnap.forEach((docSnap) => {
      const id8 = docSnap.id;
      const y = id8.slice(0, 4),
        m = id8.slice(4, 6),
        d = id8.slice(6, 8);
      const ds = `${y}-${m}-${d}`;
      const v = Number(docSnap.data()?.uniqueVisitors || 0);
      countsByDate[ds] = v;
    });

    const todayStart = new Date(today);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);
    const todaySnap = await getDocs(
      query(
        collection(db, "provisions"),
        where("timestamp", ">=", Timestamp.fromDate(todayStart)),
        where("timestamp", "<=", Timestamp.fromDate(todayEnd))
      )
    );
    todaySnap.forEach((docSnap) => {
      const data = docSnap.data();
      (data.items || []).forEach((item) => {
        const qty = Number(item.quantity || 0);
        todayItemsTotal += qty;
        todayItemsMap[item.name] = (todayItemsMap[item.name] || 0) + qty;
      });
    });

    const yst = new Date(today);
    yst.setDate(yst.getDate() - 1);
    yst.setHours(0, 0, 0, 0);
    const yen = new Date(today);
    yen.setDate(yen.getDate() - 1);
    yen.setHours(23, 59, 59, 999);
    const ySnap = await getDocs(
      query(
        collection(db, "provisions"),
        where("timestamp", ">=", Timestamp.fromDate(yst)),
        where("timestamp", "<=", Timestamp.fromDate(yen))
      )
    );
    ySnap.forEach((docSnap) => {
      const data = docSnap.data();
      (data.items || []).forEach((item) => {
        prevItemsTotal += Number(item.quantity || 0);
      });
    });
  } catch (err) {
    console.error(err);
  }

  const visitData = [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const ds = dateKeyLocal(d);
    visitData.push({ date: ds, count: countsByDate[ds] || 0 });
  }

  return { visitData, todayItemsMap, todayItemsTotal, prevItemsTotal };
}

function renderVisitSection(visitData) {
  const labels = visitData.map((d) => d.date.slice(5));
  const counts = visitData.map((d) => d.count);

  const todayCustomer = visitData[visitData.length - 1] || { count: 0 };
  let prevCustomer = { count: 0 };
  for (let i = visitData.length - 2; i >= 0; i--) {
    if (visitData[i].count > 0) {
      prevCustomer = visitData[i];
      break;
    }
  }

  const customerDiff = todayCustomer.count - prevCustomer.count;
  const customerRate =
    prevCustomer.count > 0
      ? ((customerDiff / prevCustomer.count) * 100).toFixed(1)
      : "0";

  const visitCountEl = document.getElementById("visit-count");
  const visitChangeEl = document.getElementById("visit-change");

  if (visitCountEl) visitCountEl.textContent = `${todayCustomer.count}명`;

  if (visitChangeEl) {
    if (customerDiff > 0) {
      visitChangeEl.textContent = `▲ ${customerDiff}명 (${customerRate}%) 증가`;
      // [수정] 다크모드 대응 (bg-emerald-900/30, text-emerald-400)
      visitChangeEl.className =
        "text-sm font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 px-2 py-0.5 rounded-md ml-1";
    } else if (customerDiff < 0) {
      visitChangeEl.textContent = `▼ ${Math.abs(
        customerDiff
      )}명 (${customerRate}%) 감소`;
      // [수정] 다크모드 대응 (bg-rose-900/30, text-rose-400)
      visitChangeEl.className =
        "text-sm font-bold text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/30 px-2 py-0.5 rounded-md ml-1";
    } else {
      visitChangeEl.textContent = `변동 없음`;
      // [수정] 다크모드 대응
      visitChangeEl.className =
        "text-sm font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-700 px-2 py-0.5 rounded-md ml-1";
    }
  }

  const ctx = document.getElementById("visit-chart");
  if (ctx) {
    const existingChart = Chart.getChart(ctx);
    if (existingChart) existingChart.destroy();

    new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "이용 고객 수",
            data: counts,
            borderColor: "#3b82f6", // blue-500
            backgroundColor: "rgba(59, 130, 246, 0.1)",
            fill: true,
            tension: 0.4,
            pointRadius: 4,
            pointBackgroundColor: "#fff",
            pointBorderColor: "#3b82f6",
            pointBorderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
        },
        scales: {
          x: { display: false },
          y: { display: false, beginAtZero: true },
        },
        layout: { padding: 5 },
      },
    });
  }
}

function renderItemSection(todayItemsMap, todayItemsTotal, prevItemsTotal) {
  const itemDiff = todayItemsTotal - prevItemsTotal;
  const itemRate =
    prevItemsTotal > 0 ? ((itemDiff / prevItemsTotal) * 100).toFixed(1) : "0";

  const itemCountEl = document.getElementById("item-total");
  const itemChangeEl = document.getElementById("item-change");

  if (itemCountEl) itemCountEl.textContent = `총 ${todayItemsTotal}개`;
  if (itemChangeEl) {
    if (itemDiff > 0) {
      itemChangeEl.textContent = `▲ ${itemDiff}개 (${itemRate}%) 증가`;
      // [수정] 다크모드 대응
      itemChangeEl.className =
        "text-sm font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 px-2 py-0.5 rounded-md inline-block";
    } else if (itemDiff < 0) {
      itemChangeEl.textContent = `▼ ${Math.abs(
        itemDiff
      )}개 (${itemRate}%) 감소`;
      // [수정] 다크모드 대응
      itemChangeEl.className =
        "text-sm font-bold text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/30 px-2 py-0.5 rounded-md inline-block";
    } else {
      itemChangeEl.textContent = `변동 없음`;
      // [수정] 다크모드 대응
      itemChangeEl.className =
        "text-sm font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-700 px-2 py-0.5 rounded-md inline-block";
    }
  }

  const topList = document.getElementById("top-items-list");
  if (topList) {
    topList.innerHTML = "";
    const entries = Object.entries(todayItemsMap).map(([name, count]) => ({
      name,
      count,
    }));
    const topThree = entries.sort((a, b) => b.count - a.count).slice(0, 3);
    const medals = ["🥇", "🥈", "🥉"];
    if (topThree.length === 0) {
      // [수정] 다크모드 대응
      const li = document.createElement("li");
      li.className =
        "text-sm text-slate-400 dark:text-slate-500 text-center py-2";
      li.textContent = "데이터 없음";
      topList.appendChild(li);
    } else {
      topThree.forEach((item, index) => {
        const li = document.createElement("li");
        // [수정] 리스트 아이템 다크모드 대응
        li.className =
          "flex items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-slate-700/50 border border-slate-100 dark:border-slate-700";
        li.innerHTML = `
            <div class="flex items-center gap-2">
                <span class="text-xl">${medals[index]}</span>
                <span class="text-sm font-bold text-slate-700 dark:text-slate-200">${item.name}</span>
            </div>
            <span class="text-sm font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 px-2 py-0.5 rounded-md">${item.count}개</span>
        `;
        topList.appendChild(li);
      });
    }
  }
}

function setExpiryInfo() {
  function formatDate(dataObj) {
    const yyyy = dataObj.getFullYear();
    const mm = String(dataObj.getMonth() + 1).padStart(2, "0");
    const dd = String(dataObj.getDate()).padStart(2, "0");
    return `${yyyy}.${mm}.${dd}`;
  }

  const today = new Date();
  const todayStr = formatDate(today);

  const snackDrinkDate = new Date(today);
  snackDrinkDate.setDate(snackDrinkDate.getDate() + 20);

  const foodDailyDate = new Date(today);
  foodDailyDate.setDate(foodDailyDate.getDate() + 30);

  document.getElementById("today-date").textContent = todayStr;
  document.getElementById("expiry-snack-drink").textContent =
    formatDate(snackDrinkDate);
  document.getElementById("expiry-food-daily").textContent =
    formatDate(foodDailyDate);
}

function openExpiryModal() {
  const modal = document.getElementById("expiry-modal");
  const baseEl = document.getElementById("expiry-base-date");
  const todayBtn = document.getElementById("expiry-today-btn");
  const closeBtn = document.getElementById("expiry-modal-close");

  const out20 = document.getElementById("expiry-20");
  const out30 = document.getElementById("expiry-30");

  const customDays = document.getElementById("expiry-custom-days");
  const customBtn = document.getElementById("expiry-calc-btn");
  const customOut = document.getElementById("expiry-custom-result");

  if (!baseEl._flatpickr) {
    flatpickr(baseEl, {
      locale: "ko",
      dateFormat: "Y-m-d",
      defaultDate: "today",
      disableMobile: true,
      animate: true,
      onChange: function (selectedDates, dateStr, instance) {
        renderBaseResults();
      },
    });
  }

  const today = new Date();
  baseEl._flatpickr.setDate(today);
  renderBaseResults();

  todayBtn.onclick = () => {
    baseEl._flatpickr.setDate(new Date());
    renderBaseResults();
  };

  customBtn.onclick = () => {
    const base = parseDateInput(baseEl.value);
    const n = Number(customDays.value);
    if (!base) {
      customOut.textContent = "유효한 기준 날짜를 입력하세요";
      return;
    }
    if (!Number.isFinite(n) || n < 0) {
      customOut.textContent = "추가 일수를 올바르게 입력하세요";
      return;
    }
    customOut.textContent = formatDateOut(addDaysToDate(base, n));
  };

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");

  const close = () => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  };

  closeBtn.onclick = close;

  modal.onclick = (e) => {
    if (e.target === modal) close();
  };

  window.addEventListener("keydown", function escHandler(e) {
    if (e.key === "Escape") {
      close();
      window.removeEventListener("keydown", escHandler);
    }
  });

  function renderBaseResults() {
    const base = parseDateInput(baseEl.value);
    if (!base) {
      out20.textContent = "-";
      out30.textContent = "-";
      return;
    }
    out20.textContent = formatDateOut(addDaysToDate(base, 20));
    out30.textContent = formatDateOut(addDaysToDate(base, 30));
  }
}

function formatDateInput(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function formatDateOut(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd}`;
}
function parseDateInput(v) {
  if (!v) return null;
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t;
}
function addDaysToDate(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}
