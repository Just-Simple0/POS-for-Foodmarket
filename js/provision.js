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
let selectedProducts = new Set();

// 🔍 이용자 조회
lookupBtn.addEventListener("click", async () => {
  const keyword = lookupInput.value.trim();
  if (!keyword) return showToast("이용자 ID 또는 이름을 입력하세요.", true);

  try {
    const snapshot = await getDocs(collection(db, "customers"));
    const matches = snapshot.docs.filter((doc) => {
      const data = doc.data();
      return doc.id === keyword || data.name?.includes(keyword);
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

    await loadProducts();
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

  matches.forEach((docSnap) => {
    const data = docSnap.data();
    const li = document.createElement("li");
    li.textContent = `${data.name} | ${data.birth || "생년월일 없음"} | ${
      data.phone || "전화번호 없음"
    }`;
    li.addEventListener("click", () => {
      selectedCustomer = { id: docSnap.id, ...data };
      renderCustomerInfo();
      duplicateModal.classList.add("hidden");
      productSection.classList.remove("hidden");
      submitSection.classList.remove("hidden");
    });
    duplicateList.appendChild(li);
  });

  duplicateModal.classList.remove("hidden");
}

// 📦 상품 불러오기
async function loadProducts() {
  const listEl = document.getElementById("product-list");
  listEl.innerHTML = "";

  try {
    const snapshot = await getDocs(collection(db, "products"));
    snapshot.forEach((doc) => {
      const data = doc.data();
      const card = document.createElement("div");
      card.className = "product-item";
      card.textContent = `${data.name}`;
      card.dataset.id = doc.id;

      card.addEventListener("click", () => {
        if (selectedProducts.has(doc.id)) {
          selectedProducts.delete(doc.id);
          card.classList.remove("selected");
        } else {
          selectedProducts.add(doc.id);
          card.classList.add("selected");
        }
      });

      listEl.appendChild(card);
    });
  } catch (err) {
    console.error(err);
    showToast("상품 불러오기 실패", true);
  }
}

// ✅ 제공 등록 제출
submitBtn.addEventListener("click", async () => {
  if (!selectedCustomer || selectedProducts.size === 0)
    return showToast("이용자와 상품을 모두 선택하세요.", true);

  try {
    const ref = collection(db, "provisions");
    const data = {
      customerId: selectedCustomer.id,
      customerName: selectedCustomer.name,
      products: Array.from(selectedProducts),
      timestamp: Timestamp.now(),
    };

    await addDoc(ref, data);
    showToast("제공 등록이 완료되었습니다.");
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
  selectedProducts.clear();
}
