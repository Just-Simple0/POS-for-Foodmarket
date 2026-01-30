import { db, auth } from "../components/firebase-config.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  limit,
  updateDoc,
  runTransaction,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
  increment,
  deleteField,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import { logEvent } from "../components/comp.js";

// ===== Provision/Visit Key Helpers (same rule as provision.js) =====
function toDayNumber(d) {
  const base = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return (
    base.getFullYear() * 10000 + (base.getMonth() + 1) * 100 + base.getDate()
  );
}
function toDateKey(dayNum) {
  const y = Math.floor(dayNum / 10000);
  const m = Math.floor((dayNum % 10000) / 100);
  const d = dayNum % 100;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function toPeriodKey(date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const startY = m >= 3 ? y : y - 1;
  const endY = startY + 1;
  return `${String(startY).slice(2)}-${String(endY).slice(2)}`;
}

async function recomputeCustomerLastVisitFields(customerId) {
  const ref = doc(db, "customers", customerId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data();
  const latestIso = (() => {
    const v = data?.visits;
    if (!v || typeof v !== "object") return "";
    let latest = "";
    for (const k of Object.keys(v)) {
      const arr = Array.isArray(v[k]) ? v[k] : [];
      for (const s of arr) {
        if (!s) continue;
        const iso = String(s).replace(/\./g, "-");
        if (!latest || iso > latest) latest = iso;
      }
    }
    return latest;
  })();

  if (!latestIso) {
    await updateDoc(ref, {
      lastVisit: deleteField(),
      lastVisitKey: deleteField(),
      lastVisitAt: deleteField(),
      updatedAt: serverTimestamp(),
    });
    return;
  }

  const ymd = latestIso.replace(/-/g, ".");
  const key = latestIso.replace(/-/g, "");
  await updateDoc(ref, {
    lastVisit: ymd,
    lastVisitKey: key,
    lastVisitAt: Timestamp.fromDate(new Date(latestIso)),
    updatedAt: serverTimestamp(),
  });
}

async function reconcileLifeloveForQuarter(customerId, quarterKey) {
  if (!quarterKey) return;
  try {
    const qy = query(
      collection(db, "provisions"),
      where("customerId", "==", customerId),
      where("lifelove", "==", true),
      where("quarterKey", "==", quarterKey),
      limit(1),
    );
    const snap = await getDocs(qy);
    if (snap.empty) {
      await updateDoc(doc(db, "customers", customerId), {
        [`lifelove.${quarterKey}`]: deleteField(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (e) {
    console.warn("reconcileLifeloveForQuarter skipped:", e);
  }
}

// ===== Admin apply: Provision update (customer/handler) =====
export async function adminApplyProvisionEdit({
  provisionId,
  handler,
  oldCustomerId,
  newCustomerId,
  newCustomerName,
  newCustomerBirth,
}) {
  const provRef = doc(db, "provisions", provisionId);
  const provSnap = await getDoc(provRef);
  if (!provSnap.exists()) throw new Error("제공 문서를 찾을 수 없습니다.");

  const prov = provSnap.data();
  const ts = prov.timestamp;
  if (!ts || !ts.toDate) throw new Error("제공일시가 유효하지 않습니다.");

  const provDate = ts.toDate();
  const dayNum = toDayNumber(provDate);
  const dateKey = toDateKey(dayNum);
  const periodKey = toPeriodKey(provDate);

  const currentOldId = prov.customerId || oldCustomerId || "";
  const targetId = newCustomerId || currentOldId;
  const targetName = newCustomerName || prov.customerName || "";
  const targetBirth = newCustomerBirth || prov.customerBirth || "";

  const lifelove = !!prov.lifelove;
  const quarterKey = prov.quarterKey || "";

  // handler만 수정
  if (!newCustomerId) {
    const prevHandledBy = prov.handledBy || "";
    const nextHandledBy = handler || prevHandledBy;
    await updateDoc(provRef, {
      handledBy: nextHandledBy,
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || null,
    });

    await logEvent("provision_update", {
      mode: "handler_only",
      provisionId,
      day: dayNum,
      customerId: currentOldId,
      customerName: prov.customerName || "",
      customerBirth: prov.customerBirth || "",
      prevHandledBy,
      nextHandledBy,
    });

    return;
  }

  const sameCustomer = currentOldId === targetId;

  const oldCustRef = currentOldId ? doc(db, "customers", currentOldId) : null;
  const newCustRef = targetId ? doc(db, "customers", targetId) : null;

  const oldVisitRef = currentOldId
    ? doc(db, "visits", `${dateKey}_${currentOldId}`)
    : null;
  const newVisitRef = targetId
    ? doc(db, "visits", `${dateKey}_${targetId}`)
    : null;

  const statsRef = doc(db, "stats_daily", String(dayNum));

  await runTransaction(db, async (tx) => {
    const oldVisitSnap = oldVisitRef ? await tx.get(oldVisitRef) : null;
    const newVisitSnap = newVisitRef ? await tx.get(newVisitRef) : null;

    tx.update(provRef, {
      customerId: targetId,
      customerName: targetName,
      customerBirth: targetBirth,
      handledBy: handler || prov.handledBy || "",
      updatedAt: serverTimestamp(),
      updatedBy: auth.currentUser?.email || null,
    });

    if (!sameCustomer) {
      if (oldVisitRef && oldVisitSnap?.exists()) tx.delete(oldVisitRef);

      if (newVisitRef) {
        if (!newVisitSnap?.exists()) {
          tx.set(
            newVisitRef,
            {
              day: dayNum,
              dateKey,
              customerId: targetId,
              customerName: targetName,
              periodKey,
              createdAt: serverTimestamp(),
              createdBy: auth.currentUser?.uid || null,
            },
            { merge: true },
          );
        } else {
          tx.set(
            statsRef,
            { uniqueVisitors: increment(-1), updatedAt: serverTimestamp() },
            { merge: true },
          );
        }
      }
    }

    if (!sameCustomer && oldCustRef) {
      tx.update(oldCustRef, { [`visits.${periodKey}`]: arrayRemove(dateKey) });
    }
    if (newCustRef) {
      tx.update(newCustRef, { [`visits.${periodKey}`]: arrayUnion(dateKey) });
    }

    if (lifelove && quarterKey && newCustRef) {
      tx.update(newCustRef, { [`lifelove.${quarterKey}`]: true });
    }
  });

  // post-fix
  try {
    if (!sameCustomer && currentOldId) {
      await reconcileLifeloveForQuarter(currentOldId, quarterKey);
      await recomputeCustomerLastVisitFields(currentOldId);
    }
  } catch (e) {
    console.warn("post-fix(old) failed:", e);
  }
  try {
    if (targetId) await recomputeCustomerLastVisitFields(targetId);
  } catch (e) {
    console.warn("post-fix(new) failed:", e);
  }

  const prevHandledBy = prov.handledBy || "";
  const nextHandledBy = handler || prevHandledBy;

  await logEvent("provision_update", {
    mode: "customer_or_mixed",
    provisionId,
    day: dayNum,
    oldCustomerId: currentOldId,
    newCustomerId: targetId,
    oldCustomerName: prov.customerName || "",
    newCustomerName: targetName || "",
    oldCustomerBirth: prov.customerBirth || "",
    newCustomerBirth: targetBirth || "",
    prevHandledBy,
    nextHandledBy,
    lifelove,
    quarterKey: quarterKey || null,
  });
}

// ===== Admin apply: Provision delete =====
export async function adminDeleteProvision(provisionId) {
  const provRef = doc(db, "provisions", provisionId);
  const provSnap = await getDoc(provRef);
  if (!provSnap.exists()) throw new Error("제공 문서를 찾을 수 없습니다.");

  const prov = provSnap.data();
  const ts = prov.timestamp;
  if (!ts || !ts.toDate) throw new Error("제공일시가 유효하지 않습니다.");

  const provDate = ts.toDate();
  const dayNum = toDayNumber(provDate);
  const dateKey = toDateKey(dayNum);
  const periodKey = toPeriodKey(provDate);

  const customerId = prov.customerId || "";
  const lifelove = !!prov.lifelove;
  const quarterKey = prov.quarterKey || "";

  const visitRef = customerId
    ? doc(db, "visits", `${dateKey}_${customerId}`)
    : null;
  const customerRef = customerId ? doc(db, "customers", customerId) : null;
  const statsRef = doc(db, "stats_daily", String(dayNum));

  const items = Array.isArray(prov.items) ? prov.items : [];
  const deltasById = new Map();
  let qtyDeltaTotal = 0;
  for (const it of items) {
    const pid = it?.id;
    if (!pid) continue;
    const q = Number(it?.quantity || 0);
    if (!Number.isFinite(q) || q === 0) continue;
    qtyDeltaTotal += q;
    const prev = deltasById.get(pid) || {
      qty: 0,
      name: it?.name || "",
      category: it?.category || "",
    };
    prev.qty += q;
    if (!prev.name && it?.name) prev.name = it.name;
    if (!prev.category && it?.category) prev.category = it.category;
    deltasById.set(pid, prev);
  }

  await runTransaction(db, async (tx) => {
    const visitSnap = visitRef ? await tx.get(visitRef) : null;
    const statsSnap = await tx.get(statsRef);
    const stats = statsSnap.exists() ? statsSnap.data() || {} : {};

    tx.delete(provRef);

    if (visitRef && visitSnap?.exists()) {
      tx.delete(visitRef);
      tx.set(
        statsRef,
        { uniqueVisitors: increment(-1), updatedAt: serverTimestamp() },
        { merge: true },
      );
    }

    const curItemsTotalQty = Number(stats.itemsTotalQty || 0);
    const nextItemsTotalQty = Math.max(0, curItemsTotalQty - qtyDeltaTotal);

    const curMap =
      stats.itemStatsById && typeof stats.itemStatsById === "object"
        ? { ...stats.itemStatsById }
        : {};

    if (Object.keys(curMap).length > 0) {
      for (const [pid, d] of deltasById.entries()) {
        const cur =
          curMap[pid] && typeof curMap[pid] === "object" ? curMap[pid] : {};
        const curQty = Number(cur.qty || 0);
        const nextQty = curQty - Number(d.qty || 0);
        if (!Number.isFinite(nextQty) || nextQty <= 0) {
          delete curMap[pid];
        } else {
          curMap[pid] = {
            qty: nextQty,
            name: cur.name || d.name || "",
            category: cur.category || d.category || "",
          };
        }
      }
    }

    const topItems20 =
      Object.keys(curMap).length === 0
        ? Array.isArray(stats.topItems20)
          ? stats.topItems20
          : []
        : Object.entries(curMap)
            .map(([id, v]) => ({
              id,
              name: v?.name || "",
              category: v?.category || "",
              qty: Number(v?.qty || 0),
            }))
            .filter((x) => Number.isFinite(x.qty) && x.qty > 0)
            .sort((a, b) => b.qty - a.qty)
            .slice(0, 20);

    tx.set(
      statsRef,
      {
        itemsTotalQty: nextItemsTotalQty,
        itemStatsById: curMap,
        topItems20,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    if (customerRef) {
      tx.update(customerRef, { [`visits.${periodKey}`]: arrayRemove(dateKey) });
    }
  });

  if (customerId) {
    await recomputeCustomerLastVisitFields(customerId);
    if (lifelove && quarterKey)
      await reconcileLifeloveForQuarter(customerId, quarterKey);
  }

  await logEvent("provision_delete", {
    provisionId,
    day: dayNum,
    customerId,
    customerName: prov.customerName || "",
    customerBirth: prov.customerBirth || "",
    handledBy: prov.handledBy || "",
    lifelove,
    quarterKey: quarterKey || null,
    itemsCount: items.length,
    itemsQtyTotal: qtyDeltaTotal,
  });
}

// ===== Admin apply: lifelove delete (set lifelove=false) =====
async function reconcileCustomerLifelove(customerId, quarterKey) {
  if (!customerId || !quarterKey) return;
  const provisionsRef = collection(db, "provisions");
  const qy = query(
    provisionsRef,
    where("customerId", "==", customerId),
    where("lifelove", "==", true),
    where("quarterKey", "==", quarterKey),
    limit(1),
  );
  const snap = await getDocs(qy);
  const customerRef = doc(db, "customers", customerId);
  if (snap.empty) {
    await updateDoc(customerRef, {
      [`lifelove.${quarterKey}`]: deleteField(),
      updatedAt: serverTimestamp(),
    });
  } else {
    await updateDoc(customerRef, {
      [`lifelove.${quarterKey}`]: true,
      updatedAt: serverTimestamp(),
    });
  }
}

export async function adminUnsetLifeloveForProvision({
  provId,
  customerId,
  quarterKey,
}) {
  if (!provId) throw new Error("provId 누락");
  await runTransaction(db, async (tx) => {
    const provRef = doc(db, "provisions", provId);
    tx.update(provRef, { lifelove: false });
  });
  if (customerId && quarterKey) {
    await reconcileCustomerLifelove(customerId, quarterKey);
  }

  await logEvent("lifelove_delete", {
    provId,
    customerId: customerId || null,
    quarterKey: quarterKey || null,
  });
}

// ===== Approvals -> Apply helpers (admin.js 용) =====
export async function applyProvisionDeleteApproval(item) {
  const targetId = item?.targetId;
  if (!targetId) throw new Error("provision_delete: targetId 누락");
  await adminDeleteProvision(targetId);
}

export async function applyProvisionUpdateApproval(item) {
  const targetId = item?.targetId;
  if (!targetId) throw new Error("provision_update: targetId 누락");
  const p = item?.payload || {};
  await adminApplyProvisionEdit({
    provisionId: targetId,
    handler: p.handler || p.requestedHandler || "",
    oldCustomerId: p.oldCustomerId || p.customerId || "",
    newCustomerId: p.newCustomerId || "",
    newCustomerName: p.newCustomerName || "",
    newCustomerBirth: p.newCustomerBirth || "",
  });
}

export async function applyLifeloveDeleteApproval(item) {
  const targetId = item?.targetId;
  if (!targetId) throw new Error("lifelove_delete: targetId(provId) 누락");
  const p = item?.payload || {};
  await adminUnsetLifeloveForProvision({
    provId: targetId,
    customerId: p.customerId || p.customer_id || "",
    quarterKey: p.quarterKey || p.quarter_key || "",
  });
}
