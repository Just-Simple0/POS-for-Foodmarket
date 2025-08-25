import { auth } from "./components/firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { showToast, openCaptchaModal } from "./components/comp.js";

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
    const ok = confirm(
      `관리자 인증이 ${mins}분 ${secs}초 후 만료됩니다. 지금 갱신할까요?`
    );
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
  c7Roles: document.getElementById("c7-roles"),
  c7Disable: document.getElementById("c7-disable"),
  c7Reset: document.getElementById("c7-reset"),
};

let nextPageToken = null;
let latestQuery = "";
let latestFilters = { role: "", provider: "", sort: "lastSignInTime:desc" };
let currentUsers = []; // 현재 화면 데이터(엑셀/선택용)

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
  tr.innerHTML = `
    <td><input type="checkbox" class="row-chk" data-uid="${u.uid}"></td>
    <td>${u.email || "-"}</td>
    <td>${u.displayName || "-"}</td>
    <td><select class="input role-select" data-uid="${u.uid}">${roleOptions(
    u.role
  )}</select></td>
    <td>${fmtTime(u.lastSignInTime)}</td>
    <td>${(u.providers || []).join(", ") || "-"}</td>
    <td><span class="badge small muted" data-anom="${u.uid}">확인</span></td>
    <td><button class="btn btn-ghost btn-apply" data-uid="${
      u.uid
    }">적용</button></td>`;
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
    if (els.c7Roles) els.c7Roles.textContent = String(week.rolesChanged || 0);
    if (els.c7Disable)
      els.c7Disable.textContent = String(week.usersDisabled || 0);
    if (els.c7Reset) els.c7Reset.textContent = String(week.passwordResets || 0);
  } catch {
    ["cRoles", "cDisable", "cReset", "c7Roles", "c7Disable", "c7Reset"].forEach(
      (id) => {
        if (els[id]) els[id].textContent = "0";
      }
    );
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
      <td>${l.status || "-"}</td>
    `;
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

els.tbody?.addEventListener("click", (e) => {
  // 역할 적용 버튼
  const btn = e.target.closest(".btn-apply");
  if (!btn) return;
  const uid = btn.getAttribute("data-uid");
  const select = btn.closest("tr").querySelector(".role-select");
  const role = select?.value;
  if (!uid || !role) return;
  // self-demote 방지(선택): 본인 UID이면 admin->user로 내리는 것을 한번 더 확인
  if (auth.currentUser?.uid === uid && role !== "admin") {
    if (
      !confirm(
        "본인의 권한을 낮추시겠습니까? 관리자 페이지 접근이 제한될 수 있습니다."
      )
    )
      return;
  }
  applyRole(uid, role).catch((e) => showToast(e.message || String(e), true));
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
  })();
});

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
