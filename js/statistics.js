// js/statistics.js
import { db } from "./firebase-config.js";
import {
  collection,
  query,
  where,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const salesCol = collection(db, "sales");

export async function loadTodayStats() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const q = query(
    salesCol,
    where("createdAt", ">=", today),
    where("createdAt", "<", tomorrow)
  );

  const snapshot = await getDocs(q);
  const statsContainer = document.getElementById("stats-container");
  statsContainer.innerHTML = "";

  let total = 0;
  snapshot.forEach((doc) => {
    const sale = doc.data();
    total += sale.price;
    const div = document.createElement("div");
    div.textContent = `${sale.customerName} 님이 ${sale.productName}(${sale.price}원) 수령`;
    statsContainer.appendChild(div);
  });

  const totalDiv = document.createElement("div");
  totalDiv.style.fontWeight = "bold";
  totalDiv.textContent = `오늘 총 수령 금액: ${total}원`;
  statsContainer.appendChild(totalDiv);
}
