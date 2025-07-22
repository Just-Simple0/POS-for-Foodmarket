// js/customers.js
import { db } from "./firebase-config.js";
import {
  collection,
  getDocs,
  setDoc,
  doc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const customersCol = collection(db, "customers");

// 고객 목록 불러오기
export async function loadCustomers() {
  const snapshot = await getDocs(customersCol);
  const list = document.getElementById("customer-list");
  list.innerHTML = "";
  snapshot.forEach((doc) => {
    const c = doc.data();
    const li = document.createElement("li");
    li.textContent = `${c.name} - 사용 포인트: ${c.pointsUsed || 0}`;
    list.appendChild(li);
  });
}

// 신규 고객 등록
export async function addCustomer(id, name) {
  await setDoc(doc(db, "customers", id), { name, pointsUsed: 0 });
  alert("고객 등록 완료");
}
