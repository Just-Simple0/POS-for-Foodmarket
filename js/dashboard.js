import {
  collection,
  query,
  orderBy,
  limit,
  getDocs,
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

document.addEventListener("DOMContentLoaded", () => {
  // 임의 데이터
  const visitData = [
    { date: "2025-07-10", count: 15 },
    { date: "2025-07-11", count: 20 },
    { date: "2025-07-14", count: 21 },
    { date: "2025-07-15", count: 19 },
    { date: "2025-07-16", count: 23 },
    { date: "2025-07-17", count: 18 },
    { date: "2025-07-18", count: 27 },
    { date: "2025-07-19", count: 0 },
    { date: "2025-07-22", count: 28 },
    { date: "2025-07-23", count: 32 }, // 어제
    { date: "2025-07-24", count: 30 }, // 오늘
  ];
  const todayItems = [
    { name: "초코우유", count: 18 },
    { name: "콜라", count: 15 },
    { name: "사이다", count: 10 },
    { name: "과자", count: 8 },
    { name: "햄버거", count: 7 },
  ];
  const yesterdayItems = [
    { name: "초코우유", quantity: 15 },
    { name: "사과", quantity: 12 },
    { name: "샌드위치", quantity: 9 },
    { name: "바나나", quantity: 5 },
    { name: "우유", quantity: 12 },
  ];

  // 오늘 방문한 고객 수와 최근 10일간의 방문 데이터 처리
  const recentData = visitData.slice(-10);

  const labels = recentData.map((d) => d.date.slice(5)); // MM-DD
  const counts = recentData.map((d) => d.count);

  const todayCustomer = recentData[recentData.length - 1];
  const yesterdayCustomer = recentData[recentData.length - 2];

  const customerDiff = todayCustomer.count - yesterdayCustomer.count;
  const customerRate =
    yesterdayCustomer.count > 0
      ? ((customerDiff / yesterdayCustomer.count) * 100).toFixed(1)
      : "0";

  // HTML 요소에 값 반영
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

  // 차트 렌더링
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

  // 오늘 제공된 물품 정보 처리

  //총 수량 계산
  const todayItemsTotal = todayItems.reduce((sum, item) => sum + item.count, 0);
  const yesterdayItemsTotal = yesterdayItems.reduce(
    (sum, item) => sum + item.quantity,
    0
  );
  const itemDiff = todayItemsTotal - yesterdayItemsTotal;
  const itemRate =
    yesterdayItemsTotal > 0
      ? ((itemDiff / yesterdayItemsTotal) * 100).toFixed(1)
      : "0";

  const itemCountEl = document.getElementById("item-total");
  const itemChangeEl = document.getElementById("item-change");

  // 렌더링
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
  // 수량 내림차순 정렬 후 상위 3개 추출
  const topThree = [...todayItems]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  // 리스트 렌더링
  const topList = document.getElementById("top-items-list");
  topList.innerHTML = ""; // 기존 내용 초기화
  const medals = ["🥇", "🥈", "🥉"];
  topThree.forEach((item, index) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="medal">${medals[index]}</span> ${item.name} (${item.count}개)`;
    topList.appendChild(li);
  });

  // 🔄 최신 상품 불러오기
  loadRecentProducts();

  function formatDate(dataObj) {
    const yyyy = dataObj.getFullYear();
    const mm = String(dataObj.getMonth() + 1).padStart(2, "0"); // 월은 0부터 시작
    const dd = String(dataObj.getDate()).padStart(2, "0");
    return `${yyyy}.${mm}.${dd}`;
  }

  const today = new Date();
  const todayStr = formatDate(today);

  const snackDrinkDate = new Date(today);
  snackDrinkDate.setDate(snackDrinkDate.getDate() + 20); // 20일 후

  const foodDailyDate = new Date(today);
  foodDailyDate.setDate(foodDailyDate.getDate() + 30); // 30일 후

  document.getElementById("today-date").textContent = todayStr;
  document.getElementById("expiry-snack-drink").textContent =
    formatDate(snackDrinkDate);
  document.getElementById("expiry-food-daily").textContent =
    formatDate(foodDailyDate);
});
