import { auth } from "./components/firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { showToast, getTurnstileToken } from "./components/comp.js";

const API_BASE =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://localhost:3000"
    : "https://foodmarket-pos.onrender.com";

const els = {
  q: document.getElementById("q"),
  btnSearch: document.getElementById("btn-search"),
  btnMore: document.getElementById("btn-more"),
  tbody: document.getElementById("admin-user-tbody"),
};

let nextPageToken = null;
let latestQuery = "";

function fmtTime(s) {
  if (!s) return "-";
  try {
    return new Date(s).toLocaleString("ko-KR");
  } catch {
    return s;
  }
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
  if (!users?.length) {
    if (!els.tbody.children.length)
      els.tbody.innerHTML = `<tr><td colspan="6">결과가 없습니다.</td></tr>`;
    return;
  }
  const frag = document.createDocumentFragment();
  users.forEach((u) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${u.email || "-"}</td>
      <td>${u.displayName || "-"}</td>
      <td>
        <select class="input role-select" data-uid="${u.uid}">${roleOptions(
      u.role
    )}</select>
      </td>
      <td>${fmtTime(u.lastSignInTime)}</td>
      <td>${(u.providers || []).join(", ") || "-"}</td>
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
}

async function fetchUsers(q = "", append = false) {
  const user = auth.currentUser;
  if (!user) return;
  const idToken = await user.getIdToken(true);
  const cf = await getTurnstileToken("admin_users_list");
  if (!cf)
    return showToast("캡차 검증 실패. 새로고침 후 다시 시도하세요.", true);

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (nextPageToken && append) params.set("next", nextPageToken);
  params.set("limit", "50");

  const res = await fetch(`${API_BASE}/api/admin/users?` + params.toString(), {
    headers: {
      Authorization: "Bearer " + idToken,
      "x-cf-turnstile-token": cf,
    },
  });
  const data = await res.json();
  if (!res.ok || !data.ok) throw new Error(data?.message || "조회 실패");
  nextPageToken = data.nextPageToken || null;
  renderRows(data.users || []);
  els.btnMore.style.display = nextPageToken ? "inline-block" : "none";
}

async function applyRole(uid, role) {
  const user = auth.currentUser;
  if (!user) return;
  const idToken = await user.getIdToken(true);
  const cf = await getTurnstileToken("admin_set_role");
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

els.btnSearch?.addEventListener("click", () => {
  latestQuery = (els.q.value || "").trim();
  nextPageToken = null;
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

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  // 첫 진입시 자동 검색
  fetchUsers("", false).catch((e) => showToast(e.message || String(e), true));
});
