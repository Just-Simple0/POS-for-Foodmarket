// js/barcode.js

// 바코드로 상품 조회
import { db } from "./firebase-config.js";
import {
  collection,
  query,
  where,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const productsCollection = collection(db, "products");

export async function getProductByBarcode(barcode) {
  const q = query(productsCollection, where("barcode", "==", barcode));
  const querySnapshot = await getDocs(q);
  if (!querySnapshot.empty) {
    // 첫번째 상품 반환
    return querySnapshot.docs[0].data();
  } else {
    return null;
  }
}
