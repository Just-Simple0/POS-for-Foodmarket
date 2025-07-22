// js/products.js
import { db } from "./firebase-config.js";
import {
  collection,
  addDoc,
  getDocs,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const productsCol = collection(db, "products");

// 상품 등록 (중복 바코드 확인 포함)
export async function addProduct(name, price, barcode) {
  const q = query(productsCol, where("barcode", "==", barcode));
  const existing = await getDocs(q);
  if (!existing.empty) {
    alert("이미 등록된 바코드입니다.");
    return;
  }
  await addDoc(productsCol, {
    name,
    price: Number(price),
    barcode,
    createdAt: new Date(),
  });
  alert("상품 등록 완료");
}

// 모든 상품 불러오기
export async function loadProducts() {
  const snapshot = await getDocs(productsCol);
  const productList = document.getElementById("product-list");
  productList.innerHTML = "";
  snapshot.forEach((doc) => {
    const p = doc.data();
    const li = document.createElement("li");
    li.textContent = `${p.name} - ${p.price}원 (바코드: ${p.barcode})`;
    productList.appendChild(li);
  });
}
