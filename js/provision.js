import { db, auth } from "./components/firebase-config.js";
import {
  collection,
  getDoc,
  getDocs,
  doc,
  addDoc,
  Timestamp,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { showToast } from "./components/comp.js";

const lookupInput = document.getElementById("customer-id");
const lookupBtn = document.getElementById("lookup-btn");
const customerInfoDiv = document.getElementById("customer-info");
const productSection = document.getElementById("product-selection");
const submitSection = document.getElementById("submit-section");
const submitBtn = document.getElementById("submit-btn");
const undoBtn = document.getElementById("undo-btn");
const redoBtn = document.getElementById("redo-btn");
const resetProductsBtn = document.getElementById("clear-products-btn");
const resetAllBtn = document.getElementById("clear-all-btn");
const currentUser = auth.currentUser;

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

      const now = new Date();
      const currentMonth = now.toISOString().slice(0, 7);
      const year =
        now.getMonth() + 1 < 3 ? now.getFullYear() - 1 : now.getFullYear();
      const periodKey = `${String(year).slice(2)}-${String(year + 1).slice(2)}`;
      const alreadyVisited = selectedCustomer.visits?.[periodKey]?.some((v) =>
        v.startsWith(currentMonth)
      );

      renderCustomerInfo();

      if (alreadyVisited) {
        showToast("이미 방문한 대상자입니다", true);
        productSection.classList.add("hidden");
        submitSection.classList.add("hidden");
      } else {
        productSection.classList.remove("hidden");
        submitSection.classList.remove("hidden");
      }
    } else {
      showDuplicateSelection(matches);
    }
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

  const now = new Date();
  const currentMonth = now.toISOString().slice(0, 7);
  const year =
    now.getMonth() + 1 < 3 ? now.getFullYear() - 1 : now.getFullYear();
  const periodKey = `${String(year).slice(2)}-${String(year + 1).slice(2)}`;
  const alreadyVisited = selectedCustomer.visits?.[periodKey]?.some((v) =>
    v.startsWith(currentMonth)
  );

  renderCustomerInfo();
  duplicateModal.classList.add("hidden");

  if (alreadyVisited) {
    showToast("이미 방문한 대상자입니다", true);
    productSection.classList.add("hidden");
    submitSection.classList.add("hidden");
  } else {
    productSection.classList.remove("hidden");
    submitSection.classList.remove("hidden");
  }
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

let undoStack = [];
let redoStack = [];

undoBtn.addEventListener("click", () => {
  if (undoStack.length > 0) {
    redoStack.push([...selectedItems.map((item) => ({ ...item }))]);
    selectedItems = undoStack.pop();
    renderSelectedList();
  } else {
    showToast("되돌릴 작업이 없습니다.", true);
  }
});

redoBtn.addEventListener("click", () => {
  if (redoStack.length > 0) {
    undoStack.push([...selectedItems.map((item) => ({ ...item }))]);
    selectedItems = redoStack.pop();
    renderSelectedList();
  } else {
    showToast("다시 실행할 작업이 없습니다.", true);
  }
});

resetProductsBtn.addEventListener("click", () => {
  if (selectedItems.length === 0)
    return showToast("초기화할 물품이 없습니다.", true);

  undoStack.push([...selectedItems.map((item) => ({ ...item }))]);
  redoStack = [];
  selectedItems = [];
  renderSelectedList();
  showToast("물품 목록이 초기화되었습니다.");
});

resetAllBtn.addEventListener("click", () => {
  if (confirm("전체 초기화하시겠습니까?")) {
    resetForm(); // 고객/상품 전체 초기화
    undoStack = [];
    redoStack = [];
    showToast("전체 초기화 완료");
  }
});

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "z" && !e.shiftKey) {
    e.preventDefault();
    undoBtn.click();
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    redoBtn.click();
  }
});

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
    undoStack.push([...selectedItems.map((item) => ({ ...item }))]);
    redoStack = [];

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

quantityInput.addEventListener("input", () => {
  let val = parseInt(quantityInput.value, 10);
  if (val > 30) {
    quantityInput.value = 30;
    showToast("수량은 최대 30까지만 입력할 수 있습니다.");
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
        <div class="quantity-wrapper">
        <button class="decrease-btn" data-idx="${idx}">−</button>
        <input type="number" name="quantity-${idx}" min="1" max="30" value="${item.quantity}" data-idx="${idx}" class="quantity-input" />
        <button class="increase-btn" data-idx="${idx}">+</button>
        </div>
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

document.querySelector("#selected-table tbody").addEventListener(
  "blur",
  (e) => {
    if (e.target.classList.contains("quantity-input")) {
      let val = parseInt(e.target.value, 10);

      if (isNaN(val) || val < 1) {
        e.target.value = 1;
        showToast("수량은 1 이상이어야 합니다.");
      } else if (val > 30) {
        e.target.value = 30;
        showToast("수량은 최대 30까지만 가능합니다.");
      }
    }
  },
  true
); // ← true로 설정해야 '이벤트 캡처링'이 동작해서 위임 가능

selectedTableBody.addEventListener("click", (e) => {
  const idx = e.target.dataset.idx;

  // 수량 증가
  if (e.target.classList.contains("increase-btn")) {
    selectedItems[idx].quantity = Math.min(selectedItems[idx].quantity + 1, 30);
    renderSelectedList();
  }

  // 수량 감소
  if (e.target.classList.contains("decrease-btn")) {
    selectedItems[idx].quantity = Math.max(selectedItems[idx].quantity - 1, 1);
    renderSelectedList();
  }

  // 삭제
  if (e.target.closest(".remove-btn")) {
    const removeIdx = Number(e.target.closest(".remove-btn").dataset.idx);
    selectedItems.splice(removeIdx, 1);
    renderSelectedList();
  }
});

selectedTableBody.addEventListener("change", (e) => {
  if (e.target.classList.contains("quantity-input")) {
    undoStack.push([...selectedItems.map((item) => ({ ...item }))]);
    redoStack = [];

    const idx = e.target.dataset.idx;
    const val = parseInt(e.target.value);
    if (val >= 1 && val <= 30) {
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

  // ✅ 현재 로그인한 사용자 확인
  const currentUser = auth.currentUser;
  if (!currentUser) {
    showToast("로그인된 사용자를 확인할 수 없습니다.", true);
    return;
  }

  const now = new Date();
  const year =
    now.getMonth() + 1 < 3 ? now.getFullYear() - 1 : now.getFullYear();
  const periodKey = `${String(year).slice(2)}-${String(year + 1).slice(2)}`; // 예: 24-25
  const visitDate = now.toISOString().slice(0, 10); // YYYY-MM-DD

  try {
    // ✅ 1. 제공 기록 등록
    const ref = collection(db, "provisions");
    const provisionData = {
      customerId: selectedCustomer.id,
      customerName: selectedCustomer.name,
      customerBirth: selectedCustomer.birth,
      items: selectedItems,
      total,
      timestamp: Timestamp.now(),
      handledBy: currentUser.email,
    };
    await addDoc(ref, provisionData);

    // ✅ 2. 고객 문서에 방문일자 누적
    const customerRef = doc(db, "customers", selectedCustomer.id);
    const customerSnap = await getDoc(customerRef);
    const prevVisits = customerSnap.data()?.visits || {};

    if (!prevVisits[periodKey]) {
      prevVisits[periodKey] = [];
    }

    // 중복 방지
    if (!prevVisits[periodKey].includes(visitDate)) {
      prevVisits[periodKey].push(visitDate);
    }

    await updateDoc(customerRef, {
      visits: prevVisits,
    });

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
