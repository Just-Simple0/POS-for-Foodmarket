import { db } from "./components/firebase-config.js";
import {
  collection,
  getDocs,
  addDoc,
  deleteDoc,
  updateDoc,
  doc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const productsCol = collection(db, "products");

let allProducts = [];
let filteredProducts = [];
let currentPage = 1;
let editingProductId = null; // 수정할 상품 ID
const itemsPerPage = 25;

const productList = document.getElementById("product-list");
const pagination = document.getElementById("pagination");

// 🔔 토스트 메시지 표시
function showToast(message, isError = false) {
  const toast = document.getElementById("toast");
  toast.innerHTML = message;

  toast.classList.add("show");
  if (isError) {
    toast.classList.add("error");
  } else {
    toast.classList.remove("error");
  }

  setTimeout(() => {
    toast.classList.remove("show");
  }, 2000);
}

// 🔄 상품 전체 불러오기
async function loadProducts() {
  const snapshot = await getDocs(productsCol);
  allProducts = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));
  applyFiltersAndSort();
}

// 🔄 필터 및 정렬 적용 후 렌더링
function applyFiltersAndSort() {
  const nameFilter = document
    .getElementById("product-name")
    .value.trim()
    .toLowerCase();
  const barcodeFilter = document.getElementById("product-barcode").value.trim();
  const sortBy = document.getElementById("sort-select")?.value || "price";

  filteredProducts = allProducts.filter((p) => {
    const nameMatch = p.name.toLowerCase().includes(nameFilter);
    const barcodeMatch = barcodeFilter
      ? p.barcode.includes(barcodeFilter)
      : true;
    return nameMatch && barcodeMatch;
  });

  filteredProducts.sort((a, b) => {
    if (sortBy === "price") {
      return a.price - b.price;
    } else if (sortBy === "name") {
      return a.name.localeCompare(b.name);
    } else if (sortBy === "barcode") {
      return a.barcode.localeCompare(b.barcode);
    } else if (sortBy === "date") {
      return (b.lastestAt?.seconds || 0) - (a.lastestAt?.seconds || 0);
    }
    return 0; // 기본 정렬
  });
  currentPage = 1;
  renderProducts();
}

// 🧾 상품 목록 렌더링
function renderProducts() {
  productList.innerHTML = "";
  pagination.innerHTML = "";

  const start = (currentPage - 1) * itemsPerPage;
  const currentItems = filteredProducts.slice(start, start + itemsPerPage);

  currentItems.forEach((p) => {
    const card = document.createElement("div");
    card.className = "product-card";
    card.innerHTML = `
      <div class="name">${p.name}</div>
      <div class="price">${p.price.toLocaleString()} 포인트</div>
      <div class="barcode">바코드: ${p.barcode}</div>
      <div>
        <button class="edit" data-id="${
          p.id
        }"><i class="fas fa-pen"></i> 수정</button>
        <button class="delete-btn" data-id="${
          p.id
        }"><i class="fas fa-trash"></i> 삭제</button>
      </div>
    `;
    productList.appendChild(card);
  });

  const totalPages = Math.ceil(filteredProducts.length / itemsPerPage);
  for (let i = 1; i <= totalPages; i++) {
    const btn = document.createElement("button");
    btn.innerText = i;
    if (i === currentPage) btn.classList.add("active");
    btn.addEventListener("click", () => {
      currentPage = i;
      renderProducts();
    });
    pagination.appendChild(btn);
  }
}

// 🔍 검색 기능
document.getElementById("search-btn").addEventListener("click", () => {
  applyFiltersAndSort();
});

// ♻ 초기화 버튼 (검색 포함)
document.getElementById("reset-btn").addEventListener("click", async () => {
  document.getElementById("product-name").value = "";
  document.getElementById("product-barcode").value = "";
  document.getElementById("sort-select").value = "price";
  await loadProducts();
  showToast(`초기화 완료 <i class='fas fa-check'></i>`);
});

// ➕ 등록
document
  .getElementById("product-form")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("product-name").value.trim();
    const price = parseInt(document.getElementById("product-price").value);
    const barcode = document.getElementById("product-barcode").value.trim();
    const createdAt = serverTimestamp();
    const lastestAt = serverTimestamp();

    if (!name || !barcode || isNaN(price) || price <= 0) {
      showToast("상품명, 바코드는 필수이며 가격은 1 이상이어야 합니다.", true);
      return;
    }

    // 중복 바코드 검사
    const duplicate = allProducts.find((p) => p.barcode === barcode);
    if (duplicate) {
      showToast("⚠ 이미 등록된 바코드입니다.", true);
      return;
    }

    await addDoc(productsCol, { name, price, barcode, createdAt, lastestAt });
    e.target.reset();
    await loadProducts();
  });

// 🗑 삭제
productList.addEventListener("click", async (e) => {
  const id = e.target.dataset.id;
  if (e.target.classList.contains("delete-btn")) {
    if (confirm("정말 삭제하시겠습니까?")) {
      await deleteDoc(doc(db, "products", id));
      await loadProducts();
    }
  }
  if (e.target.classList.contains("edit")) {
    const product = allProducts.find((p) => p.id === id);
    if (!product) return;
    document.getElementById("edit-name").value = product.name;
    document.getElementById("edit-price").value = product.price;
    document.getElementById("edit-barcode").value = product.barcode;

    editingProductId = id; // 수정할 상품 ID 저장
    document.getElementById("edit-modal").classList.remove("hidden");
  }
});

// ✏️ 수정
document.getElementById("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("edit-name").value.trim();
  const price = parseInt(document.getElementById("edit-price").value);
  const barcode = document.getElementById("edit-barcode").value.trim();
  const updatedAt = serverTimestamp();
  const lastestAt = serverTimestamp();

  if (!name || !barcode || isNaN(price) || price <= 0) {
    showToast("수정값을 확인하세요.", true);
    return;
  }

  const ref = doc(db, "products", editingProductId);
  await updateDoc(ref, { name, price, barcode, updatedAt, lastestAt });

  document.getElementById("edit-modal").classList.add("hidden");
  editingProductId = null; // 수정 완료 후 초기화
  await loadProducts();
});

document.getElementById("cancel-btn").addEventListener("click", () => {
  document.getElementById("edit-modal").classList.add("hidden");
  editingProductId = null;
});

// ⏱ 로딩
document.addEventListener("DOMContentLoaded", loadProducts);

document.getElementById("sort-select").addEventListener("change", () => {
  applyFiltersAndSort();
});
