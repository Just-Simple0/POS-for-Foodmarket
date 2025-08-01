import { db } from "./components/firebase-config.js";
import {
  collection,
  getDoc,
  getDocs,
  doc,
  addDoc,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { showToast } from "./components/comp.js";

const lookupInput = document.getElementById("customer-id");
const lookupBtn = document.getElementById("lookup-btn");
const customerInfoDiv = document.getElementById("customer-info");
const productSection = document.getElementById("product-selection");
const submitSection = document.getElementById("submit-section");
const submitBtn = document.getElementById("submit-btn");

let selectedCustomer = null;
let selectedItems = [];
let selectedCandidate = null;

let allProducts = [];

window.addEventListener("DOMContentLoaded", () => {
  lookupInput.focus();
});

lookupInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault(); // 폼 submit 방지
    lookupBtn.click();
  }
});

// 🔍 이용자 조회
lookupBtn.addEventListener("click", async () => {
  const keyword = lookupInput.value.trim();
  if (!keyword) return showToast("이용자 ID 또는 이름을 입력하세요.", true);

  try {
    const snapshot = await getDocs(collection(db, "customers"));
    const matches = snapshot.docs.filter((doc) => {
      const data = doc.data();
      const isMatched = doc.id === keyword || data.name?.includes(keyword);
      const isExcluded = data.status?.trim() !== "지원";
      return isMatched && !isExcluded;
    });

    if (matches.length === 0) {
      return showToast("해당 이용자를 찾을 수 없습니다.", true);
    } else if (matches.length === 1) {
      selectedCustomer = { id: matches[0].id, ...matches[0].data() };
      renderCustomerInfo();
      productSection.classList.remove("hidden");
      submitSection.classList.remove("hidden");
    } else {
      showDuplicateSelection(matches);
    }

    productSection.classList.remove("hidden");
    submitSection.classList.remove("hidden");
  } catch (err) {
    console.error(err);
    showToast("이용자 조회 중 오류 발생", true);
  }
});

// 고객 정보 렌더링
function renderCustomerInfo() {
  customerInfoDiv.innerHTML = `
      <strong>이용자명:</strong> ${selectedCustomer.name}<br>
      <strong>생년월일:</strong> ${selectedCustomer.birth}<br>
      <strong>상태:</strong> ${selectedCustomer.status}<br>
      <strong>주소:</strong> ${selectedCustomer.address}<br>
      <strong>전화번호:</strong> ${selectedCustomer.phone}
    `;
  customerInfoDiv.classList.remove("hidden");
}

// 동명이인 처리하기
const duplicateModal = document.getElementById("duplicate-modal");
const duplicateList = document.getElementById("duplicate-list");
const closeDuplicateModal = document.getElementById("close-duplicate-modal");

closeDuplicateModal.addEventListener("click", () => {
  duplicateModal.classList.add("hidden");
});

