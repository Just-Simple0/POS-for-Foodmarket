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
  const snapshot = await getDocs(q);

  const listEl = document.getElementById("recent-products-list");
  if (!listEl) return;
  listEl.innerHTML = ""; // 기존 내용 초기화

  snapshot.forEach((doc) => {
    const data = doc.data();
    const dataObj = data.lastestAt?.toDate?.();

    const formatted = `${dataObj.getFullYear()}.${String(
      dataObj.getMonth() + 1
    ).padStart(2, "0")}.${String(dataObj.getDate()).padStart(2, "0")}`;

    const li = document.createElement("li");
    li.textContent = `${data.name} (${formatted})`;
    listEl.appendChild(li);
  });
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
  await loadDashboardData();
  loadRecentProducts();
  setExpiryInfo();

  // 통계로 이동: 이용 고객 수 / 제공된 물품 수
  const visitCard = document.getElementById("visit-card");
  const itemCard = document.getElementById("item-card");
  if (visitCard) onCardActivate(visitCard, () => navigateTo("statistics.html"));
  if (itemCard) onCardActivate(itemCard, () => navigateTo("statistics.html"));

  // 상품 페이지로 이동 (등록순 필터 의도 전달: sort=latest 파라미터)
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
  try {
    const { visitData, todayItemsMap, todayItemsTotal, prevItemsTotal } =
      await fetchProvisionStats();

    renderVisitSection(visitData);
    renderItemSection(todayItemsMap, todayItemsTotal, prevItemsTotal);
  } catch (err) {
    console.error(err);
    renderVisitSection([]);
    renderItemSection({}, 0, 0);
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
  const countsByDate = {}; // 'YYYY-MM-DD' → uniqueVisitors (stats_daily)
  const todayItemsMap = {}; // 오늘 품목 합계 (provisions에서 오늘만)
  let prevItemsTotal = 0; // 어제 품목 합계 (provisions에서 어제만)
  let todayItemsTotal = 0; // 오늘 품목 합계

  try {
    // 1) 방문 인원수(최근 10일): stats_daily에서 10건만 조회
    const dayIds = [];
    for (
      let d = new Date(startDate);
      d <= endDate;
      d.setDate(d.getDate() + 1)
    ) {
      dayIds.push(dateKey8Local(d));
    }
    // documentId() 'in'은 최대 10개 → 최근 10일과 정확히 일치
    const dailySnap = await getDocs(
      query(collection(db, "stats_daily"), where(documentId(), "in", dayIds))
    );
    dailySnap.forEach((docSnap) => {
      const id8 = docSnap.id; // 'YYYYMMDD'
      const y = id8.slice(0, 4),
        m = id8.slice(4, 6),
        d = id8.slice(6, 8);
      const ds = `${y}-${m}-${d}`;
      const v = Number(docSnap.data()?.uniqueVisitors || 0);
      countsByDate[ds] = v;
    });

    // 2) 오늘 품목 합계: provisions에서 '오늘 하루'만 조회
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

    // 3) 어제 품목 합계(전일 비교용): provisions에서 '어제 하루'만 조회
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
      visitChangeEl.className = "up";
    } else if (customerDiff < 0) {
      visitChangeEl.textContent = `▼ ${Math.abs(
        customerDiff
      )}명 (${customerRate}%) 감소`;
      visitChangeEl.className = "down";
    } else {
      visitChangeEl.textContent = `변동 없음`;
      visitChangeEl.className = "";
    }
  }

  const ctx = document.getElementById("visit-chart");
  if (ctx) {
    new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "이용 고객 수",
            data: counts,
            borderColor: "#1976d2",
            backgroundColor: "rgba(25, 118, 210, 0.2)",
            fill: true,
            tension: 0.3,
            pointRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
        },
        scales: {
          y: { beginAtZero: true },
        },
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
      itemChangeEl.className = "up";
    } else if (itemDiff < 0) {
      itemChangeEl.textContent = `▼ ${Math.abs(
        itemDiff
      )}개 (${itemRate}%) 감소`;
      itemChangeEl.className = "down";
    } else {
      itemChangeEl.textContent = `변동 없음`;
      itemChangeEl.className = "";
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
      const li = document.createElement("li");
      li.textContent = "데이터 없음";
      topList.appendChild(li);
    } else {
      topThree.forEach((item, index) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="medal">${medals[index]}</span> ${item.name} (${item.count}개)`;
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
  // 초기값: 오늘
  const today = new Date();
  baseEl.value = formatDateInput(today);
  renderBaseResults();

  // 기준일 변경 시 즉시 20/30 갱신
  baseEl.addEventListener("change", renderBaseResults);
  baseEl.addEventListener("input", renderBaseResults);

  // 오늘 버튼
  todayBtn.addEventListener("click", () => {
    baseEl.value = formatDateInput(new Date());
    renderBaseResults();
  });

  // 사용자 지정 계산
  customBtn.addEventListener("click", () => {
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
  });

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  const close = () => {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  };
  closeBtn.addEventListener("click", close, { once: true });
  modal.addEventListener(
    "click",
    (e) => {
      if (e.target === modal) close();
    },
    { once: true }
  );
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

// === (3) 날짜 유틸 ===
function formatDateInput(d) {
  // YYYY-MM-DD
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function formatDateOut(d) {
  // YYYY.MM.DD
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
