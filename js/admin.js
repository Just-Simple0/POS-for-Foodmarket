import { auth, db } from "./components/firebase-config.js";
import {
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  getDoc,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  Timestamp,
  addDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { showToast, openCaptchaModal, openConfirm } from "./components/comp.js";

let ADMIN_STS = sessionStorage.getItem("admin_sts") || "";
let __adminSessionPromise = null; // 동시 실행 가드
let __stsRenewTimer = null; // 갱신 타이머 핸들

// === STS(body) exp 파싱 & 갱신 스케줄 ===
function b64urlDecode(s) {
  try {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    const pad = s.length % 4;
    if (pad) s += "=".repeat(4 - pad);
    return atob(s);
  } catch {
    return "";
  }
}
function parseStsExp(token) {
  try {
    const body = String(token || "").split(".")[0];
    if (!body) return 0;
    const json = JSON.parse(b64urlDecode(body));
    return Number(json.exp) || 0;
  } catch {
    return 0;
  }
}
function isStsValid(tok, safetyMs = 60_000) {
  const exp = parseStsExp(tok);
  if (!exp) return false;
  return exp * 1000 - Date.now() > safetyMs; // 만료까지 safetyMs 이상 남았는가?
}

// === 공통 fetch 래퍼: STS 주입 + 만료/부족 시 강제 갱신 + 1회 자동 재시도 ===
async function adminFetch(path, init = {}, retry = true) {
  const user = auth.currentUser;
  if (!user) throw new Error("not-authenticated");
  // 호출 직전 STS 유효성 확인(30초 미만 남았으면 강제 갱신)
  if (!isStsValid(ADMIN_STS, 30_000)) {
    await ensureAdminSession(true);
  } else {
    await ensureAdminSession(false);
  }
  const idToken = await user.getIdToken(true);
  const headers = Object.assign({}, init.headers, {
    Authorization: "Bearer " + idToken,
    "x-admin-sts": ADMIN_STS,
  });
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let msg = "";
    try {
      const j = await res.json();
      msg = j?.message || "";
    } catch {}
    // STS 없음/만료 응답이면 1회 강제 갱신 후 재시도
    if (
      retry &&
      (res.status === 400 || res.status === 403) &&
      msg === "missing-turnstile-token"
    ) {
      try {
        await ensureAdminSession(true);
        return adminFetch(path, init, false);
      } catch {}
    }
    throw new Error(msg || "request-failed");
  }
  return res;
}

function scheduleStsRenewal() {
  if (__stsRenewTimer) {
    clearTimeout(__stsRenewTimer);
    __stsRenewTimer = null;
  }
  const exp = parseStsExp(ADMIN_STS);
  if (!exp) return;
  const msUntilPrompt = exp * 1000 - Date.now() - 60_000; // 만료 1분 전
  const wait = Math.max(0, Math.min(msUntilPrompt, 14 * 60_000)); // 안전 클램프
  __stsRenewTimer = setTimeout(async () => {
    const remain = Math.max(0, exp * 1000 - Date.now());
    const mins = Math.floor(remain / 60000),
      secs = Math.floor((remain % 60000) / 1000);
    const ok = await openConfirm({
      title: "관리자 인증 만료 예정",
      message: `관리자 인증이 ${mins}분 ${secs}초 후 만료됩니다. 지금 갱신할까요?`,
      variant: "info",
      confirmText: "지금 갱신",
      cancelText: "나중에",
    });
    if (!ok) return;
    try {
      await ensureAdminSession(true); // 강제 갱신
      showToast("관리자 인증이 갱신되었습니다.");
    } catch {
      showToast("갱신 실패. 만료 후 다시 인증해 주세요.", true);
    }
  }, wait);
}
if (ADMIN_STS) scheduleStsRenewal(); // 새로고침/재방문 시 바로 스케줄

const API_BASE =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://localhost:3000"
    : "https://foodmarket-pos.onrender.com";