function showDuplicateSelection(matches) {
  duplicateList.innerHTML = "";
  selectedCandidate = null;
  const confirmBtn = document.getElementById("confirm-duplicate");
  confirmBtn.disabled = true;

  matches.forEach((docSnap) => {
    const data = docSnap.data();
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="dup-name"><strong>${data.name}</strong></div>
      <div class="dup-sub">
        ${data.birth || "생년월일 없음"} | ${data.phone || "전화번호 없음"}
      </div>
    `;

    li.classList.add("duplicate-item");
    li.addEventListener("click", () => {
      // 선택 상태 토글
      document
        .querySelectorAll(".duplicate-item")
        .forEach((el) => el.classList.remove("selected"));
      li.classList.add("selected");
      // 기존 아이콘 제거
      document
        .querySelectorAll(".duplicate-item i")
        .forEach((icon) => icon.remove());

      // 아이콘 추가
      const icon = document.createElement("i");
      icon.className = "fas fa-square-check";
      icon.style.color = "#1976d2";
      icon.style.marginRight = "8px";

      li.prepend(icon);

      selectedCandidate = { id: docSnap.id, ...data };

      // 상세 정보 출력
      const infoEl = document.getElementById("selected-info");
      infoEl.innerHTML = `
        <div><strong>주소 :</strong> ${data.address || "없음"}</div>
        <div><strong>성별 :</strong> ${data.gender || "없음"}</div>
      `;
      infoEl.classList.remove("hidden");
      confirmBtn.disabled = false;
    });
    duplicateList.appendChild(li);
  });
  duplicateModal.classList.remove("hidden");
}

document.getElementById("confirm-duplicate").addEventListener("click", () => {
  if (!selectedCandidate) return showToast("이용자를 선택하세요.", true);

  selectedCustomer = selectedCandidate;
  renderCustomerInfo();
  duplicateModal.classList.add("hidden");
  productSection.classList.remove("hidden");
  submitSection.classList.remove("hidden");
});

async function loadAllProductsOnce() {
  if (allProducts.length > 0) return;

  const snapshot = await getDocs(collection(db, "products"));
  allProducts = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));
}
loadAllProductsOnce();

const barcodeInput = document.getElementById("barcode-input");
const quantityInput = document.getElementById("quantity-input");
const addProductBtn = document.getElementById("add-product-btn");
const selectedTableBody = document.querySelector("#selected-table tbody");
const totalPointsEl = document.getElementById("total-points");
const warningEl = document.getElementById("point-warning");

barcodeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const keyword = barcodeInput.value.trim();

    const isBarcode = /^\d{5,}$/.test(keyword);

    if (isBarcode) {
      addProductBtn.click();
    } else {
      quantityInput.focus();
    }
  }
});

quantityInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addProductBtn.click();
  }
});

addProductBtn.addEventListener("click", async () => {
  const input = barcodeInput.value.trim();
  const quantity = parseInt(quantityInput.value) || 1;
  if (!input) return showToast("바코드 또는 상품명을 입력하세요.", true);

  try {
    const match = allProducts.find((p) => {
      return p.id === input || p.name?.includes(input) || p.barcode === input;
    });

    if (!match) return showToast("해당 상품을 찾을 수 없습니다.", true);

    const existing = selectedItems.find((item) => item.id === match.id);
    if (existing) {
      existing.quantity += quantity;
      showToast(`${match.name}의 수량이 ${quantity}개 증가했습니다.`);
    } else {
      selectedItems.push({
        id: match.id,
        name: match.name,
        price: match.price || 0,
        quantity: quantity,
      });
    }

    renderSelectedList();
    barcodeInput.value = "";
    quantityInput.value = "";
    autocompleteList.classList.add("hidden");
  } catch (err) {
    console.error(err);
    showToast("상품 검색 중 오류", true);
  }
});

const autocompleteList = document.getElementById("autocomplete-list");

barcodeInput.addEventListener("input", () => {
  const keyword = barcodeInput.value.trim().toLowerCase();
  if (!keyword || allProducts.length === 0) {
    autocompleteList.classList.add("hidden");
    return;
  }

  const matched = allProducts.filter((p) =>
    p.name.toLowerCase().includes(keyword)
  );

  renderAutocomplete(matched.slice(0, 5));
});

function renderAutocomplete(matches) {
  autocompleteList.innerHTML = "";
  if (matches.length === 0) {
    autocompleteList.classList.add("hidden");
    return;
  }

  matches.forEach((product) => {
    const div = document.createElement("div");
    div.textContent = `${product.name}`;
    div.addEventListener("click", () => {
      barcodeInput.value = product.barcode || product.id;
      quantityInput.focus();
      autocompleteList.classList.add("hidden");
    });
    autocompleteList.appendChild(div);
  });

  autocompleteList.classList.remove("hidden");
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".product-input-area")) {
    autocompleteList.classList.add("hidden");
  }
});

function renderSelectedList() {
  selectedTableBody.innerHTML = "";

  selectedItems.forEach((item, idx) => {
    const tr = document.createElement("tr");
    const totalPrice = item.quantity * item.price;

    tr.innerHTML = `
      <td>${item.name}</td>
      <td>
        <input type="number" min="1" max="30" value="${item.quantity}" data-idx="${idx}" class="quantity-input" />
      </td>
      <td>${item.price}</td>
      <td>${totalPrice}</td>
      <td>
        <button class="remove-btn" data-idx="${idx}"><i class="fas fa-trash"></i></button>
      </td>
    `;

    selectedTableBody.appendChild(tr);
  });

  calculateTotal();
}

selectedTableBody.addEventListener("input", (e) => {
  if (e.target.classList.contains("quantity-input")) {
    const idx = e.target.dataset.idx;
    const val = parseInt(e.target.value);
    if (val >= 1) {
      selectedItems[idx].quantity = val;
      renderSelectedList();
    }
  }
});

selectedTableBody.addEventListener("click", (e) => {
  if (e.target.closest(".remove-btn")) {
    const idx = e.target.closest(".remove-btn").dataset.idx;
    selectedItems.splice(idx, 1);
    renderSelectedList();
  }
});

function calculateTotal() {
  const total = selectedItems.reduce(
    (acc, item) => acc + item.quantity * item.price,
    0
  );

  totalPointsEl.textContent = total;

  if (total > 30) {
    warningEl.classList.remove("hidden");
  } else {
    warningEl.classList.add("hidden");
  }
}

// ✅ 제공 등록 제출
submitBtn.addEventListener("click", async () => {
  if (!selectedCustomer || selectedItems.length === 0)
    return showToast("이용자와 상품을 모두 선택하세요.", true);

  const total = selectedItems.reduce(
    (acc, item) => acc + item.quantity * item.price,
    0
  );
  if (total > 30) return showToast("포인트가 초과되었습니다.", true);

  try {
    const ref = collection(db, "provisions");
    const data = {
      customerId: selectedCustomer.id,
      customerName: selectedCustomer.name,
      items: selectedItems,
      total,
      timestamp: Timestamp.now(),
    };

    await addDoc(ref, data);
    showToast("제공 등록 완료!");
    resetForm();
  } catch (err) {
    console.error(err);
    showToast("제공 등록 실패", true);
  }
});

function resetForm() {
  lookupInput.value = "";
  customerInfoDiv.classList.add("hidden");
  productSection.classList.add("hidden");
  submitSection.classList.add("hidden");
  customerInfoDiv.innerHTML = "";
  selectedCustomer = null;
  selectedItems = [];
  renderSelectedList();
}
