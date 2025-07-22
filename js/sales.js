// js/sales.js
import { db } from "./firebase-config.js";
import {
  collection,
  addDoc,
  getDocs,
  query,
  where,
  doc,
  getDoc,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const salesCol = collection(db, "sales");
const customersCol = collection(db, "customers");
const productsCol = collection(db, "products");

// 바코드로 상품 조회
export async function getProductByBarcode(barcode) {
  const q = query(productsCol, where("barcode", "==", barcode));
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;
  return snapshot.docs[0].data();
}

// 고객 정보 조회
export async function getCustomer(id) {
  const docRef = doc(db, "customers", id);
  const docSnap = await getDoc(docRef);
  return docSnap.exists() ? docSnap.data() : null;
}

// 고객 포인트 업데이트 및 제한 확인
export async function updateCustomerPoints(id, pointsToAdd) {
  const customerRef = doc(db, "customers", id);
  const customer = await getCustomer(id);
  if (!customer) throw new Error("고객 정보 없음");

  const newPoints = (customer.pointsUsed || 0) + pointsToAdd;
  if (newPoints > 30) {
    return false; // 제한 초과
  }

  await updateDoc(customerRef, { pointsUsed: newPoints });
  return true;
}

// 판매 기록 등록
export async function registerSale(customerId, customerName, product) {
  await addDoc(salesCol, {
    customerId,
    customerName,
    productName: product.name,
    price: product.price,
    barcode: product.barcode,
    createdAt: new Date(),
  });
}