const els = {
  q: document.getElementById("q"),
  fRole: document.getElementById("f-role"),
  fProvider: document.getElementById("f-provider"),
  fSort: document.getElementById("f-sort"),
  btnSearch: document.getElementById("btn-search"),
  btnMore: document.getElementById("btn-more"),
  tbody: document.getElementById("admin-user-tbody"),
  chkAll: document.getElementById("chk-all"),
  selCount: document.getElementById("sel-count"),
  btnRevoke: document.getElementById("btn-revoke"),
  bulkRole: document.getElementById("bulk-role"),
  btnBulkRole: document.getElementById("btn-bulk-role"),
  btnDisable: document.getElementById("btn-disable"),
  btnEnable: document.getElementById("btn-enable"),
  btnReset: document.getElementById("btn-reset"),
  btnExport: document.getElementById("btn-export-xlsx"),
  // logs
  logUid: document.getElementById("log-uid"),
  logAction: document.getElementById("log-action"),
  btnLogs: document.getElementById("btn-logs"),
  logsTbody: document.getElementById("logs-tbody"),
  cRoles: document.getElementById("c-roles"),
  cDisable: document.getElementById("c-disable"),
  cReset: document.getElementById("c-reset"),
  cDelete: document.getElementById("c-delete"),
  c7Roles: document.getElementById("c7-roles"),
  c7Disable: document.getElementById("c7-disable"),
  c7Reset: document.getElementById("c7-reset"),
  c7Delete: document.getElementById("c7-delete"),
  // tabs
  tabUsersBtn: document.querySelector('.tabbar .tab[data-tab="users"]'),
  tabAprBtn: document.querySelector('.tabbar .tab[data-tab="approvals"]'),
  tabUsersWrap: document.getElementById("tab-users"),
  aprCard: document.getElementById("approvals-card"),
  // approvals
  aprRefresh: document.getElementById("apr-refresh"),
  aprApprove: document.getElementById("apr-approve"),
  aprReject: document.getElementById("apr-reject"),
  aprAll: document.getElementById("apr-all"),
  aprTbody: document.getElementById("approvals-tbody"),
  // customer logs
  cLogsRefresh: document.getElementById("clogs-refresh"),
  cLogsTbody: document.getElementById("clogs-tbody"),
};

let nextPageToken = null;
let latestQuery = "";
let latestFilters = { role: "", provider: "", sort: "lastSignInTime:desc" };
let currentUsers = []; // 현재 화면 데이터(엑셀/선택용)
let approvals = []; // 승인 요청 목록
let cLogs = []; // 고객 로그 목록(30일)

// ===== 로그 유틸 =====
async function logEvent(type, data = {}) {
  try {
    await addDoc(collection(db, "'customerlogs"), {
      type,
      actor: auth.currentUser?.email || "unknown",
      createdAt: Timestamp.now(),
      ...data,
    });
  } catch (e) {
    console?.warn?.("logEvent failed:", e);
  }
}
async function pruneOldCustomerLogs() {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const q = query(
      collection(db, "customerlogs"),
      where("createdAt", "<", Timestamp.fromDate(cutoff)),
      orderBy("createdAt", "asc"),
      limit(300)
    );
    const snap = await getDocs(q);
    if (snap.empty) return;
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  } catch (e) {
    console?.warn?.("pruneOldLogs skipped:", e);
  }
}
// (9) 가상 스크롤(200행↑에서만 가동)
const VIRTUAL_THRESHOLD = 200;
let rowHeight = 44;
let firstIndex = 0,
  visibleCount = 60;

function fmtTime(s) {
  if (!s) return "-";
  try {
    return new Date(s).toLocaleString("ko-KR");
  } catch {
    return s;
  }
}

// Firestore Timestamp(JSON 직렬화 포함) → 로컬 문자열
function fmtServerTimestamp(ts) {
  if (!ts) return "";
  try {
    // Admin SDK Timestamp 객체 그대로 올 때
    if (typeof ts.toDate === "function") {
      return ts.toDate().toLocaleString("ko-KR");
    }
    // JSON 직렬화된 형태({_seconds,_nanoseconds} 또는 {seconds,nanoseconds})
    const sec = ts._seconds ?? ts.seconds;
    const ns = ts._nanoseconds ?? ts.nanoseconds ?? 0;
    if (typeof sec === "number")
      return new Date(sec * 1000 + Math.floor(ns / 1e6)).toLocaleString(
        "ko-KR"
      );
    if (typeof ts === "string") return new Date(ts).toLocaleString("ko-KR");
  } catch {}
  return "";
}

// 고객 문서 id 규칙(이름+생일)
function slugId(name, birth) {
  const n = String(name || "").replace(/\s+/g, "");
  const b = String(birth || "").replace(/\D/g, "");
  return `${n}_${b}`;
}

function roleOptions(selected) {
  const ro = ["admin", "manager", "user", "pending"];
  return ro
    .map(
      (r) =>
        `<option value="${r}" ${r === selected ? "selected" : ""}>${r}</option>`
    )
    .join("");
}

