import { db, auth } from "../components/firebase-config.js";
import {
  addDoc,
  collection,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/**
 * 공통 승인요청 생성 헬퍼
 * - customers/statistics 등 여러 페이지에서 동일한 approvals 문서 형태로 저장
 */
export async function createApprovalRequest({
  type,
  targetId = null,
  payload = {},
  changes = null,
  extra = null,
}) {
  if (!type) throw new Error("approval type 누락");

  const docBody = {
    type,
    requestedBy: auth.currentUser?.email || "",
    requestedAt: Timestamp.now(),
    approved: false,
    payload,
  };
  if (targetId) docBody.targetId = targetId;
  if (changes && typeof changes === "object") docBody.changes = changes;
  if (extra && typeof extra === "object") Object.assign(docBody, extra);

  return addDoc(collection(db, "approvals"), docBody);
}