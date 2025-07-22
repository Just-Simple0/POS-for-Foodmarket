// js/dashboard.js
import { db } from "./firebase-config.js";
import {
  collection,
  query,
  where,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export async function loadDashboard() {
  const salesCol = collection(db, "sales");
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
  const salesList = document.getElementById("sales-list");
  salesList.innerHTML = "";

  snapshot.forEach((doc) => {
    const sale = doc.data();
    const li = document.createElement("li");
    li.textContent = `${sale.customerName}님이 ${sale.productName}(${sale.price}원) 수령`;
    salesList.appendChild(li);
  });
}
