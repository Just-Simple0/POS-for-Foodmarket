import { db } from "./firebase-config.js";
import {
  collection,
  addDoc,
  getDocs,
  query,
  where,
  deleteDoc,
  updateDoc,
  doc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const productsCol = collection(db, "products");

let currentEditId = null;

// 상품 등록
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
  loadProducts();
}

// 상품 목록 로드 및 렌더링
export async function loadProducts() {
  const snapshot = await getDocs(productsCol);
  const productList = document.getElementById("product-list");
  productList.innerHTML = "";

  snapshot.forEach((docSnap) => {
    const p = docSnap.data();
    const id = docSnap.id;

    const card = document.createElement("div");
    card.className = "product-card";

    card.innerHTML = `
      <div class="name">${p.name}</div>
      <div class="price">${p.price.toLocaleString()}원</div>
      <div class="barcode">바코드: ${p.barcode}</div>
      <div>
        <button data-id="${id}" class="edit">수정</button>
        <button data-id="${id}" class="delete-btn">삭제</button>
      </div>
    `;

    productList.appendChild(card);
  });
}

// 폼 이벤트 연결 및 초기 로드
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("product-form");
  const modal = document.getElementById("edit-modal");
  const editForm = document.getElementById("edit-form");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("product-name").value.trim();
    const price = document.getElementById("product-price").value.trim();
    const barcode = document.getElementById("product-barcode").value.trim();

    if (name && price && barcode) {
      await addProduct(name, price, barcode);
      form.reset();
    }
  });

  // 상품 목록 내 버튼 이벤트 위임 (수정/삭제)
  document
    .getElementById("product-list")
    .addEventListener("click", async (e) => {
      if (e.target.classList.contains("delete-btn")) {
        const id = e.target.dataset.id;
        if (confirm("정말 삭제하시겠습니까?")) {
          await deleteDoc(doc(db, "products", id));
          alert("삭제되었습니다.");
          loadProducts();
        }
      }

      if (e.target.classList.contains("edit")) {
        currentEditId = e.target.dataset.id;
        // Firestore에서 해당 상품 데이터 불러오기
        const snapshot = await getDocs(
          query(productsCol, where("__name__", "==", currentEditId))
        );
        const data = snapshot.docs[0].data();

        document.getElementById("edit-name").value = data.name;
        document.getElementById("edit-price").value = data.price;
        document.getElementById("edit-barcode").value = data.barcode;

        modal.classList.remove("hidden");
      }
    });

  // 모달 저장 버튼
  editForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("edit-name").value.trim();
    const price = Number(document.getElementById("edit-price").value.trim());
    const barcode = document.getElementById("edit-barcode").value.trim();

    if (name && price && barcode) {
      await updateDoc(doc(db, "products", currentEditId), {
        name,
        price,
        barcode,
      });
      alert("수정이 완료되었습니다.");
      modal.classList.add("hidden");
      loadProducts();
    }
  });

  // 모달 취소 버튼
  document.getElementById("cancel-edit").addEventListener("click", () => {
    modal.classList.add("hidden");
  });

  // 페이지 로딩 시 상품 목록 표시
  loadProducts();
});
