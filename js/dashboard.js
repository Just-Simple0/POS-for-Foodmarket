import {
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  where,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { db } from "./components/firebase-config.js";

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
});

async function loadDashboardData() {
  try {
    const {
      visitData,
      todayItemsMap,
      todayItemsTotal,
      yesterdayItemsTotal,
    } = await fetchProvisionStats();

    renderVisitSection(visitData);
    renderItemSection(todayItemsMap, todayItemsTotal, yesterdayItemsTotal);
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

  const todayStr = today.toISOString().slice(0, 10);
  const yDate = new Date(today);
  yDate.setDate(yDate.getDate() - 1);
  const yesterdayStr = yDate.toISOString().slice(0, 10);

  const countsByDate = {};
  const todayItemsMap = {};
  let yesterdayItemsTotal = 0;

  try {
    const snapshot = await getDocs(
      query(
        collection(db, "provisions"),
        where("timestamp", ">=", Timestamp.fromDate(startDate)),
        where("timestamp", "<=", Timestamp.fromDate(endDate))
      )
    );

    snapshot.forEach((doc) => {
      const data = doc.data();
      const dateObj = data.timestamp?.toDate?.();
      const dateStr = dateObj.toISOString().slice(0, 10);
      countsByDate[dateStr] = (countsByDate[dateStr] || 0) + 1;

      if (dateStr === todayStr) {
        (data.items || []).forEach((item) => {
          todayItemsMap[item.name] =
            (todayItemsMap[item.name] || 0) + (item.quantity || 0);
        });
      } else if (dateStr === yesterdayStr) {
        (data.items || []).forEach((item) => {
          yesterdayItemsTotal += item.quantity || 0;
        });
      }
    });
  } catch (err) {
    console.error(err);
  }

  const visitData = [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(startDate);
    d.setDate(startDate.getDate() + i);
    const ds = d.toISOString().slice(0, 10);
    visitData.push({ date: ds, count: countsByDate[ds] || 0 });
  }

  const todayItemsTotal = Object.values(todayItemsMap).reduce(
    (sum, v) => sum + v,
    0
  );

  return { visitData, todayItemsMap, todayItemsTotal, yesterdayItemsTotal };
}

function renderVisitSection(visitData) {
  const labels = visitData.map((d) => d.date.slice(5));
  const counts = visitData.map((d) => d.count);

  const todayCustomer = visitData[visitData.length - 1] || { count: 0 };
  const yesterdayCustomer = visitData[visitData.length - 2] || { count: 0 };

  const customerDiff = todayCustomer.count - yesterdayCustomer.count;
  const customerRate =
    yesterdayCustomer.count > 0
      ? ((customerDiff / yesterdayCustomer.count) * 100).toFixed(1)
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

function renderItemSection(todayItemsMap, todayItemsTotal, yesterdayItemsTotal) {
  const itemDiff = todayItemsTotal - yesterdayItemsTotal;
  const itemRate =
    yesterdayItemsTotal > 0
      ? ((itemDiff / yesterdayItemsTotal) * 100).toFixed(1)
      : "0";

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