function renderRows(users) {
  if (!Array.isArray(users)) users = [];
  if (!users.length) {
    if (!els.tbody.children.length)
      els.tbody.innerHTML = `<tr><td colspan="8">결과가 없습니다.</td></tr>`;
    return;
  }
  if (!users?.length) return;

  if (currentUsers.length > VIRTUAL_THRESHOLD) {
    els.tbody.innerHTML = `
      <tr class="vspacer"><td colspan="8"><div class="pad" id="pad-top"></div></td></tr>
      <tr id="v-anchor"></tr>
      <tr class="vspacer"><td colspan="8"><div class="pad" id="pad-bot"></div></td></tr>`;
    mountVirtualWindow();
  } else {
    const frag = document.createDocumentFragment();
    users.forEach((u) => frag.appendChild(renderRow(u)));
    els.tbody.innerHTML = "";
    els.tbody.appendChild(frag);
    // 행 높이 실측
    const one = els.tbody.querySelector("tr:not(.vspacer)");
    if (one) rowHeight = Math.max(40, one.offsetHeight || rowHeight);
    updateSelectionUI();
  }
}

function renderRow(u) {
  const tr = document.createElement("tr");
  if (u.disabled) tr.classList.add("is-disabled");
  tr.innerHTML = `
    <td><input type="checkbox" class="row-chk" data-uid="${u.uid}"></td>
    <td>${u.email || "-"}</td>
    <td>${u.displayName || "-"}</td>
    <td><select class="input role-select" data-uid="${u.uid}" ${
    u.disabled ? "disabled" : ""
  }>${roleOptions(u.role)}</select></td>
    <td>${fmtTime(u.lastSignInTime)}</td>
    <td>${(u.providers || []).join(", ") || "-"}</td>
    <td><span class="badge small muted" data-anom="${u.uid}">확인</span></td>
    <td>
      <button class="btn btn-ghost btn-apply" data-uid="${u.uid}" ${
    u.disabled ? "disabled" : ""
  }>적용</button>
      <button class="btn btn-warn btn-delete" data-uid="${u.uid}">삭제</button>
    </td>`;
  return tr;
}

function mountVirtualWindow() {
  const wrap = document.querySelector(".table-wrap");
  const anchor = document.getElementById("v-anchor");
  const padTop = document.getElementById("pad-top");
  const padBot = document.getElementById("pad-bot");
  if (!wrap || !anchor || !padTop || !padBot) return;
  const renderSlice = () => {
    const scrollTop = wrap.scrollTop;
    const viewport = wrap.clientHeight || 600;
    firstIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 10);
    visibleCount = Math.min(80, Math.ceil(viewport / rowHeight) + 20);
    const lastIndex = Math.min(currentUsers.length, firstIndex + visibleCount);
    // 패딩
    padTop.style.height = `${firstIndex * rowHeight}px`;
    padBot.style.height = `${Math.max(
      0,
      (currentUsers.length - lastIndex) * rowHeight
    )}px`;
    // 윈도우 교체
    // anchor 다음에 있는 실제 행들 제거
    let n = anchor.nextElementSibling;
    while (n && !n.classList.contains("vspacer")) {
      const x = n;
      n = n.nextElementSibling;
      x.remove();
    }
    const frag = document.createDocumentFragment();
    for (let i = firstIndex; i < lastIndex; i++)
      frag.appendChild(renderRow(currentUsers[i]));
    anchor.after(frag);
    updateSelectionUI();
  };
  wrap.addEventListener("scroll", () => requestAnimationFrame(renderSlice));
  renderSlice();
}

async function fetchUsers(q = "", append = false) {
  const user = auth.currentUser;
  if (!user) return;

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (nextPageToken && append) params.set("next", nextPageToken);
  params.set("limit", "50");
  if (latestFilters.role) params.set("role", latestFilters.role);
  if (latestFilters.provider) params.set("provider", latestFilters.provider);
  if (latestFilters.sort) params.set("sort", latestFilters.sort);

  const res = await adminFetch(`/api/admin/users?` + params.toString());
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data?.message || "조회 실패");
  nextPageToken = data.nextPageToken || null;
  const users = data.users || [];
  if (append) currentUsers = currentUsers.concat(users);
  else currentUsers = users.slice();
  renderRows(users);
  els.btnMore.style.display = nextPageToken ? "inline-block" : "none";
}

async function applyRole(uid, role) {
  const user = auth.currentUser;
  if (!user) return;

  const res = await adminFetch(`/api/admin/setRole`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ uid, role }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data?.message || "적용 실패");
  showToast("역할이 적용되었습니다.");
}

