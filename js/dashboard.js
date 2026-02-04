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
import {
  withLoading,
  makeSectionSkeleton,
  makeWidgetSkeleton,
} from "./components/comp.js";

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
        dataObj.getMonth() + 1,
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
  loadDashboardData();

  // 통계로 이동
  const visitCard = document.getElementById("visit-card");
  const itemCard = document.getElementById("item-card");
  if (visitCard) onCardActivate(visitCard, () => navigateTo("statistics.html"));
  if (itemCard) onCardActivate(itemCard, () => navigateTo("statistics.html"));

  // 상품 페이지로 이동
  const recentProductCard = document.getElementById("recent-product-card");
  if (recentProductCard)
    onCardActivate(recentProductCard, () =>
      navigateTo("products.html?sort=latest"),
    );

  // 날짜 계산기 모달 오픈
  const expiryCard = document.getElementById("expiry-base-card");
  if (expiryCard) onCardActivate(expiryCard, () => openExpiryModal());
});

async function loadDashboardData() {
  const MIN_LOADING_TIME = 1000;

  // ✅ 4개 카드 모두 스켈레톤
  const cleanups = [];
  try {
    const ids = [
      "visit-card",
      "item-card",
      "recent-product-card",
      "expiry-base-card",
    ];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) cleanups.push(makeWidgetSkeleton(el));
    });

    // expiry 카드(날짜 계산)는 동기라 먼저 세팅해도 됨
    setExpiryInfo();

    // ✅ 데이터 로딩 2개(방문/물품 + 최근상품) + 최소 1초 지연을 동시에
    const taskStats = (async () => {
      const { visitData, todayItemsMap, todayItemsTotal, prevItemsTotal } =
        await fetchProvisionStats();
      renderVisitSection(visitData);
      renderItemSection(todayItemsMap, todayItemsTotal, prevItemsTotal);
    })();

    const taskRecent = loadRecentProducts(); // 내부에서 리스트 스켈레톤 처리 중이어도 OK
    const taskMinDelay = new Promise((r) => setTimeout(r, MIN_LOADING_TIME));

    await Promise.all([taskStats, taskRecent, taskMinDelay]);
  } catch (err) {
    console.error(err);
    // 실패해도 카드가 아예 비지 않게 기본값 렌더
    try {
      renderVisitSection([]);
      renderItemSection({}, 0, 0);
      // 최근 상품도 실패 처리
      const listEl = document.getElementById("recent-products-list");
      if (listEl && !listEl.innerHTML.trim()) {
        listEl.innerHTML =
          '<li class="text-slate-400 dark:text-slate-500 text-sm py-4 text-center">최근 내역이 없습니다.</li>';
      }
      setExpiryInfo();
    } catch (e) {
      console.error(e);
    }
  } finally {
    // ✅ 스켈레톤 제거
    cleanups.forEach((fn) => fn && fn());
  }
}

