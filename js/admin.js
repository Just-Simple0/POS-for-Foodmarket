import { auth } from "./components/firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { showToast, openCaptchaModal } from "./components/comp.js";

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
};

let nextPageToken = null;
let latestQuery = "";
let latestFilters = { role: "", provider: "", sort: "lastSignInTime:desc" };
let currentUsers = []; // 현재 화면 데이터(엑셀/선택용)

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

  const frag = document.createDocumentFragment();
  users.forEach((u) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="row-chk" data-uid="${u.uid}"></td>
      <td>${u.email || "-"}</td>
      <td>${u.displayName || "-"}</td>
      <td>
        <select class="input role-select" data-uid="${u.uid}">${roleOptions(
      u.role
    )}</select>
      </td>
      <td>${fmtTime(u.lastSignInTime)}</td>
      <td>${(u.providers || []).join(", ") || "-"}</td>
      <td><span class="badge small muted" data-anom="${u.uid}">확인</span></td>
      <td><button class="btn btn-ghost btn-apply" data-uid="${
        u.uid
      }">적용</button></td>
    `;
    frag.appendChild(tr);
  });
  // 첫 결과면 tbody 교체, 아니면 append
  if (
    els.tbody.children.length &&
    !(
      els.tbody.children.length === 1 &&
      els.tbody.firstElementChild?.children?.length === 1
    )
  ) {
    els.tbody.appendChild(frag);
  } else {
    els.tbody.innerHTML = "";
    els.tbody.appendChild(frag);
  }
  updateSelectionUI();
}

async function fetchUsers(q = "", append = false) {
  const user = auth.currentUser;
  if (!user) return;
  const idToken = await user.getIdToken(true);
  const cf = await openCaptchaModal({
    action: "admin_user_list",
    title: "관리자 인증",
    subtitle: "관리자 페이지 접근을 확인합니다.",
  });
  if (!cf)
    return showToast("캡차 검증 실패. 새로고침 후 다시 시도하세요.", true);

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (nextPageToken && append) params.set("next", nextPageToken);
  params.set("limit", "50");
  if (latestFilters.role) params.set("role", latestFilters.role);
  if (latestFilters.provider) params.set("provider", latestFilters.provider);
  if (latestFilters.sort) params.set("sort", latestFilters.sort);

  const res = await fetch(`${API_BASE}/api/admin/users?` + params.toString(), {
    headers: {
      Authorization: "Bearer " + idToken,
      "x-cf-turnstile-token": cf,
    },
  });
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
  const idToken = await user.getIdToken(true);
  const cf = await openCaptchaModal({
    action: "admin_set_role",
    title: "보안 확인",
    subtitle: "역할 변경 전 본인 확인이 필요합니다.",
  });
  if (!cf) return showToast("캡차 검증 실패", true);

  const res = await fetch(`${API_BASE}/api/admin/setRole`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + idToken,
      "x-cf-turnstile-token": cf,
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
  const user = auth.currentUser;
  const idToken = await user.getIdToken(true);
  const cf = await openCaptchaModal({
    action: "admin_set_role_bulk",
    title: "보안 확인",
    subtitle: `선택 ${checked.length}명 역할을 '${role}'로 변경합니다.`,
  });
  if (!cf) return showToast("캡차 검증 실패", true);
  const res = await fetch(`${API_BASE}/api/admin/setRoleBulk`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + idToken,
      "x-cf-turnstile-token": cf,
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
  const user = auth.currentUser;
  const idToken = await user.getIdToken(true);
  const cf = await openCaptchaModal({
    action: disabled ? "admin_disable" : "admin_enable",
    title: "보안 확인",
    subtitle: `선택 ${uidList.length}명 계정을 ${
      disabled ? "비활성화" : "활성화"
    } 합니다.`,
  });
  if (!cf) return showToast("캡차 검증 실패", true);
  for (const uid of uidList) {
    const res = await fetch(`${API_BASE}/api/admin/disableUser`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + idToken,
        "x-cf-turnstile-token": cf,
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
  const user = auth.currentUser;
  const idToken = await user.getIdToken(true);
  const cf = await openCaptchaModal({
    action: "admin_force_reset",
    title: "보안 확인",
    subtitle: `선택 ${uidList.length}명 비밀번호 초기화 링크를 생성합니다.`,
  });
  if (!cf) return showToast("캡차 검증 실패", true);
  const links = [];
  for (const uid of uidList) {
    const res = await fetch(`${API_BASE}/api/admin/forcePasswordReset`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + idToken,
        "x-cf-turnstile-token": cf,
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
  const rows = currentUsers.map((u) => ({
    uid: u.uid,
    email: u.email || "",
    displayName: u.displayName || "",
    role: u.role || "",
    disabled: !!u.disabled,
    lastSignInTime: u.lastSignInTime || "",
    providers: (u.providers || []).join(","),
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "users");
  XLSX.writeFile(wb, `users_${Date.now()}.xlsx`);
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
  const user = auth.currentUser;
  if (!user) return;
  const idToken = await user.getIdToken(true);
  const cf = await openCaptchaModal({
    action: "admin_logs",
    title: "관리자 인증",
    subtitle: "감사 로그를 조회합니다(최근 60일).",
  });
  if (!cf) return showToast("캡차 검증 실패", true);
  const params = new URLSearchParams();
  if (els.logUid.value.trim()) params.set("uid", els.logUid.value.trim());
  if (els.logAction.value) params.set("action", els.logAction.value);
  params.set("limit", "50");
  const res = await fetch(`${API_BASE}/api/admin/logs?` + params.toString(), {
    headers: {
      Authorization: "Bearer " + idToken,
      "x-cf-turnstile-token": cf,
    },
  });
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
    const user = auth.currentUser;
    const idToken = await user.getIdToken(true);
    const cf = await openCaptchaModal({
      action: "admin_anomaly",
      title: "보안 확인",
      subtitle: "최근 로그인 이상 징후를 확인합니다.",
    });
    if (!cf) return;
    const res = await fetch(
      `${API_BASE}/api/admin/userLoginAnomalies?uid=${encodeURIComponent(
        uid
      )}&limit=10`,
      {
        headers: {
          Authorization: "Bearer " + idToken,
          "x-cf-turnstile-token": cf,
        },
      }
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

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  // 첫 진입시 자동 검색
  fetchUsers("", false).catch((e) => showToast(e.message || String(e), true));
});