async function applyRoleBulk(role) {
  if (!role) return showToast("역할을 선택하세요.", true);
  const checked = [...document.querySelectorAll(".row-chk:checked")].map((c) =>
    c.getAttribute("data-uid")
  );
  if (!checked.length) return showToast("선택된 사용자가 없습니다.", true);
  const res = await adminFetch(`/api/admin/setRoleBulk`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ items: checked.map((uid) => ({ uid, role })) }),
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data?.message || "일괄 적용 실패");
  showToast(
    `역할 일괄 적용 완료(성공 ${data.success} / 실패 ${data.fail.length})`
  );
}

async function disableEnable(uidList, disabled) {
  if (!uidList.length) return showToast("선택된 사용자가 없습니다.", true);

  for (const uid of uidList) {
    const res = await adminFetch(`/api/admin/disableUser`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uid, disabled }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) return showToast("일부 처리 실패", true);
  }
  // 화면 반영 (회색 처리/컨트롤 비활성)
  currentUsers = currentUsers.map((u) =>
    uidList.includes(u.uid) ? { ...u, disabled } : u
  );
  renderRows(currentUsers);
  showToast(disabled ? "비활성화 완료" : "활성화 완료");
}

async function forceReset(uidList) {
  if (!uidList.length) return showToast("선택된 사용자가 없습니다.", true);

  const links = [];
  for (const uid of uidList) {
    const res = await adminFetch(`/api/admin/forcePasswordReset`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uid, revokeAll: true }),
    });
    const data = await res.json();
    if (res.ok && data.ok && data.resetLink)
      links.push({ uid, link: data.resetLink });
  }
  if (links.length) {
    console.log("Reset links:", links);
    showToast(`초기화 링크 ${links.length}건 생성(콘솔참조)`);
  } else {
    showToast("초기화 링크 생성 실패", true);
  }
}

function exportXLSX() {
  if (!currentUsers.length) return showToast("내보낼 데이터가 없습니다.", true);
  const headers = [
    ["UID", "Email", "Name", "Role", "Disabled", "Last Sign-In", "Providers"],
  ];
  const rows = currentUsers.map((u) => [
    u.uid,
    u.email || "",
    u.displayName || "",
    u.role || "",
    u.disabled ? "Y" : "N",
    fmtTime(u.lastSignInTime),
    (u.providers || []).join(","),
  ]);
  const ws = XLSX.utils.aoa_to_sheet(headers.concat(rows));
  ws["!autofilter"] = { ref: "A1:G1" };
  ws["!cols"] = [8, 24, 16, 10, 10, 20, 18].map((w) => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "users");
  XLSX.writeFile(wb, `users_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// (4) per-user 전원 로그아웃
async function revokeSelected() {
  const targets = getSelectedUids();
  if (!targets.length) return showToast("선택된 사용자가 없습니다.", true);

  for (const uid of targets) {
    const res = await adminFetch(`/api/admin/revokeTokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uid }),
    });
    if (!res.ok) return showToast("일부 실패", true);
  }
  showToast("전원 로그아웃 완료");
}

// (6) 요약 위젯
async function loadCounters() {
  const user = auth.currentUser;
  try {
    const r = await adminFetch(`/api/admin/counters?range=both`);
    if (!r.ok) throw new Error("counters-failed");
    const { today = {}, week = {} } = await r.json();
    if (els.cRoles) els.cRoles.textContent = String(today.rolesChanged || 0);
    if (els.cDisable)
      els.cDisable.textContent = String(today.usersDisabled || 0);
    if (els.cReset) els.cReset.textContent = String(today.passwordResets || 0);
    if (els.cDelete) els.cDelete.textContent = String(today.userDeleted || 0);
    if (els.c7Roles) els.c7Roles.textContent = String(week.rolesChanged || 0);
    if (els.c7Disable)
      els.c7Disable.textContent = String(week.usersDisabled || 0);
    if (els.c7Reset) els.c7Reset.textContent = String(week.passwordResets || 0);
    if (els.c7Delete) els.c7Delete.textContent = String(week.userDeleted || 0);
  } catch {
    [
      "cRoles",
      "cDisable",
      "cReset",
      "cDelete",
      "c7Roles",
      "c7Disable",
      "c7Reset",
      "c7Delete",
    ].forEach((id) => {
      if (els[id]) els[id].textContent = "0";
    });
  }
}