async function fetchProvisionStats() {
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - 9);
  startDate.setHours(0, 0, 0, 0);

  const endDate = new Date(today);
  endDate.setHours(23, 59, 59, 999);

  const countsByDate = {};
  const todayItemsMap = {};
  let prevItemsTotal = 0;
  let todayItemsTotal = 0;

  const todayKey8 = dateKey8Local(today); // 'YYYYMMDD'
  const yest = new Date(today);
  yest.setDate(yest.getDate() - 1);
  const yestKey8 = dateKey8Local(yest);

  // ✅ itemsTotalQty가 "0"일 수도 있으니, 존재 여부를 flag로 따로 들고 간다
  let todayHasItemStats = false;
  let yestHasItemStats = false;

  // ✅ 보험(필요할 때만) 스캔 함수: 하루치 provisions만 읽어서 itemsTotalQty/topMap 계산
  const scanProvisionsItemStatsByDate = async (d) => {
    const start = new Date(d);
    start.setHours(0, 0, 0, 0);
    const end = new Date(d);
    end.setHours(23, 59, 59, 999);

    const snap = await getDocs(
      query(
        collection(db, "provisions"),
        where("timestamp", ">=", Timestamp.fromDate(start)),
        where("timestamp", "<=", Timestamp.fromDate(end)),
      ),
    );

    let itemsTotalQty = 0;
    const map = {}; // name -> qty

    snap.forEach((docSnap) => {
      const items = docSnap.data()?.items || [];
      for (const it of items) {
        const q = Number(it?.quantity || 0);
        if (!Number.isFinite(q) || q <= 0) continue;
        itemsTotalQty += q;

        const name = (it?.name || "").toString().trim();
        if (!name) continue;
        map[name] = (map[name] || 0) + q;
      }
    });

    return { itemsTotalQty, map };
  };

  try {
    // 최근 10일(오늘 포함) stats_daily만 읽는다 (in: 최대 10개)
    const dayIds = [];
    for (
      let d = new Date(startDate);
      d <= endDate;
      d.setDate(d.getDate() + 1)
    ) {
      dayIds.push(dateKey8Local(d));
    }

    const dailySnap = await getDocs(
      query(collection(db, "stats_daily"), where(documentId(), "in", dayIds)),
    );

    dailySnap.forEach((docSnap) => {
      const id8 = docSnap.id; // 'YYYYMMDD'
      const data = docSnap.data() || {};

      // 방문자(차트/오늘 방문 카드)
      const y = id8.slice(0, 4);
      const m = id8.slice(4, 6);
      const d = id8.slice(6, 8);
      const ds = `${y}-${m}-${d}`;
      countsByDate[ds] = Number(data.uniqueVisitors || 0);

      // ✅ 오늘 물품 통계
      if (id8 === todayKey8) {
        if (typeof data.itemsTotalQty === "number") {
          todayHasItemStats = true;
          todayItemsTotal = Number(data.itemsTotalQty || 0);
        }

        // top 렌더용 map 채우기 (있으면 쓰고, 없으면 보험에서 채움)
        if (data.itemStatsById && typeof data.itemStatsById === "object") {
          Object.entries(data.itemStatsById).forEach(([pid, v]) => {
            const name = (v?.name || pid).toString();
            const qty = Number(v?.qty || 0);
            if (qty > 0) todayItemsMap[name] = (todayItemsMap[name] || 0) + qty;
          });
        } else if (Array.isArray(data.topItems20)) {
          data.topItems20.forEach((x) => {
            const name = (x?.name || "").toString();
            const qty = Number(x?.qty || 0);
            if (!name || qty <= 0) return;
            todayItemsMap[name] = (todayItemsMap[name] || 0) + qty;
          });
        }
      }

      // ✅ 어제 물품 통계(전일 대비)
      if (id8 === yestKey8) {
        if (typeof data.itemsTotalQty === "number") {
          yestHasItemStats = true;
          prevItemsTotal = Number(data.itemsTotalQty || 0);
        }
      }
    });

    // ✅ 보험: stats_daily에 item 값이 없을 때만 provisions 하루치 스캔 (오늘/어제만)
    if (!todayHasItemStats) {
      const { itemsTotalQty, map } = await scanProvisionsItemStatsByDate(today);
      todayItemsTotal = itemsTotalQty;

      // map을 todayItemsMap에 채워 넣기(기존에 일부 들어있어도 합산)
      Object.entries(map).forEach(([name, qty]) => {
        todayItemsMap[name] = (todayItemsMap[name] || 0) + qty;
      });
    }

    if (!yestHasItemStats) {
      const { itemsTotalQty } = await scanProvisionsItemStatsByDate(yest);
      prevItemsTotal = itemsTotalQty;
    }
  } catch (err) {
    console.error(err);
  }

  // 최근 10일 데이터(없는 날은 0)
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
      visitChangeEl.innerHTML = `<span class="badge badge-sm badge-weak-success">▲ ${customerDiff}명 (${customerRate}%)</span>`;
    } else if (customerDiff < 0) {
      visitChangeEl.innerHTML = `<span class="badge badge-sm badge-weak-danger">▼ ${Math.abs(
        customerDiff,
      )}명 (${customerRate}%)</span>`;
    } else {
      visitChangeEl.innerHTML = `<span class="badge badge-sm badge-weak-grey">변동 없음</span>`;
    }
  }

  // Chart.js 스타일 TDS 최적화
  const ctx = document.getElementById("visit-chart");
  if (ctx) {
    new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            data: counts,
            borderColor: "#3182F6", // TDS Primary Blue
            backgroundColor: "rgba(49, 130, 246, 0.05)",
            fill: true,
            tension: 0.4,
            pointRadius: 0, // 기본 상태에서는 점을 숨김
            pointHoverRadius: 5, // 마우스 올렸을 때만 점 크기를 키움
            pointHoverBackgroundColor: "#3182F6",
            pointHoverBorderColor: "#fff",
            pointHoverBorderWidth: 2,
            borderWidth: 3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true, // 툴팁 활성화
            intersect: false, // 라인 근처만 가도 툴팁 표시
            mode: "index",
          },
        },
        scales: { x: { display: false }, y: { display: false } },
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
    const colorClass =
      itemDiff > 0
        ? "badge-weak-success"
        : itemDiff < 0
          ? "badge-weak-danger"
          : "badge-weak-grey";
    const icon = itemDiff > 0 ? "▲" : itemDiff < 0 ? "▼" : "";
    itemChangeEl.innerHTML = `<span class="badge badge-sm ${colorClass}">${icon} ${Math.abs(
      itemDiff,
    )}개 (${itemRate}%)</span>`;
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

  // daterangepicker 초기화 (jQuery 사용)
  const $base = $(baseEl);
  if (!$base.data("daterangepicker")) {
    $base.daterangepicker(
      {
        singleDatePicker: true,
        showDropdowns: true,
        autoApply: true,
        locale: {
          format: "YYYY-MM-DD",
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
          daysOfWeek: ["일", "월", "화", "수", "목", "금", "토"],
        },
      },
      function (start) {
        renderBaseResults(start.toDate());
      },
    );
  }

  // 오늘 날짜로 세팅
  $base.data("daterangepicker").setStartDate(new Date());
  renderBaseResults(new Date());

  todayBtn.onclick = () => {
    const today = new Date();
    $base.data("daterangepicker").setStartDate(today);
    renderBaseResults(today);
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

  function renderBaseResults(selectedDate) {
    const base = selectedDate || parseDateInput(baseEl.value);
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
