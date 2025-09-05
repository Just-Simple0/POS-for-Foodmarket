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
import { showToast, openConfirm } from "./components/comp.js";
import { getQuarterKey, updateCustomerLifeLove } from "./utils/lifelove.js";

const lookupInput = document.getElementById("customer-search");
const lookupBtn = document.getElementById("lookup-btn");
const customerInfoDiv = document.getElementById("customer-info");
const productSection = document.getElementById("product-selection");
const submitSection = document.getElementById("submit-section");
const submitBtn = document.getElementById("submit-btn");
const undoBtn = document.getElementById("undo-btn");
const redoBtn = document.getElementById("redo-btn");
const resetProductsBtn = document.getElementById("clear-products-btn");
const resetAllBtn = document.getElementById("clear-all-btn");
const lifeloveCheckbox = document.getElementById("lifelove-checkbox");
const currentUser = auth.currentUser;

let selectedCustomer = null;
let selectedItems = [];
let selectedCandidate = null;
let visitorList = []; // ✅ 방문자 리스트
const visitorListEl = document.getElementById("visitor-list");
const visitorListSection = document.getElementById("visitor-list-section");

let allProducts = [];

// 🔁 동명이인 모달 키보드 내비 전역 핸들러 참조
let dupKeyHandler = null;
let dupActiveIndex = -1;

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
  if (!keyword) return showToast("이름을 입력하세요.", true);

  try {
    const snapshot = await getDocs(collection(db, "customers"));
    const matches = snapshot.docs.filter((doc) => {
      const data = doc.data();
      const isMatched = data.name?.includes(keyword);
      const isExcluded = data.status?.trim() !== "지원";
      return isMatched && !isExcluded;
    });

    if (matches.length === 0) {
      return showToast("해당 이용자를 찾을 수 없습니다.", true);
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
  if (!selectedCustomer) {
    customerInfoDiv.innerHTML = "";
    customerInfoDiv.classList.add("hidden");
    return;
  }
  customerInfoDiv.innerHTML = `
      <strong>이용자명:</strong> ${selectedCustomer.name ?? ""}<br>
      <strong>생년월일:</strong> ${selectedCustomer.birth ?? ""}<br>
      <strong>주소:</strong> ${selectedCustomer.address ?? ""}<br>
      <strong>전화번호:</strong> ${selectedCustomer.phone ?? ""}<br>
      <strong>비고:</strong> ${selectedCustomer.note ?? ""}
    `;
  customerInfoDiv.classList.remove("hidden");
}

// 동명이인 처리하기
const duplicateModal = document.getElementById("duplicate-modal");
const duplicateList = document.getElementById("duplicate-list");
const closeDuplicateModal = document.getElementById("close-duplicate-modal");

closeDuplicateModal.addEventListener("click", () => {
  // ✅ 닫기: 모달/검색창/상태 초기화
  duplicateModal.classList.add("hidden");
  duplicateList.innerHTML = "";
  const infoEl = document.getElementById("selected-info");
  infoEl.classList.add("hidden");
  infoEl.innerHTML = "";
  selectedCandidate = null;
  dupActiveIndex = -1;
  lookupInput.value = "";
  lookupInput.focus();
  if (dupKeyHandler) {
    document.removeEventListener("keydown", dupKeyHandler, true);
    dupKeyHandler = null;
  }
});

function showDuplicateSelection(matches) {
  duplicateList.innerHTML = "";
  selectedCandidate = null;
  const confirmBtn = document.getElementById("confirm-duplicate");
  confirmBtn.disabled = true;

  const items = [];
  matches.forEach((docSnap, i) => {
    const data = docSnap.data();
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="dup-name"><strong>${data.name}</strong></div>
      <div class="dup-sub">
        ${data.birth || "생년월일 없음"} | ${data.phone || "전화번호 없음"}
      </div>
    `;

    li.classList.add("duplicate-item");
    li.tabIndex = -1; // 키보드 포커싱 가능
    // 공통 선택 로직
    const selectThis = () => {
      document
        .querySelectorAll(".duplicate-item")
        .forEach((el) => el.classList.remove("selected"));
      li.classList.add("selected");
      document
        .querySelectorAll(".duplicate-item i")
        .forEach((icon) => icon.remove());
      const icon = document.createElement("i");
      icon.className = "fas fa-square-check";
      icon.style.color = "#1976d2";
      icon.style.marginRight = "8px";
      li.prepend(icon);
      selectedCandidate = { id: docSnap.id, ...data };
      const infoEl = document.getElementById("selected-info");
      infoEl.innerHTML = `
        <div><strong>주소 :</strong> ${data.address || "없음"}</div>
        <div><strong>성별 :</strong> ${data.gender || "없음"}</div>
        <div><strong>비고 :</strong> ${data.note || ""}<div>
      `;
      infoEl.classList.remove("hidden");
      confirmBtn.disabled = false;
      dupActiveIndex = i;
      li.focus();
    };

    li.addEventListener("click", () => {
      selectThis();
    });
    duplicateList.appendChild(li);
    items.push(li);
  });
  // ✅ 단일 결과면 자동 "선택"만(자동 삽입 X)
  if (items.length === 1) {
    items[0].click();
  } else {
    dupActiveIndex = -1;
  }

  duplicateModal.classList.remove("hidden");

  // ✅ 방향키/Enter/Escape 지원
  if (dupKeyHandler) {
    document.removeEventListener("keydown", dupKeyHandler, true);
  }
  dupKeyHandler = (e) => {
    if (duplicateModal.classList.contains("hidden")) return;
    const max = items.length - 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      dupActiveIndex = dupActiveIndex < max ? dupActiveIndex + 1 : 0;
      items[dupActiveIndex].click();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      dupActiveIndex = dupActiveIndex > 0 ? dupActiveIndex - 1 : max;
      items[dupActiveIndex].click();
    } else if (e.key === "Enter") {
      if (!confirmBtn.disabled) {
        e.preventDefault();
        confirmBtn.click();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeDuplicateModal.click();
    }
  };
  document.addEventListener("keydown", dupKeyHandler, true);
}

document.getElementById("confirm-duplicate").addEventListener("click", () => {
  if (!selectedCandidate) return showToast("이용자를 선택하세요.", true);
  // ✅ 방문자 리스트에 삽입 (중복 방지)
  if (!visitorList.some((v) => v.id === selectedCandidate.id)) {
    visitorList.push(selectedCandidate);
    renderVisitorList();
    showToast("방문자 리스트에 추가되었습니다.");
  } else {
    showToast("이미 리스트에 있는 이용자입니다.", true);
  }
  // ✅ 삽입 후 모달/검색창 초기화
  duplicateModal.classList.add("hidden");
  duplicateList.innerHTML = "";
  const infoEl = document.getElementById("selected-info");
  infoEl.classList.add("hidden");
  infoEl.innerHTML = "";
  selectedCandidate = null;
  dupActiveIndex = -1;
  lookupInput.value = "";
  lookupInput.focus();
  if (dupKeyHandler) {
    document.removeEventListener("keydown", dupKeyHandler, true);
    dupKeyHandler = null;
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

resetAllBtn.addEventListener("click", async () => {
  const ok = await openConfirm({
    title: "전체 초기화",
    message: "전체 초기화하시겠습니까?",
    variant: "warn",
    confirmText: "초기화",
    cancelText: "취소",
  });
  if (!ok) return;
  resetForm(); // 고객/상품 전체 초기화
  undoStack = [];
  redoStack = [];
  showToast("전체 초기화 완료");
});

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "z" && !e.shiftKey) {
    e.preventDefault();
    undoBtn.click();
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "z") {
    e.preventDefault();
    redoBtn.click();
  } else if (
    e.ctrlKey &&
    e.key === "Enter" &&
    !submitSection.classList.contains("hidden")
  ) {
    e.preventDefault();
    submitBtn.click();
  }
});

const barcodeInput = document.getElementById("barcode-input");
const quantityInput = document.getElementById("quantity-input");
const addProductBtn = document.getElementById("add-product-btn");
const selectedTableBody = document.querySelector("#selected-table tbody");
const totalPointsEl = document.getElementById("total-points");
const warningEl = document.getElementById("point-warning");

/* =========================
   방문자 리스트 렌더/선택
   ========================= */
function renderVisitorList() {
  visitorListEl.innerHTML = "";
  if (visitorList.length === 0) {
    visitorListSection.classList.add("hidden");
    // 방문자 없으면 계산/제출 섹션 숨김
    selectedCustomer = null;
    productSection.classList.add("hidden");
    submitSection.classList.add("hidden");
    renderCustomerInfo();
    return;
  }
  visitorListSection.classList.remove("hidden");
  visitorList.forEach((v) => {
    const hasHold = !localStorage.getItem(HOLD_PREFIX + v.id);
    const li = document.createElement("li");
    li.className =
      "visitor-item" +
      (selectedCustomer?.id === v.id ? " active" : "") +
      (hasHold ? "has-hold" : "");
    const holdBadge = hasHold
      ? `<i class="fas fa-bookmark hold-badge" style="font-size: 11px;" title="보류 있음" aria-label="보류 있음"></i>`
      : "";
    li.innerHTML = `
      <div class="meta">
       <div class="name">${v.name} ${holdBadge}</div>
        <div class="sub">${v.birth || ""} ${
      v.phone ? " | " + v.phone : ""
    }</div>
      </div>
      <div class="actions">
        <button class="select" data-id="${v.id}">선택</button>
        <button class="remove" data-id="${v.id}">삭제</button>
      </div>
    `;
    visitorListEl.appendChild(li);
  });
}

visitorListEl?.addEventListener("click", async (e) => {
  const id = e.target.dataset.id;
  if (!id) return;
  const idx = visitorList.findIndex((v) => v.id === id);
  if (idx === -1) return;

  if (e.target.classList.contains("remove")) {
    // 선택 중인 고객을 제거하려 하면 경고
    if (selectedCustomer?.id === id && selectedItems.length > 0) {
      const ok = await openConfirm({
        title: "선택 해제",
        message: "현재 장바구니가 있습니다. 이 방문자를 리스트에서 제거할까요?",
        variant: "warn",
        confirmText: "제거",
        cancelText: "취소",
      });
      if (!ok) return;
    }
    if (selectedCustomer?.id === id) {
      selectedCustomer = null;
      selectedItems = [];
      renderSelectedList();
    }
    visitorList.splice(idx, 1);
    renderVisitorList();
    return;
  }

  if (e.target.classList.contains("select")) {
    // 고객 전환 시, 기존 장바구니 보류 안내
    if (
      selectedCustomer &&
      selectedItems.length > 0 &&
      selectedCustomer.id !== id
    ) {
      const ok = await openConfirm({
        title: "방문자 전환",
        message:
          "현재 장바구니가 있습니다. 전환하시겠습니까? (보류 저장을 권장)",
        variant: "warn",
        confirmText: "전환",
        cancelText: "취소",
      });
      if (!ok) return;
    }
    selectedCustomer = visitorList[idx];
    // 선택 후에만 계산/제출 섹션 노출
    productSection.classList.remove("hidden");
    submitSection.classList.remove("hidden");
    renderCustomerInfo();
    // 방문자 전환 시 기본은 빈 장바구니
    selectedItems = [];
    undoStack = [];
    redoStack = [];
    lifeloveCheckbox.checked = false; // lifelove도 초기화
    // 🔍 선택한 방문자에 보류 데이터가 있으면, 불러올지 물어본 뒤 자동 적용
    try {
      const holdRaw = localStorage.getItem(HOLD_PREFIX + selectedCustomer.id);
      if (holdRaw) {
        const okLoad = await openConfirm({
          title: "보류 불러오기",
          message: "이 방문자에 저장된 보류 장바구니가 있습니다. 불러올까요?",
          variant: "warn",
          confirmText: "불러오기",
          cancelText: "새로 시작",
        });
        if (okLoad) {
          try {
            const parsed = JSON.parse(holdRaw);
            if (Array.isArray(parsed)) {
              selectedItems = parsed;
              showToast("보류 장바구니를 불러왔습니다.");
            }
          } catch {}
        }
      }
    } catch {}
    renderSelectedList();
    renderVisitorList(); // active 표시 갱신
  }
});

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
  } else if (e.key === "Escape") {
    autocompleteList.classList.add("hidden");
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

/* =========================
   보류: localStorage 저장/불러오기
   ========================= */
const HOLD_PREFIX = "provision:hold:";
const holdSaveBtn = document.getElementById("hold-save-btn");
const holdLoadBtn = document.getElementById("hold-load-btn");

holdSaveBtn?.addEventListener("click", () => {
  if (!selectedCustomer) return showToast("먼저 방문자를 선택하세요.", true);
  localStorage.setItem(
    HOLD_PREFIX + selectedCustomer.id,
    JSON.stringify(selectedItems)
  );
  // ✅ 보류 시: 장바구니/입력 초기화 + 계산/제출 UI 숨김 + 고객정보도 숨김 + 방문자 선택 해제
  selectedItems = [];
  undoStack = [];
  redoStack = [];
  renderSelectedList();
  barcodeInput.value = "";
  quantityInput.value = "";
  productSection.classList.add("hidden");
  submitSection.classList.add("hidden");
  // 고객 정보 패널 숨김 및 선택 해제
  selectedCustomer = null;
  customerInfoDiv.innerHTML = "";
  renderCustomerInfo(); // selectedCustomer가 null이면 hidden 처리됨
  renderVisitorList(); // active 표시 해제
  showToast("보류 처리되었습니다.");
});

holdLoadBtn?.addEventListener("click", () => {
  if (!selectedCustomer) return showToast("먼저 방문자를 선택하세요.", true);
  const raw = localStorage.getItem(HOLD_PREFIX + selectedCustomer.id);
  if (!raw) return showToast("저장된 보류 데이터가 없습니다.", true);
  try {
    selectedItems = JSON.parse(raw) || [];
    undoStack = [];
    redoStack = [];
    renderSelectedList();
    showToast("보류된 데이터를 불러왔습니다.");
  } catch {
    showToast("보류 데이터가 손상되었습니다.", true);
  }
});

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
  const quarterKey = getQuarterKey(now);
  const lifelove = lifeloveCheckbox.checked;

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
      lifelove,
      quarterKey,
    };
    await addDoc(ref, provisionData);

    // ✅ 2. 고객 문서에 방문일자 누적
    const customerRef = doc(db, "customers", selectedCustomer.id);
    const customerSnap = await getDoc(customerRef);
    const prevVisits = customerSnap.data()?.visits || {};
    const prevLifeLove = customerSnap.data()?.lifelove || {};

    if (!prevVisits[periodKey]) {
      prevVisits[periodKey] = [];
    }

    // 중복 방지
    if (!prevVisits[periodKey].includes(visitDate)) {
      prevVisits[periodKey].push(visitDate);
    }

    const updatedLifeLove = updateCustomerLifeLove(
      prevLifeLove,
      quarterKey,
      lifelove
    );

    await updateDoc(customerRef, {
      visits: prevVisits,
      lifelove: updatedLifeLove,
    });

    showToast("제공 등록 완료!");
    localStorage.removeItem(HOLD_PREFIX + selectedCustomer.id);
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
  visitorList = []; // ✅ 방문자 리스트도 초기화
  renderVisitorList();
  renderSelectedList();
  lifeloveCheckbox.checked = false;
}