function getSelectedUids() {
  return [...document.querySelectorAll(".row-chk:checked")].map((c) =>
    c.getAttribute("data-uid")
  );
}
function updateSelectionUI() {
  const boxes = [...document.querySelectorAll(".row-chk")];
  const count = boxes.filter((b) => b.checked).length;
  if (els.selCount) els.selCount.textContent = String(count);
  if (els.chkAll) {
    els.chkAll.checked = boxes.length > 0 && boxes.every((b) => b.checked);
    els.chkAll.indeterminate =
      boxes.some((b) => b.checked) && !els.chkAll.checked;
  }
  // 행 하이라이트 토글
  boxes.forEach((b) => {
    const tr = b.closest("tr");
    if (tr) tr.classList.toggle("selected", b.checked);
  });
}

// ✅ 체크박스 상태 변화에 반응해서 즉시 하이라이트/카운트 갱신
els.tbody?.addEventListener("change", (e) => {
  const box = e.target;
  if (box && box.classList?.contains("row-chk")) {
    updateSelectionUI();
  }
});

// (참고) click 핸들러에서도 row-chk를 잡고 있지만,
// 키보드 조작/라벨 클릭 등 change 이벤트 케이스까지 커버하기 위해 추가합니다.

async function fetchLogs() {
  // ✅ 쿼리스트링 구성
  const params = new URLSearchParams();
  const uid = (els.logUid?.value || "").trim();
  const action = (els.logAction?.value || "").trim();
  if (uid) params.set("uid", uid); // 특정 UID 필터 (선택)
  if (action) params.set("action", action); // 액션 필터 (선택)
  params.set("limit", "50"); // 기본 50건 (서버 최대 100)

  // 요청
  const res = await adminFetch(`/api/admin/logs?` + params.toString());
  const data = await res.json();
  if (!res.ok || !data.ok) return showToast("로그 조회 실패", true);

  const logs = data.logs || [];
  const frag = document.createDocumentFragment();

  if (!logs.length) {
    els.logsTbody.innerHTML = `<tr><td colspan="5">결과 없음</td></tr>`;
    return;
  }

  for (const l of logs) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtServerTimestamp(l.createdAt)}</td>
      <td>${l.actorEmail || l.actorUid || "-"}</td>
      <td>${l.action}</td>
      <td>${
        l.targetUid ||
        (Array.isArray(l.targets) ? l.targets.join(", ") : "") ||
        "-"
      }</td>
      <td>${l.status || "-"}</td>`;
    frag.appendChild(tr);
  }
  els.logsTbody.innerHTML = "";
  els.logsTbody.appendChild(frag);
}

els.btnSearch?.addEventListener("click", () => {
  latestQuery = (els.q.value || "").trim();
  nextPageToken = null;
  latestFilters = {
    role: els.fRole?.value || "",
    provider: (els.fProvider?.value || "").trim(),
    sort: els.fSort?.value || "lastSignInTime:desc",
  };
  fetchUsers(latestQuery, false).catch((e) =>
    showToast(e.message || String(e), true)
  );
});
els.btnMore?.addEventListener("click", () => {
  fetchUsers(latestQuery, true).catch((e) =>
    showToast(e.message || String(e), true)
  );
});

els.tbody?.addEventListener("click", async (e) => {
  // 역할 적용 버튼
  const btn = e.target.closest(".btn-apply");
  if (!btn) return;
  const uid = btn.getAttribute("data-uid");
  const select = btn.closest("tr").querySelector(".role-select");
  const role = select?.value;
  if (!uid || !role) return;
  // self-demote 방지(선택): 본인 UID이면 admin->user로 내리는 것을 한번 더 확인
  if (auth.currentUser?.uid === uid && role !== "admin") {
    const ok = await openConfirm({
      title: "권한 변경 확인",
      message:
        "본인의 권한을 낮추시겠습니까? 관리자 페이지 접근이 제한될 수 있습니다.",
      variant: "warn",
      confirmText: "적용",
      cancelText: "취소",
      defaultFocus: "cancel",
    });
    if (!ok) return;
  }
  applyRole(uid, role).catch((e) => showToast(e.message || String(e), true));
});

// 삭제 버튼
els.tbody?.addEventListener("click", async (e) => {
  const del = e.target.closest(".btn-delete");
  if (!del) return;
  const uid = del.getAttribute("data-uid");
  const ok = await openConfirm({
    title: "계정 삭제",
    message: "정말 이 계정을 삭제할까요? 되돌릴 수 없습니다.",
    variant: "warn",
    confirmText: "삭제",
    cancelText: "취소",
  });
  if (!ok) return;
  try {
    const res = await adminFetch(`/api/admin/deleteUser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.message || "삭제 실패");
    // UI 제거 & 상태 갱신
    currentUsers = currentUsers.filter((u) => u.uid !== uid);
    els.tbody
      .querySelector(`button[data-uid="${uid}"]`)
      ?.closest("tr")
      ?.remove();
    updateSelectionUI();
    showToast("삭제 완료");
  } catch (err) {
    showToast(err.message || "삭제 실패", true);
  }
});

// 이상 징후 뱃지 클릭 → on-demand 조회
els.tbody?.addEventListener("click", async (e) => {
  const badge = e.target.closest("[data-anom]");
  if (!badge) return;
  const uid = badge.getAttribute("data-anom");
  try {
    const res = await adminFetch(
      `/api/admin/checkAnomalies?uid=${encodeURIComponent(uid)}&limit=10`
    );
    const data = await res.json();
    if (res.ok && data.ok) {
      const text = `국가변화: ${
        data.countryChanged ? "있음" : "없음"
      } / 새 디바이스: ${data.newDevices || 0}`;
      badge.textContent = text;
      badge.classList.add(
        data.countryChanged || (data.newDevices || 0) > 0
          ? "badge-alert"
          : "badge-ok"
      );
    } else showToast("조회 실패", true);
  } catch (err) {
    showToast("조회 실패", true);
  }
});

// 헤더 전체선택
els.chkAll?.addEventListener("change", () => {
  const on = els.chkAll.checked;
  document.querySelectorAll(".row-chk").forEach((cb) => (cb.checked = on));
  updateSelectionUI(); // 선택 상태에 따라 tr.selected 갱신
});

// 액션바 버튼들
els.btnBulkRole?.addEventListener("click", () =>
  applyRoleBulk(els.bulkRole?.value)
);
els.btnDisable?.addEventListener("click", () =>
  disableEnable(getSelectedUids(), true)
);
els.btnEnable?.addEventListener("click", () =>
  disableEnable(getSelectedUids(), false)
);
els.btnReset?.addEventListener("click", () => forceReset(getSelectedUids()));
els.btnExport?.addEventListener("click", exportXLSX);
els.btnLogs?.addEventListener("click", () =>
  fetchLogs().catch((e) => showToast("로그 조회 실패", true))
);
els.btnRevoke?.addEventListener("click", () =>
  revokeSelected().catch(() => showToast("실패", true))
);

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  // 첫 진입: STS 예열(유효하면 유지, 부족하면 갱신)
  (async () => {
    try {
      if (!isStsValid(ADMIN_STS, 60_000)) await ensureAdminSession(true);
      else await ensureAdminSession(false);
    } catch {}
    fetchUsers("", false).catch((e) => showToast(e.message || String(e), true));
    loadCounters().catch(() => {});
    // 승인 탭 초기화
    bindTabs();
  })();
});

/* =======================
+   승인 요청 탭
+   ======================= */
function bindTabs() {
  if (!els.tabUsersBtn || !els.tabAprBtn) return;
  const act = (which) => {
    const u = which === "users";
    els.tabUsersBtn.classList.toggle("active", u);
    els.tabAprBtn.classList.toggle("active", !u);
    if (els.tabUsersWrap) els.tabUsersWrap.hidden = !u;
    if (els.aprCard) els.aprCard.hidden = u;
    if (!u) loadApprovals.catch(() => {});
  };
  els.tabUsersBtn.addEventListener("click", () => act("users"));
  els.tabAprBtn.addEventListener("click", () => act("approvals"));
  // 기본은 users 탭
  act("users");

  // 승인 테이블 버튼들
  els.aprRefresh?.addEventListener("click", () => loadApprovals());
  els.aprApprove?.addEventListener("click", () => bulkApprove());
  els.aprReject?.addEventListener("click", () => bulkReject());
  els.aprAll?.addEventListener("change", () => {
    const on = els.aprAll.checked;
    document
      .querySelectorAll("#approvals-tbody .apr-chk")
      .forEach((cb) => (cb.checked = on));
  });
  els.aprTbody?.addEventListener("click", (e) => {
    const btnA = e.target.closest("[data-approve]");
    const btnR = e.target.closest("[data-reject]");
    if (btnA)
      approveOne(btnA.getAttribute("data-approve")).catch((err) =>
        showToast(err.message || String(err), true)
      );
    if (btnR)
      rejectOne(btnR.getAttribute("data-reject")).catch((err) =>
        showToast(err.message || String(err), true)
      );
  });
  els.cLogsRefresh?.addEventListener("click", () => {
    pruneOldCustomerLogs();
    loadCustomerLogs();
  });
}

async function loadApprovals() {
  if (!els.aprTbody) return;
  const snap = await getDocs(
    query(
      collection(db, "approvals"),
      orderBy("requestedAt", "desc"),
      limit(100)
    )
  );
  approvals = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderApprovals();
}
function renderApprovals() {
  if (!approvals.length) {
    els.aprTbody.innerHTML = `<tr><td colspan="7">대기중인 요청이 없습니다.</td></tr>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const a of approvals) {
    const tr = document.createElement("tr");
    const target = a.targetId
      ? a.targetId
      : a.payload
      ? `${a.payload.name || ""}/${a.payload.birth || ""}`
      : "-";
    const summary = summarizeApproval(a);
    tr.innerHTML = `
      <td><input type="checkbox" class="apr-chk" data-id="${a.id}"></td>
      <td>${fmtServerTimestamp(a.requestedAt) || "-"}</td>
      <td>${a.requestedBy || "-"}</td>
      <td>${a.type || "-"}</td>
      <td>${target}</td>
      <td>${summary}</td>
      <td class="row-actions">
        <button class="btn btn-ghost" data-approve="${a.id}">승인</button>
        <button class="btn btn-ghost" data-reject="${a.id}">거부</button>
      </td>`;
    frag.appendChild(tr);
  }
  els.aprTbody.innerHTML = "";
  els.aprTbody.appendChild(frag);
}
function summarizeApproval(a) {
  try {
    if (a.type === "customer_add") {
      const p = a.payload || {};
      return `추가: ${p.name || ""} / ${p.birth || ""} / ${p.status || ""}`;
    }
    if (a.type === "customer_update") {
      const ch = Object.keys(a.changes || {})
        .slice(0, 5)
        .map((k) => `${k}→${a.changes[k]}`)
        .join(", ");
      return `수정: ${ch}${
        Object.keys(a.changes || {}).length > 5 ? " …" : ""
      }`;
    }
    if (a.type === "customer_delete") {
      return `삭제: ${a.targetId}`;
    }
  } catch {}
  return "-";
}
async function approveOne(id) {
  const item = approvals.find((x) => x.id === id);
  if (!item) return;
  // 고객 반영
  if (item.type === "customer_add") {
    const p = item.payload || {};
    const docId = item.targetId || slugId(p.name, p.birth);
    await setDoc(
      doc(collection(db, "customers"), docId),
      {
        ...p,
        updatedAt: Timestamp.now(),
        updatedBy: auth.currentUser?.email || "",
      },
      { merge: true }
    );
    await logEvent("approval_approve", {
      approvalType: "customer_add",
      targetId: docId,
      name: p.name,
      birth: p.birth,
    });
  } else if (item.type === "customer_update") {
    if (!item.targetId) throw new Error("targetId 누락");
    await updateDoc(doc(collection(db, "customers"), item.targetId), {
      ...(item.changes || {}),
      updatedAt: Timestamp.now(),
      updatedBy: auth.currentUser?.email || "",
    });
    await logEvent("approval_approve", {
      approvalType: "customer_update",
      targetId: item.targetId,
      changes: item.changes || {},
    });
  } else if (item.type === "customer_delete") {
    if (!item.targetId) throw new Error("targetId 누락");
    await deleteDoc(doc(collection(db, "customers"), item.targetId));
    await logEvent("approval_approve", {
      approvalType: "customer_delete",
      targetId: item.targetId,
    });
  } else {
    throw new Error("알 수 없는 유형");
  }
  // 요청 제거
  await deleteDoc(doc(collection(db, "approvals"), id));
  showToast("승인되었습니다.");
  await loadApprovals();
}
async function rejectOne(id) {
  const item = approvals.find((x) => x.id === id);
  await deleteDoc(doc(collection(db, "approvals"), id));
  showToast("거부 처리되었습니다.");
  if (item) {
    await logEvent("approval_reject", {
      approvalType: item.type,
      targetId: item.targetId || null,
      name: item?.payload?.name,
      birth: item?.payload?.birth,
    });
  }
  await loadApprovals();
}

/* =======================
   승인 탭: 고객 활동 로그 (30일)
   ======================= */
async function loadCustomerLogs() {
  if (!els.cLogsTbody) return;
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const qLogs = query(
    collection(db, "customerLogs"),
    where("createdAt", ">=", Timestamp.fromDate(cutoff)),
    orderBy("createdAt", "desc"),
    limit(300)
  );
  const snap = await getDocs(qLogs);
  cLogs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderCustomerLogs();
}
function renderCustomerLogs() {
  if (!cLogs.length) {
    els.cLogsTbody.innerHTML = `<tr><td colspan="5">최근 30일 활동 로그가 없습니다.</td></tr>`;
    return;
  }
  const rows = cLogs
    .map((l) => {
      const time = fmtServerTimestamp(l.createdAt) || "-";
      const actor = l.actor || "-";
      const type = mapLogType(l.type);
      const target =
        l.targetId || (l.name && l.birth ? `${l.name}/${l.birth}` : "-");
      const detail = summarizeCustomerLog(l);
      return `<tr>
      <td>${time}</td>
      <td>${actor}</td>
      <td>${type}</td>
      <td>${target}</td>
      <td>${detail}</td>
    </tr>`;
    })
    .join("");
  els.cLogsTbody.innerHTML = rows;
}
function mapLogType(t) {
  switch (t) {
    case "approval_request":
      return "승인요청";
    case "approval_approve":
      return "승인";
    case "approval_reject":
      return "거부";
    case "customer_add":
      return "등록";
    case "customer_update":
      return "수정";
    case "customer_delete":
      return "삭제";
    default:
      return t || "-";
  }
}
function summarizeCustomerLog(l) {
  try {
    if (l.type === "approval_request") {
      const s = l.approvalType || "";
      if (s === "customer_add")
        return `요청: 추가 · ${safe(l.name)} / ${safe(l.birth)}`;
      if (s === "customer_update")
        return `요청: 수정 · 변경=${sliceObj(l.changes)}`;
      if (s === "customer_delete") return `요청: 삭제`;
    }
    if (l.type === "approval_approve") {
      const s = l.approvalType || "";
      if (s === "customer_add") return `승인: 추가`;
      if (s === "customer_update") return `승인: 수정`;
      if (s === "customer_delete") return `승인: 삭제`;
    }
    if (l.type === "approval_reject") {
      return `거부: ${safe(l.approvalType)}`;
    }
    if (l.type === "customer_add") {
      return `직접 등록`;
    }
    if (l.type === "customer_update") {
      return `직접 수정 · ${sliceObj(l.changes)}`;
    }
    if (l.type === "customer_delete") {
      return `직접 삭제`;
    }
  } catch (e) {}
  return "-";
}
function safe(v) {
  return (v == null ? "" : String(v)).replace(/[<>&"]/g, " ");
}
function sliceObj(o) {
  const keys = Object.keys(o || {});
  const head = keys
    .slice(0, 4)
    .map((k) => `${k}→${o[k]}`)
    .join(", ");
  return head + (keys.length > 4 ? " …" : "");
}

function getCheckedApprovalIds() {
  return [
    ...document.querySelectorAll("#approvals-tbody .apr-chk:checked"),
  ].map((cb) => cb.getAttribute("data-id"));
}
async function bulkApprove() {
  const ids = getCheckedApprovalIds();
  if (!ids.length) return showToast("선택된 요청이 없습니다.", true);
  for (const id of ids) await approveOne(id);
}
async function bulkReject() {
  const ids = getCheckedApprovalIds();
  if (!ids.length) return showToast("선택된 요청이 없습니다.", true);
  for (const id of ids) await rejectOne(id);
}

// ===== STS 유틸: 관리자 세션(15분) + 갱신(강제) =====
async function ensureAdminSession(force = false) {
  if (ADMIN_STS && !force) return;
  if (__adminSessionPromise) return __adminSessionPromise; // 동시 호출 코얼레싱
  __adminSessionPromise = (async () => {
    const user = auth.currentUser;
    if (!user) throw new Error("no-user");
    const idToken = await user.getIdToken(true);
    const cf = await openCaptchaModal({
      action: "admin_session",
      title: "관리자 인증",
      subtitle: "보안을 위해 인증을 완료하세요.",
    });
    if (!cf) throw new Error("captcha-failed");
    const res = await fetch(`${API_BASE}/api/admin/session`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + idToken,
        "x-cf-turnstile-token": cf,
      },
    });
    const data = await res.json();
    if (!res.ok || !data.ok || !data.sts) throw new Error("sts-issue-failed");
    ADMIN_STS = data.sts;
    sessionStorage.setItem("admin_sts", ADMIN_STS);
    scheduleStsRenewal(); // 새 STS에 맞춰 타이머 재설정
  })().finally(() => {
    __adminSessionPromise = null;
  });
  return __adminSessionPromise;
}
