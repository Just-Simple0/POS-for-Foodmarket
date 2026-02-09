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
  startAfter,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  showToast,
  openCaptchaModal,
  openConfirm,
  renderEmptyState,
  setBusy,
  showLoading,
  hideLoading,
  makeSectionSkeleton,
  logEvent,
  pruneOldCustomerLogs,
} from "./components/comp.js";

import {
  applyProvisionDeleteApproval,
  applyProvisionUpdateApproval,
  applyLifeloveDeleteApproval,
} from "./utils/adminProvisionOps.js";

let ADMIN_STS = sessionStorage.getItem("admin_sts") || "";
let __adminSessionPromise = null;
let __stsRenewTimer = null;

// === STS 로직 (기존 유지) ===
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
  return exp * 1000 - Date.now() > safetyMs;
}

// === Fetch Wrapper (기존 유지) ===
async function adminFetch(path, init = {}, retry = true) {
  const user = auth.currentUser;
  if (!user) throw new Error("not-authenticated");
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

// [수정] 관리자 세션 갱신 타이머 (반응형 카운트다운 적용)
function scheduleStsRenewal() {
  if (__stsRenewTimer) {
    clearTimeout(__stsRenewTimer);
    __stsRenewTimer = null;
  }
  const exp = parseStsExp(ADMIN_STS);
  if (!exp) return;

  // 만료 1분 전에 알림
  const msUntilPrompt = exp * 1000 - Date.now() - 60_000;
  // 최대 14분 대기 (토큰 수명이 15분이므로)
  const wait = Math.max(0, Math.min(msUntilPrompt, 14 * 60_000));

  __stsRenewTimer = setTimeout(async () => {
    // 1. 만료 목표 시간 (밀리초)
    const targetTime = exp * 1000;
    let timerId = null;

    // 2. 시간을 업데이트할 함수 정의
    const updateCountdown = () => {
      const el = document.getElementById("sts-countdown");
      if (!el) return; // 모달이 닫혔거나 요소를 못 찾으면 무시

      const diff = Math.max(0, targetTime - Date.now());
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);

      // 빨간색 텍스트로 시간 표시
      el.textContent = `${m}분 ${s}초`;

      // 시간이 다 되면 타이머 중지
      if (diff <= 0) clearInterval(timerId);
    };

    // 3. 모달 생성 (HTML 내부에 span id="sts-countdown" 삽입)
    // 주의: 여기서 await를 바로 하지 않고 Promise 객체를 받습니다.
    const confirmPromise = openConfirm({
      title: "관리자 인증 만료 예정",
      message: `관리자 인증이 <span id="sts-countdown" class="font-bold text-rose-600">계산 중...</span> 후 만료됩니다.<br>보안을 위해 세션을 갱신해 주세요.`,
      variant: "info",
      confirmText: "지금 갱신",
      cancelText: "나중에",
    });

    // 4. 타이머 시작 (모달이 뜬 직후부터 동작)
    updateCountdown(); // 즉시 1회 실행
    timerId = setInterval(updateCountdown, 1000);

    // 5. 유저 응답 대기 (여기서 멈춤)
    const ok = await confirmPromise;

    // 6. 응답 후 타이머 정리
    clearInterval(timerId);

    if (!ok) return;

    // 7. 갱신 로직 실행
    try {
      await ensureAdminSession(true);
      showToast("관리자 인증이 갱신되었습니다.");

      // [추가] 갱신 성공 시 화면 데이터 리프레시 (새로고침 없이 데이터만 로드)
      loadCounters().catch(() => {}); // 상단 카운터 갱신

      // 현재 활성화된 탭 확인 후 해당 데이터 갱신
      if (els.tabUsersBtn.classList.contains("is-active")) {
        // 사용자 탭이면: 현재 검색어 유지한 채 목록 갱신
        fetchUsers(latestQuery, false).catch(() => {});
      } else if (els.tabAprBtn.classList.contains("is-active")) {
        // 승인 탭이면: 승인 목록 갱신
        loadApprovals().catch(() => {});
      }
      // 데이터 관리 탭은 별도 조회 데이터가 없으므로 패스

      // [추가] 탭 배지(빨간 점)도 갱신
      updateTabBadges();
    } catch {
      console.error(e); // 에러 확인용
      showToast("갱신 실패. 만료 후 다시 인증해 주세요.", true);
    }
  }, wait);
}
if (ADMIN_STS) scheduleStsRenewal();

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
  bulkActions: document.getElementById("bulk-actions"),
  btnDisable: document.getElementById("btn-disable"),
  btnEnable: document.getElementById("btn-enable"),
  btnReset: document.getElementById("btn-reset"),
  btnExport: document.getElementById("btn-export-xlsx"),

  // logs
  logUid: document.getElementById("log-uid"),
  logAction: document.getElementById("log-action"),
  logScope: document.getElementById("log-scope"),
  btnLogs: document.getElementById("btn-logs"),
  logsTbody: document.getElementById("logs-tbody"),

  // counters
  cRoles: document.getElementById("c-roles"),
  cDisable: document.getElementById("c-disable"),
  cReset: document.getElementById("c-reset"),
  cDelete: document.getElementById("c-delete"),
  c7Roles: document.getElementById("c7-roles"),
  c7Disable: document.getElementById("c7-disable"),
  c7Reset: document.getElementById("c7-reset"),
  c7Delete: document.getElementById("c7-delete"),

  // tabs
  tabUsersBtn: document.querySelector('.tab-item[data-tab="users"]'),
  tabAprBtn: document.querySelector('.tab-item[data-tab="approvals"]'),
  tabMaintBtn: document.querySelector('.tab-item[data-tab="maintenance"]'),

  tabUsersWrap: document.getElementById("tab-users"),
  aprCard: document.getElementById("approvals-card"),
  tabMaintWrap: document.getElementById("tab-maintenance"),

  // approvals
  aprRefresh: document.getElementById("apr-refresh"),
  aprApprove: document.getElementById("apr-approve"),
  aprReject: document.getElementById("apr-reject"),
  aprAll: document.getElementById("apr-all"),
  aprTbody: document.getElementById("approvals-tbody"),

  // customer logs
  cLogsRefresh: document.getElementById("clogs-refresh"),
  cLogsTbody: document.getElementById("c-logs-tbody"),
};

let nextPageToken = null;
let latestQuery = "";
let latestFilters = { role: "", provider: "", sort: "lastSignInTime:desc" };
let currentUsers = [];
let approvals = [];
let cLogs = [];

// [Utility] XLSX functions (기존 로직 유지)

function ymd(d) {
  const y = d.getFullYear(),
    m = String(d.getMonth() + 1).padStart(2, "0"),
    dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
// === ExcelJS 스타일 헬퍼 함수 ===
function applyExcelHeaderStyle(row) {
  row.eachCell((cell) => {
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF4B5563" }, // Slate-600 색상
    };
    cell.font = {
      color: { argb: "FFFFFFFF" },
      bold: true,
      name: "Pretendard",
    };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = {
      top: { style: "thin" },
      left: { style: "thin" },
      bottom: { style: "thin" },
      right: { style: "thin" },
    };
  });
  row.height = 25;
}

function applyExcelBodyStyle(row) {
  row.eachCell((cell) => {
    cell.border = {
      top: { style: "thin" },
      left: { style: "thin" },
      bottom: { style: "thin" },
      right: { style: "thin" },
    };
    cell.alignment = {
      vertical: "middle",
      horizontal: "center",
      wrapText: false,
    };
  });
}

// === [업데이트] 제공 내역 엑셀 내보내기 (ExcelJS 버전) ===
async function exportProvisionsXlsx(db, fromDate, toDate) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("제공내역");

  // 1. 헤더 설정
  worksheet.columns = [
    { header: "No.", key: "no", width: 6 },
    { header: "제공일시", key: "date", width: 22 },
    { header: "이용자명", key: "customerName", width: 15 },
    { header: "생년월일", key: "customerBirth", width: 15 }, // 추가 정보 (있을 경우)
    { header: "품목 및 상세", key: "items", width: 45 },
    { header: "총액", key: "total", width: 12 },
    { header: "생명사랑", key: "lifelove", width: 10 },
    { header: "처리자", key: "handledBy", width: 20 },
  ];

  applyExcelHeaderStyle(worksheet.getRow(1));

  let last = null,
    count = 0;
  while (true) {
    let qy = query(
      collection(db, "provisions"),
      where("timestamp", ">=", Timestamp.fromDate(fromDate)),
      where("timestamp", "<", Timestamp.fromDate(toDate)),
      orderBy("timestamp", "asc"),
      limit(500),
    );
    if (last) qy = query(qy, startAfter(last));
    const snap = await getDocs(qy);
    if (snap.empty) break;

    snap.forEach((d) => {
      const v = d.data();
      const ts = v.timestamp?.toDate?.() || null;
      count++;

      const row = worksheet.addRow({
        no: count,
        date: ts ? moment(ts).format("YYYY.MM.DD HH:mm") : "",
        customerName: v.customerName || "-",
        customerBirth: v.customerBirth || "-",
        items: Array.isArray(v.items)
          ? v.items.map((it) => `${it.name}(${it.quantity})`).join(", ")
          : "",
        total: v.total ?? 0,
        lifelove: v.lifelove ? "O" : "-",
        handledBy: v.handledBy || "-",
      });

      applyExcelBodyStyle(row);
      // 숫자 포맷팅
      row.getCell("total").numFmt = "#,##0";
    });

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  saveAs(
    new Blob([buffer]),
    `물품제공내역_${ymd(fromDate)}_${ymd(toDate)}.xlsx`,
  );
}

// === [업데이트] 방문 기록 엑셀 내보내기 (ExcelJS 버전) ===
async function exportVisitsXlsx(db, fromDate, toDate) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("방문기록");
  const toDay = (d) =>
    d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();

  worksheet.columns = [
    { header: "No.", key: "no", width: 8 },
    { header: "방문일자", key: "date", width: 18 },
    { header: "이용자ID", key: "customerId", width: 25 },
    { header: "이용자명", key: "customerName", width: 20 },
  ];

  applyExcelHeaderStyle(worksheet.getRow(1));

  let last = null,
    count = 0;
  while (true) {
    let qy = query(
      collection(db, "visits"),
      where("day", ">=", toDay(fromDate)),
      where("day", "<", toDay(toDate)),
      orderBy("day", "asc"),
      limit(1000),
    );
    if (last) qy = query(qy, startAfter(last));
    const snap = await getDocs(qy);
    if (snap.empty) break;

    snap.forEach((d) => {
      const v = d.data();
      count++;
      const row = worksheet.addRow({
        no: count,
        date: v.dateKey || v.day || "",
        customerId: v.customerId || "",
        customerName: v.customerName || "-",
      });
      applyExcelBodyStyle(row);
    });

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 1000) break;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  saveAs(new Blob([buffer]), `방문기록_${ymd(fromDate)}_${ymd(toDate)}.xlsx`);
}

function fiscalDefaultRange() {
  const now = new Date();
  const from = new Date(now.getFullYear() - 1, 2, 1);
  const to = new Date(now.getFullYear(), 2, 1);
  return { from, to };
}
function parseYmdDots(s) {
  const t = String(s || "").trim();
  if (!t) return new Date("invalid");
  return new Date(t.replace(/\./g, "-") + "T00:00:00");
}
function fmtDot(d) {
  return window.moment
    ? moment(d).format("YYYY.MM.DD")
    : d.toISOString().slice(0, 10).replace(/-/g, ".");
}

const VIRTUAL_THRESHOLD = 200;
let rowHeight = 60; // TDS 테이블 행 높이에 맞춰 조정
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
function fmtServerTimestamp(ts) {
  if (!ts) return "";
  try {
    if (typeof ts.toDate === "function")
      return ts.toDate().toLocaleString("ko-KR");
    const sec = ts._seconds ?? ts.seconds;
    const ns = ts._nanoseconds ?? ts.nanoseconds ?? 0;
    if (typeof sec === "number")
      return new Date(sec * 1000 + Math.floor(ns / 1e6)).toLocaleString(
        "ko-KR",
      );
    if (typeof ts === "string") return new Date(ts).toLocaleString("ko-KR");
  } catch {}
  return "";
}
function slugId(name, birth) {
  const n = String(name || "").replace(/\s+/g, "");
  const b = String(birth || "").replace(/\D/g, "");
  return `${n}_${b}`;
}

function roleOptions(selected) {
  const ro = ["admin", "user", "pending"]; // 'manager' 삭제됨
  return ro
    .map(
      (r) =>
        `<option value="${r}" ${r === selected ? "selected" : ""}>${r}</option>`,
    )
    .join("");
}

function toggleSearchError(show) {
  const group = els.q.closest(".field-group");
  const errText = group?.querySelector(".field-error-text");

  if (show) {
    group?.classList.add("is-error");
    errText?.classList.remove("hidden");
  } else {
    group?.classList.remove("is-error");
    errText?.classList.add("hidden");
  }
}

function triggerSearch() {
  const query = (els.q.value || "").trim();

  // 검색어가 없어도 에러를 띄우지 않고(false) 전체 목록을 조회합니다.
  toggleSearchError(false);

  latestQuery = query;
  nextPageToken = null;
  latestFilters = {
    role: els.fRole?.value || "",
    provider: (els.fProvider?.value || "").trim(),
    sort: els.fSort?.value || "lastSignInTime:desc",
  };

  fetchUsers(latestQuery, false).catch((e) =>
    showToast(e.message || String(e), true),
  );
}

function renderRows(users) {
  if (!Array.isArray(users)) users = [];

  // [중요] 렌더링 시작 전 기존 내용 초기화 (필수)
  els.tbody.innerHTML = "";

  if (!users.length) {
    // 데이터가 없으면 Empty State 표시
    renderEmptyState(
      els.tbody,
      "조건에 맞는 사용자가 없습니다.",
      "fa-user-slash",
      "검색어를 변경해보세요.",
    );
    // 선택 UI 업데이트 (0명 선택됨으로 리셋)
    updateSelectionUI();
    return;
  }

  if (currentUsers.length > VIRTUAL_THRESHOLD) {
    // 가상 스크롤 모드
    els.tbody.innerHTML = `
      <tr class="vspacer"><td colspan="8"><div class="pad" id="pad-top"></div></td></tr>
      <tr id="v-anchor"></tr>
      <tr class="vspacer"><td colspan="8"><div class="pad" id="pad-bot"></div></td></tr>`;
    mountVirtualWindow();
  } else {
    // 일반 렌더링 모드
    const frag = document.createDocumentFragment();
    users.forEach((u) => frag.appendChild(renderRow(u)));
    els.tbody.appendChild(frag);

    // 행 높이 계산 (가상 스크롤 대비용)
    const one = els.tbody.querySelector("tr:not(.vspacer)");
    if (one) rowHeight = Math.max(50, one.offsetHeight || rowHeight);

    updateSelectionUI();
  }
}

function renderRow(u) {
  const tr = document.createElement("tr");
  if (u.disabled)
    tr.classList.add("is-disabled", "bg-slate-50", "dark:bg-slate-900/50");

  // 상태 뱃지 로직
  let statusBadge = "";
  if (u.disabled) {
    statusBadge = `<span class="badge badge-sm badge-fill-grey">비활성</span>`;
  } else if (u.role === "admin") {
    statusBadge = `<span class="badge badge-sm badge-weak-primary">관리자</span>`;
  } else if (u.role === "manager") {
    statusBadge = `<span class="badge badge-sm badge-weak-success">매니저</span>`;
  } else if (u.role === "pending") {
    // [신규] pending 상태일 때 주황색 뱃지
    statusBadge = `<span class="badge badge-sm badge-weak-warning text-amber-600 bg-amber-50 dark:bg-amber-900/30 dark:text-amber-400">승인대기</span>`;
  } else {
    statusBadge = `<span class="badge badge-sm badge-weak-grey">일반</span>`;
  }

  // 이상 징후 버튼
  const checkBadge = `<span class="badge badge-xs badge-weak-grey cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors" data-anom="${u.uid}">확인</span>`;

  tr.innerHTML = `
    <td class="text-center">
      <div class="flex items-center justify-center">
        <input type="checkbox" class="input-toss row-chk" data-uid="${u.uid}">
      </div>
    </td>
    <td class="font-medium text-slate-900 dark:text-slate-100">${u.email || "-"}</td>
    <td class="text-slate-600 dark:text-slate-400 whitespace-nowrap">${u.displayName || "-"}</td>
    <td>
      <div class="field-box !h-8 w-28 bg-transparent border border-slate-200 dark:border-slate-700">
        <select class="field-input role-select text-sm py-0" data-uid="${u.uid}" ${u.disabled ? "disabled" : ""}>
          ${roleOptions(u.role)}
        </select>
      </div>
    </td>
    <td class="text-xs text-slate-500">${fmtTime(u.lastSignInTime)}</td>
    <td class="text-xs text-slate-500">${(u.providers || []).join(", ") || "-"}</td>
    <td class="text-center">${checkBadge}</td>
    <td class="text-center">
      <div class="flex items-center justify-center gap-1">
        <button class="btn btn-ghost w-8 h-8 p-0 rounded-lg btn-apply text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20" data-uid="${u.uid}" ${u.disabled ? "disabled" : ""} title="역할 저장">
          <i class="fas fa-check"></i>
        </button>
        <button class="btn btn-ghost w-8 h-8 p-0 rounded-lg btn-delete text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20" data-uid="${u.uid}" title="삭제">
          <i class="fas fa-trash"></i>
        </button>
      </div>
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
    padTop.style.height = `${firstIndex * rowHeight}px`;
    padBot.style.height = `${Math.max(0, (currentUsers.length - lastIndex) * rowHeight)}px`;
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

// [수정] fetchUsers: 초기 로딩 시 최소 0.5초 대기 (스켈레톤 깜빡임 방지)
async function fetchUsers(q = "", append = false) {
  const user = auth.currentUser;
  if (!user) return;

  // 1. 더보기(append)가 아닐 때만 스켈레톤 표시
  if (!append) {
    makeSectionSkeleton(els.tbody);
  }

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (nextPageToken && append) params.set("next", nextPageToken);
  params.set("limit", "50");
  if (latestFilters.role) params.set("role", latestFilters.role);
  if (latestFilters.provider) params.set("provider", latestFilters.provider);
  if (latestFilters.sort) params.set("sort", latestFilters.sort);

  try {
    // 2. API 요청 프로미스 생성
    const fetchPromise = adminFetch(`/api/admin/users?` + params.toString());

    let res;

    if (!append) {
      // [핵심] 초기 로딩일 경우: API 응답과 0.5초 타이머 중 '더 늦은 것'을 기다림
      const [apiRes] = await Promise.all([
        fetchPromise,
        new Promise((resolve) => setTimeout(resolve, 2000)), // 최소 0.5초 보장
      ]);
      res = apiRes;
    } else {
      // 더보기일 경우: API 응답만 즉시 기다림 (딜레이 불필요)
      res = await fetchPromise;
    }

    const data = await res.json();

    if (!res.ok || !data.ok) throw new Error(data?.message || "조회 실패");

    nextPageToken = data.nextPageToken || null;
    const users = data.users || [];

    // 검색어가 있는데 결과가 0건이면 -> 에러 표시
    if (q && users.length === 0) {
      toggleSearchError(true);
    } else {
      toggleSearchError(false);
    }

    if (append) {
      currentUsers = currentUsers.concat(users);
    } else {
      currentUsers = users;
    }

    // 3. 렌더링 (이 시점에서 0.5초가 지났으므로 스켈레톤이 자연스럽게 교체됨)
    renderRows(currentUsers);

    if (els.btnMore)
      els.btnMore.style.display = nextPageToken ? "inline-flex" : "none";
  } catch (e) {
    if (!append) renderRows([]);
    showToast(e.message || String(e), true);
  }
}

async function applyRole(uid, role, btnElement) {
  // btnElement 추가됨
  const user = auth.currentUser;
  if (!user) return;

  // [로딩 시작] 버튼 안에 점 3개 애니메이션 표시
  setBusy(btnElement, true);

  try {
    const res = await adminFetch(`/api/admin/setRole`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, role }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.message || "적용 실패");

    showToast("역할이 적용되었습니다.");
  } catch (e) {
    showToast(e.message || "오류 발생", true);
  } finally {
    // [로딩 종료] 버튼 원상 복구
    setBusy(btnElement, false);
  }
}

async function applyRoleBulk(role) {
  if (!role) return showToast("역할을 선택하세요.", true);
  const checked = [...document.querySelectorAll(".row-chk:checked")].map((c) =>
    c.getAttribute("data-uid"),
  );
  if (!checked.length) return showToast("선택된 사용자가 없습니다.", true);

  // 1. 버튼 로딩 시작
  setBusy(els.btnBulkRole, true);

  try {
    const res = await adminFetch(`/api/admin/setRoleBulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: checked.map((uid) => ({ uid, role })) }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data?.message || "일괄 적용 실패");

    showToast(
      `역할 일괄 적용 완료(성공 ${data.success} / 실패 ${data.fail.length})`,
    );

    // 2. [추가] 테이블 데이터 새로고침 (현재 검색 조건 유지)
    await fetchUsers(latestQuery, false);
    // 체크박스 해제 및 UI 갱신
    if (els.chkAll) els.chkAll.checked = false;
    updateSelectionUI();
  } catch (e) {
    showToast(e.message || String(e), true);
  } finally {
    // 3. 버튼 로딩 종료
    setBusy(els.btnBulkRole, false);
  }
}

async function disableEnable(uidList, disabled) {
  if (!uidList.length) return showToast("선택된 사용자가 없습니다.", true);

  // [로딩 시작] 화면 전체 가림
  showLoading(
    disabled ? "계정을 비활성화 중입니다." : "계정을 활성화 중입니다.",
  );

  try {
    for (const uid of uidList) {
      const res = await adminFetch(`/api/admin/disableUser`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, disabled }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error("일부 처리 실패");
    }
    // 상태 업데이트
    currentUsers = currentUsers.map((u) =>
      uidList.includes(u.uid) ? { ...u, disabled } : u,
    );
    renderRows(currentUsers);
    showToast(disabled ? "비활성화 완료" : "활성화 완료");
  } catch (e) {
    showToast(e.message, true);
  } finally {
    // [로딩 종료]
    hideLoading();
  }
}

// 일괄 버튼 리스너 (기존 코드에 로딩 적용된 함수 연결)
els.btnDisable?.addEventListener("click", async () => {
  const targets = getSelectedUids();
  // ... (본인 확인 로직) ...
  disableEnable(targets, true);
});

async function forceReset(uidList) {
  if (!uidList.length) return showToast("선택된 사용자가 없습니다.", true);
  const links = [];
  for (const uid of uidList) {
    const res = await adminFetch(`/api/admin/forcePasswordReset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

async function revokeSelected() {
  const targets = getSelectedUids();
  if (!targets.length) return showToast("선택된 사용자가 없습니다.", true);
  for (const uid of targets) {
    const res = await adminFetch(`/api/admin/revokeTokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid }),
    });
    if (!res.ok) return showToast("일부 실패", true);
  }
  showToast("전원 로그아웃 완료");
}

// [수정] 대시보드 카운터 로드 (0.5초 스켈레톤 유지)
async function loadCounters() {
  const ids = [
    "cRoles",
    "cDisable",
    "cReset",
    "cDelete",
    "c7Roles",
    "c7Disable",
    "c7Reset",
    "c7Delete",
  ];

  // 1. 로딩 시작: 스켈레톤 UI 표시
  ids.forEach((id) => {
    if (els[id]) {
      els[id].innerHTML =
        `<div class="h-6 w-8 bg-slate-200 dark:bg-slate-700 rounded animate-pulse inline-block align-middle"></div>`;
    }
  });

  try {
    // 2. API 요청 + 최소 0.5초 대기 병렬 실행
    // (API가 빨리 끝나도 0.5초는 무조건 기다림)
    const fetchPromise = adminFetch(`/api/admin/counters?range=both`);
    const delayPromise = new Promise((resolve) => setTimeout(resolve, 2000));

    const [res] = await Promise.all([fetchPromise, delayPromise]);

    if (!res.ok) throw new Error("counters-failed");

    const { today = {}, week = {} } = await res.json();

    // 3. 데이터 매핑
    const map = {
      cRoles: today.rolesChanged,
      cDisable: today.usersDisabled,
      cReset: today.passwordResets,
      cDelete: today.userDeleted,
      c7Roles: week.rolesChanged,
      c7Disable: week.usersDisabled,
      c7Reset: week.passwordResets,
      c7Delete: week.userDeleted,
    };

    // 4. 렌더링 (천단위 콤마 적용)
    ids.forEach((id) => {
      if (els[id]) {
        const val = map[id] || 0;
        els[id].textContent = val.toLocaleString();
      }
    });
  } catch (e) {
    console.warn("Counters load failed:", e);
    // 에러 시 '-' 표시
    ids.forEach((id) => {
      if (els[id]) els[id].textContent = "-";
    });
  }
}

function getSelectedUids() {
  return [...document.querySelectorAll(".row-chk:checked")].map((c) =>
    c.getAttribute("data-uid"),
  );
}
// [수정] 선택 카운터 업데이트 (사용자 탭 & 승인 탭 공용)
function updateSelectionUI() {
  // 1. 사용자 관리 탭
  const userBoxes = [
    ...document.querySelectorAll("#admin-user-tbody .row-chk"),
  ];
  const userCount = userBoxes.filter((b) => b.checked).length;
  if (els.selCount) els.selCount.textContent = String(userCount);
  if (els.chkAll) {
    els.chkAll.checked =
      userBoxes.length > 0 && userBoxes.every((b) => b.checked);
    els.chkAll.indeterminate =
      userBoxes.some((b) => b.checked) && !els.chkAll.checked;
  }
  userBoxes.forEach((b) =>
    b.closest("tr")?.classList.toggle("bg-blue-50/50", b.checked),
  );

  // 사용자 탭 일괄 버튼 활성화 처리
  if (els.bulkActions) {
    if (userCount > 0)
      els.bulkActions.classList.remove("opacity-50", "pointer-events-none");
    else els.bulkActions.classList.add("opacity-50", "pointer-events-none");
  }

  // 2. [신규] 승인 요청 탭 카운터
  const aprBoxes = [...document.querySelectorAll("#approvals-tbody .apr-chk")];
  const aprCount = aprBoxes.filter((b) => b.checked).length;

  const aprCountEl = document.getElementById("apr-sel-count"); // 아래 HTML에서 추가할 예정
  if (aprCountEl) aprCountEl.textContent = String(aprCount);

  if (els.aprAll) {
    els.aprAll.checked =
      aprBoxes.length > 0 && aprBoxes.every((b) => b.checked);
    els.aprAll.indeterminate =
      aprBoxes.some((b) => b.checked) && !els.aprAll.checked;
  }
  aprBoxes.forEach((b) =>
    b.closest("tr")?.classList.toggle("bg-blue-50/50", b.checked),
  );
}

els.tbody?.addEventListener("change", (e) => {
  const box = e.target;
  if (box && box.classList?.contains("row-chk")) updateSelectionUI();
});

// [신규] 액션 영문명 -> 한글 변환 헬퍼
function getActionName(action) {
  const map = {
    setRole: "역할 설정",
    setRoleBulk: "다량 역할 설정",
    disableUser: "사용자 비활성",
    enableUser: "사용자 활성",
    forcePasswordReset: "비밀번호 초기화",
    deleteUser: "사용자 삭제",
    revokeTokens: "강제 로그아웃",
    checkAnomalies: "이상징후 조회",
  };
  // 매핑된 한글이 있으면 반환, 없으면 원본 영문 반환
  return map[action] || action;
}

// [수정] 감사 로그 조회 (이메일/이름 -> UID 자동 변환 검색)
async function fetchLogs() {
  makeSectionSkeleton(els.logsTbody);

  const queryValRaw = (els.logUid?.value || "").trim();
  const queryVal = queryValRaw; // 표시용 원본
  const action = (els.logAction?.value || "").trim();
  const scope = (els.logScope?.value || "both").trim(); // both | actor | target

  const params = new URLSearchParams();
  if (action) params.set("action", action);
  params.set("limit", "50");
  if (scope && scope !== "both") params.set("who", scope);

  try {
    let targetUid = "";

    // 1. 검색어(이메일/이름)가 있다면 -> UID로 변환 과정을 거침
    if (queryVal) {
      const qLower = queryValRaw.toLowerCase();

      // ✅ UID는 바로 사용(삭제/미존재여도 logs 조회는 가능)
      if (qLower.length === 28 && !qLower.includes("@")) {
        targetUid = queryValRaw;
      } else {
        /**
         * ✅ /api/admin/users 가 listUsers(페이지네이션) 기반이라
         *    첫 페이지에 없으면 users:[] + nextPageToken 이 나올 수 있음.
         *    따라서 nextPageToken 을 따라가며 최대 N페이지까지 찾아본다.
         */
        let next = null;
        let found = null;
        const MAX_PAGES = 20; // 안전장치(50*20=1000명)

        for (let i = 0; i < MAX_PAGES; i++) {
          const usp = new URLSearchParams();
          usp.set("limit", "50");
          usp.set("q", qLower);
          if (next) usp.set("next", next);

          const userRes = await adminFetch(
            `/api/admin/users?` + usp.toString(),
          );
          const userData = await userRes.json();

          const users = Array.isArray(userData.users) ? userData.users : [];
          found =
            users.find((u) => (u.email || "").toLowerCase() === qLower) ||
            users.find((u) => (u.email || "").toLowerCase().includes(qLower)) ||
            users.find((u) =>
              (u.displayName || "").toLowerCase().includes(qLower),
            );

          if (found?.uid) break;

          next = userData.nextPageToken || null;
          if (!next) break;
        }

        if (found?.uid) {
          targetUid = found.uid;
        } else {
          els.logsTbody.innerHTML = "";
          renderEmptyState(
            els.logsTbody,
            `'${queryVal}' 사용자를 찾을 수 없습니다.`,
            "fa-user-slash",
          );
          return;
        }
      }
    }

    // 2. 확정된 UID 설정
    if (targetUid) params.set("uid", targetUid);

    // 3. 로그 API 요청 + 0.5초 대기 (스켈레톤 유지)
    const fetchPromise = adminFetch(`/api/admin/logs?` + params.toString());
    const delayPromise = new Promise((resolve) => setTimeout(resolve, 500));

    const [res] = await Promise.all([fetchPromise, delayPromise]);
    const data = await res.json();

    if (!res.ok || !data.ok) throw new Error("로그 조회 실패");

    const logs = data.logs || [];

    // 4. 렌더링
    els.logsTbody.innerHTML = "";

    if (!logs.length) {
      renderEmptyState(
        els.logsTbody,
        "조건에 맞는 로그가 없습니다.",
        "fa-history",
      );
      return;
    }

    const frag = document.createDocumentFragment();
    for (const l of logs) {
      const tr = document.createElement("tr");

      // 상태 뱃지
      let statusBadge = `<span class="badge badge-sm badge-weak-grey">${l.status || "-"}</span>`;
      if (l.status === "success" || l.status === "ok")
        statusBadge = `<span class="badge badge-sm badge-weak-success">성공</span>`;
      else if (l.status === "fail" || l.status === "error")
        statusBadge = `<span class="badge badge-sm badge-weak-danger">실패</span>`;

      // 액션명 한글 변환
      const actionName = getActionName(l.action);

      // 대상(Target) 표시 (목록 매핑)
      let targetDisplay = "-";
      let fullUid = "";

      if (Array.isArray(l.targets)) {
        targetDisplay = `${l.targets.length}명 대상`;
        fullUid = l.targets.join(", ");
      } else if (l.targetUid) {
        fullUid = l.targetUid;
        const matchedUser = currentUsers.find((u) => u.uid === l.targetUid);
        if (matchedUser) {
          targetDisplay =
            matchedUser.email || matchedUser.displayName || l.targetUid;
        } else {
          targetDisplay = l.targetEmail || l.targetUid;
        }
      }

      tr.innerHTML = `
        <td class="text-sm text-slate-500">${fmtServerTimestamp(l.createdAt)}</td>
        <td class="font-medium text-slate-800 dark:text-slate-200">${l.actorEmail || l.actorUid || "-"}</td>
        <td><span class="badge badge-sm badge-weak-primary">${actionName}</span></td>
        <td class="text-sm text-slate-600 max-w-[200px] truncate cursor-help" title="${fullUid}">
          ${targetDisplay}
        </td>
        <td>${statusBadge}</td>`;
      frag.appendChild(tr);
    }
    els.logsTbody.appendChild(frag);
  } catch (e) {
    console.error(e);
    els.logsTbody.innerHTML = "";
    renderEmptyState(
      els.logsTbody,
      "로그를 불러오지 못했습니다.",
      "fa-exclamation-circle",
    );
    showToast("로그 조회 실패", true);
  }
}

// els.tbody?.addEventListener("click", async (e) => {
//   const del = e.target.closest(".btn-delete");
//   if (!del) return;
//   const uid = del.getAttribute("data-uid");
//   const ok = await openConfirm({
//     title: "계정 삭제",
//     message: "정말 이 계정을 삭제할까요? 되돌릴 수 없습니다.",
//     variant: "warn",
//     confirmText: "삭제",
//     cancelText: "취소",
//   });
//   if (!ok) return;
//   try {
//     const res = await adminFetch(`/api/admin/deleteUser`, {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify({ uid }),
//     });
//     const data = await res.json();
//     if (!res.ok || !data.ok) throw new Error(data?.message || "삭제 실패");
//     currentUsers = currentUsers.filter((u) => u.uid !== uid);
//     els.tbody
//       .querySelector(`button[data-uid="${uid}"]`)
//       ?.closest("tr")
//       ?.remove();
//     updateSelectionUI();
//     showToast("삭제 완료");
//   } catch (err) {
//     showToast(err.message || "삭제 실패", true);
//   }
// });

els.tbody?.addEventListener("click", async (e) => {
  const badge = e.target.closest("[data-anom]");
  if (!badge) return;

  const uid = badge.getAttribute("data-anom");
  if (!uid) return;

  // 로딩 표시
  const originalText = badge.textContent;
  badge.innerHTML = `<i class="fas fa-circle-notch fa-spin"></i>`;
  badge.classList.add("pointer-events-none", "opacity-70");

  try {
    // [수정] 주소 변경: checkAnomalies -> userLoginAnomalies
    const res = await adminFetch(
      `/api/admin/userLoginAnomalies?uid=${encodeURIComponent(uid)}&limit=10`,
    );

    // (이하 에러 처리 및 결과 표시 로직은 그대로 유지)
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.message || `오류 (${res.status})`);
    }

    const data = await res.json();

    if (data.ok) {
      const isChanged = data.countryChanged;
      const newDev = data.newDevices || 0;

      const text = `국가변경: ${isChanged ? "있음" : "없음"} / 새 기기: ${newDev}`;
      badge.textContent = text;

      badge.className =
        isChanged || newDev > 0
          ? "badge badge-xs badge-fill-danger cursor-default"
          : "badge badge-xs badge-fill-success cursor-default";
    } else {
      throw new Error(data.message || "조회 실패");
    }
  } catch (err) {
    console.error("Anomaly check failed:", err);
    showToast("조회 실패", true);
    badge.textContent = originalText;
  } finally {
    badge.classList.remove("pointer-events-none", "opacity-70");
  }
});

els.chkAll?.addEventListener("change", () => {
  const on = els.chkAll.checked;
  document.querySelectorAll(".row-chk").forEach((cb) => (cb.checked = on));
  updateSelectionUI();
});

els.btnBulkRole?.addEventListener("click", () =>
  applyRoleBulk(els.bulkRole?.value),
);
// 1. 비활성화 (Disable)
els.btnDisable?.addEventListener("click", async () => {
  const targets = getSelectedUids();
  if (!targets.length) return showToast("선택된 사용자가 없습니다.", true);

  // 본인 포함 경고
  if (targets.includes(auth.currentUser?.uid)) {
    const ok = await openConfirm({
      title: "본인 계정 포함됨",
      message:
        "선택 항목에 <b>본인 계정</b>이 포함되어 있습니다.<br>비활성화 시 관리자 페이지 접근이 차단됩니다.<br>그래도 진행하시겠습니까?",
      variant: "danger",
      confirmText: "위험 감수하고 진행",
      cancelText: "취소",
    });
    if (!ok) return;
  } else {
    // 일반 경고
    const ok = await openConfirm({
      title: "계정 비활성화",
      message: `선택한 <b>${targets.length}명</b>의 계정을 비활성화하시겠습니까?<br>해당 사용자는 로그인이 차단됩니다.`,
      variant: "warn",
      confirmText: "비활성화",
      cancelText: "취소",
    });
    if (!ok) return;
  }

  disableEnable(targets, true);
});

// 2. 활성화 (Enable)
els.btnEnable?.addEventListener("click", async () => {
  const targets = getSelectedUids();
  if (!targets.length) return showToast("선택된 사용자가 없습니다.", true);

  const ok = await openConfirm({
    title: "계정 활성화",
    message: `선택한 <b>${targets.length}명</b>의 계정을 다시 활성화하시겠습니까?`,
    variant: "info",
    confirmText: "활성화",
    cancelText: "취소",
  });
  if (!ok) return;

  disableEnable(targets, false);
});

// 3. 비밀번호 초기화 (Reset PW) - 가장 위험!
els.btnReset?.addEventListener("click", async () => {
  const targets = getSelectedUids();
  if (!targets.length) return showToast("선택된 사용자가 없습니다.", true);

  const ok = await openConfirm({
    title: "비밀번호 초기화",
    message: `선택한 <b>${targets.length}명</b>에게 비밀번호 재설정 메일을 발송합니다.<br>기존 세션은 모두 만료시킵니다. 진행할까요?`,
    variant: "danger",
    confirmText: "초기화 메일 발송",
    cancelText: "취소",
  });
  if (!ok) return;

  // 로딩 시작 (forceReset 함수 내부에 로딩이 없으므로 여기서 감싸거나 함수 수정 필요)
  // 여기서는 간단하게 showLoading을 직접 호출
  showLoading("초기화 링크 생성 중...");
  try {
    await forceReset(targets);
  } finally {
    hideLoading();
  }
});
els.btnExport?.addEventListener("click", async () => {
  if (!currentUsers.length) return showToast("내보낼 데이터가 없습니다.", true);

  // 버튼 로딩
  setBusy(els.btnExport, true);

  try {
    // ... (엑셀 생성 로직: 약간의 지연 시뮬레이션이 필요하다면 await 사용) ...
    exportXLSX(); // 동기 함수지만 파일 생성 시간이 듬
    await new Promise((r) => setTimeout(r, 500)); // 시각적 피드백용 지연
  } finally {
    setBusy(els.btnExport, false);
  }
});
els.btnLogs?.addEventListener("click", () =>
  fetchLogs().catch((e) => showToast("로그 조회 실패", true)),
);
els.btnRevoke?.addEventListener("click", async () => {
  const targets = getSelectedUids();
  if (!targets.length) return showToast("선택된 사용자가 없습니다.", true);

  const ok = await openConfirm({
    title: "강제 로그아웃",
    message: `선택한 <b>${targets.length}명</b>의 인증 토큰을 만료시킵니다.<br>사용자들은 다음 요청 시 재로그인해야 합니다.`,
    variant: "warn",
    confirmText: "로그아웃 처리",
    cancelText: "취소",
  });
  if (!ok) return;

  showLoading("로그아웃 처리 중...");
  try {
    await revokeSelected();
  } finally {
    hideLoading();
  }
});
els.logUid?.addEventListener("keydown", (e) => {
  if (e.key === "Enter")
    fetchLogs().catch(() => showToast("로그 조회 실패", true));
});

// [추가] 셀렉트 박스 변경 시 자동 조회 (선택 사항 - 원치 않으시면 제외 가능)
els.logAction?.addEventListener("change", () =>
  fetchLogs().catch(() => showToast("로그 조회 실패", true)),
);
els.logScope?.addEventListener("change", () =>
  fetchLogs().catch(() => showToast("로그 조회 실패", true)),
);

// [신규] 대기 건수 확인 및 탭 배지 업데이트
async function updateTabBadges() {
  try {
    // app.js에 이미 구현된 API 활용
    const res = await adminFetch("/api/admin/pending-summary");
    const data = await res.json();

    if (res.ok && data.ok) {
      // 1. 사용자 탭 배지 (pendingUsers가 있을 때)
      const userBadge = document.getElementById("badge-users");
      if (userBadge) {
        if (data.pendingUsers > 0) {
          userBadge.textContent =
            data.pendingUsers > 99 ? "99+" : data.pendingUsers;
          userBadge.classList.remove("hidden");
        } else {
          userBadge.classList.add("hidden");
        }
      }

      // 2. 승인 탭 배지 (userPending + productPending)
      const aprBadge = document.getElementById("badge-approvals");
      const totalPending = (data.userPending || 0) + (data.productPending || 0);
      if (aprBadge) {
        if (totalPending > 0) {
          aprBadge.textContent = totalPending > 99 ? "99+" : totalPending;
          aprBadge.classList.remove("hidden");
        } else {
          aprBadge.classList.add("hidden");
        }
      }
    }
  } catch (e) {
    console.warn("Badge update failed", e);
  }
}

onAuthStateChanged(auth, (user) => {
  if (!user) return;
  (async () => {
    try {
      if (!isStsValid(ADMIN_STS, 60_000)) await ensureAdminSession(true);
      else await ensureAdminSession(false);
    } catch {}

    // [변경] 페이지 진입 시 검색어 없이('') 전체 목록 조회
    fetchUsers("", false).catch((e) => showToast(e.message || String(e), true));

    loadCounters().catch(() => {});
    updateTabBadges();
    // [추가] 로그 테이블 초기 Empty State 설정
    // 기존의 텍스트만 있는 행 대신, 아이콘이 포함된 표준 Empty State를 띄웁니다.
    renderEmptyState(
      els.logsTbody,
      "조건을 선택하고 조회하세요.",
      "fa-search",
      "검색 대상이나 액션을 선택하여 로그를 확인할 수 있습니다.",
    );
    bindTabs();

    const $from = document.getElementById("yr-start");
    const $to = document.getElementById("yr-end");
    const $btnDefault = document.getElementById("btn-annual-default");
    const $btnProv = document.getElementById("btn-export-provisions-year");
    const $btnVis = document.getElementById("btn-export-visits-year");
    const $confirm = document.getElementById("purge-confirm");
    const $purge = document.getElementById("btn-purge-run");
    // 1. 회계연도 기준 날짜를 먼저 계산합니다.
    const { from, to } = fiscalDefaultRange();
    const startMoment = moment(from);
    const endMoment = moment(to);

    try {
      if (window.$ && $.fn.daterangepicker && $from && $to) {
        const ranges = {
          오늘: [moment(), moment()],
          어제: [moment().subtract(1, "days"), moment().subtract(1, "days")],
          "최근 7일": [moment().subtract(6, "days"), moment()],
          "이번 달": [moment().startOf("month"), moment().endOf("month")],
          "지난 달": [
            moment().subtract(1, "month").startOf("month"),
            moment().subtract(1, "month").endOf("month"),
          ],
          "1년": [moment().subtract(1, "year"), moment()],
        };

        const pickerOptions = {
          autoApply: true,
          autoUpdateInput: false,
          ranges: ranges,
          alwaysShowCalendars: true,
          showDropdowns: true,
          opens: "left",
          locale: {
            format: "YYYY.MM.DD",
            separator: " ~ ",
            applyLabel: "확인",
            cancelLabel: "취소",
            fromLabel: "From",
            toLabel: "To",
            customRangeLabel: "직접 선택",
            weekLabel: "주",
            daysOfWeek: ["일", "월", "화", "수", "목", "금", "토"],
            monthNames: [
              "1월",
              "2월",
              "3월",
              "4월",
              "5월",
              "6월",
              "7월",
              "8월",
              "9월",
              "10월",
              "11월",
              "12월",
            ],
            firstDay: 0,
          },
          // 2. 초기화 옵션에 계산된 회계연도 날짜를 넣습니다.
          startDate: startMoment,
          endDate: endMoment,
        };

        const jFrom = $("#yr-start");
        jFrom.daterangepicker(pickerOptions);

        // 3. 피커 이벤트 및 input 동기화 로직 유지
        $("#yr-end").on("click", () => {
          jFrom.data("daterangepicker").show();
        });

        jFrom.on("apply.daterangepicker", function (ev, picker) {
          $from.value = picker.startDate.format("YYYY.MM.DD");
          $to.value = picker.endDate.format("YYYY.MM.DD");
        });

        // 4. 초기 화면 표시 업데이트
        $from.value = startMoment.format("YYYY.MM.DD");
        $to.value = endMoment.format("YYYY.MM.DD");
      }
    } catch (e) {
      console.error("Admin daterangepicker init error:", e);
    }

    const setDefaults = () => {
      const { from, to } = fiscalDefaultRange();
      if ($from) $from.value = fmtDot(from);
      if ($to) $to.value = fmtDot(to);
    };
    setDefaults();
    $btnDefault?.addEventListener("click", setDefaults);
    $btnProv?.addEventListener("click", async () => {
      try {
        const fd = parseYmdDots($from?.value);
        const td = parseYmdDots($to?.value);
        if (isNaN(fd) || isNaN(td) || td <= fd)
          return showToast("기간을 확인하세요.", true);
        await exportProvisionsXlsx(db, fd, td);
        showToast("제공 XLSX가 내려받아졌습니다.");
      } catch (e) {
        showToast("내보내기 실패", true);
      }
    });
    $btnVis?.addEventListener("click", async () => {
      try {
        const fd = parseYmdDots($from?.value);
        const td = parseYmdDots($to?.value);
        if (isNaN(fd) || isNaN(td) || td <= fd)
          return showToast("기간을 확인하세요.", true);
        await exportVisitsXlsx(db, fd, td);
        showToast("방문 XLSX가 내려받아졌습니다.");
      } catch (e) {
        showToast("내보내기 실패", true);
      }
    });
    $purge?.addEventListener("click", async () => {
      const phraseOk = ($confirm?.value || "").trim() === "DELETE-DATA";
      if (!phraseOk)
        return showToast("삭제 확인문구가 일치하지 않습니다.", true);
      const ok = await openConfirm({
        title: "기간 데이터 삭제",
        message: "되돌릴 수 없습니다. 반드시 백업 후 진행하세요.",
        variant: "warn",
        confirmText: "삭제",
        cancelText: "취소",
      });
      if (!ok) return;
      try {
        const fd = parseYmdDots($from?.value);
        const td = parseYmdDots($to?.value);
        if (isNaN(fd) || isNaN(td) || td <= fd)
          return showToast("기간을 확인하세요.", true);
        const qs = (o) =>
          Object.entries(o)
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
            .join("&");
        const from = $from.value,
          to = $to.value;
        const r1 = await adminFetch(
          `/admin/purge?${qs({ collection: "provisions", from, to, confirm: "true" })}`,
          { method: "POST" },
        );
        const j1 = await r1.json();
        const r2 = await adminFetch(
          `/admin/purge?${qs({ collection: "visits", from, to, confirm: "true" })}`,
          { method: "POST" },
        );
        const j2 = await r2.json();
        showToast(
          `삭제 완료: 제공 ${j1.deleted || 0}건, 방문 ${j2.deleted || 0}건`,
        );
      } catch (e) {
        showToast("삭제 실패: " + (e.message || String(e)), true);
      }
    });
  })();
});

function bindTabs() {
  // 탭 버튼이 하나라도 없으면 중단
  if (!els.tabUsersBtn || !els.tabAprBtn || !els.tabMaintBtn) return;

  const act = (which) => {
    // 1. 모든 탭 비활성화 & 숨김
    els.tabUsersBtn.classList.remove("is-active");
    els.tabAprBtn.classList.remove("is-active");
    els.tabMaintBtn.classList.remove("is-active");

    if (els.tabUsersWrap) els.tabUsersWrap.hidden = true;
    if (els.aprCard) els.aprCard.hidden = true;
    if (els.tabMaintWrap) els.tabMaintWrap.hidden = true;

    // 2. 선택된 탭 활성화 & 표시
    if (which === "users") {
      els.tabUsersBtn.classList.add("is-active");
      if (els.tabUsersWrap) els.tabUsersWrap.hidden = false;
    } else if (which === "approvals") {
      els.tabAprBtn.classList.add("is-active");
      if (els.aprCard) els.aprCard.hidden = false;
      // 승인 목록 로드 (괄호 주의!)
      loadApprovals().catch(() => {});
    } else if (which === "maintenance") {
      els.tabMaintBtn.classList.add("is-active");
      if (els.tabMaintWrap) els.tabMaintWrap.hidden = false;
    }
  };

  // 3. 이벤트 리스너 연결
  els.tabUsersBtn.addEventListener("click", () => act("users"));
  els.tabAprBtn.addEventListener("click", () => act("approvals"));
  els.tabMaintBtn.addEventListener("click", () => act("maintenance"));

  // 4. 초기 상태: 사용자 관리 탭
  act("users");

  els.aprRefresh?.addEventListener("click", () => loadApprovals());

  // 일괄 승인 (Confirm 추가)
  els.aprApprove?.addEventListener("click", async () => {
    const ids = getCheckedApprovalIds();
    if (!ids.length) return showToast("선택된 요청이 없습니다.", true);

    const ok = await openConfirm({
      title: "일괄 승인",
      message: `선택한 ${ids.length}건의 요청을 모두 <b>승인</b>하시겠습니까?`,
      variant: "info",
      confirmText: "승인",
      cancelText: "취소",
    });
    if (ok) bulkApprove();
  });

  // 일괄 거부 (Confirm 추가)
  els.aprReject?.addEventListener("click", async () => {
    const ids = getCheckedApprovalIds();
    if (!ids.length) return showToast("선택된 요청이 없습니다.", true);

    const ok = await openConfirm({
      title: "일괄 거부",
      message: `선택한 ${ids.length}건의 요청을 모두 <b>거부</b>하시겠습니까?<br>거부된 요청은 복구할 수 없습니다.`,
      variant: "danger",
      confirmText: "거부",
      cancelText: "취소",
    });
    if (ok) bulkReject();
  });
  els.aprAll?.addEventListener("change", () => {
    const on = els.aprAll.checked;
    document
      .querySelectorAll("#approvals-tbody .apr-chk")
      .forEach((cb) => (cb.checked = on));
  });
  els.aprTbody?.addEventListener("click", async (e) => {
    const btnA = e.target.closest("[data-approve]");
    const btnR = e.target.closest("[data-reject]");

    if (btnA) {
      const id = btnA.getAttribute("data-approve");
      // (선택사항) 개별 승인 확인창
      const ok = await openConfirm({
        title: "승인 확인",
        message: "이 요청을 승인하시겠습니까?",
        variant: "info",
      });
      if (ok)
        approveOne(id).catch((err) =>
          showToast(err.message || String(err), true),
        );
    }

    if (btnR) {
      const id = btnR.getAttribute("data-reject");
      // (선택사항) 개별 거부 확인창
      const ok = await openConfirm({
        title: "거부 확인",
        message: "이 요청을 거부하시겠습니까?",
        variant: "danger",
      });
      if (ok)
        rejectOne(id).catch((err) =>
          showToast(err.message || String(err), true),
        );
    }
  });
  els.cLogsRefresh?.addEventListener("click", () => {
    pruneOldCustomerLogs();
    loadCustomerLogs();
  });
}

function getApprovalTypeName(type) {
  const map = {
    customer_add: "이용자 등록",
    customer_update: "이용자 수정",
    customer_delete: "이용자 삭제",
    customer_bulk_upload: "이용자 일괄 업로드",
    provision_delete: "제공 삭제", // 혹시 모를 추가 타입 대비
    provision_update: "제공 수정",
    lifelove_delete: "생명사랑 삭제",
  };
  return map[type] || type;
}

async function loadApprovals() {
  if (!els.aprTbody) return;

  // 1. 스켈레톤 표시
  makeSectionSkeleton(els.aprTbody);

  try {
    // 2. 데이터 요청 + 0.5초 대기
    const q = query(
      collection(db, "approvals"),
      orderBy("requestedAt", "desc"),
      limit(100),
    );
    const fetchPromise = getDocs(q);
    const delayPromise = new Promise((resolve) => setTimeout(resolve, 500));

    const [snap] = await Promise.all([fetchPromise, delayPromise]);

    approvals = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // 3. 렌더링
    renderApprovals();

    // 4. 체크박스 초기화 (헤더 체크박스 해제)
    if (els.aprAll) els.aprAll.checked = false;
  } catch (e) {
    console.error(e);
    showToast("승인 요청을 불러오지 못했습니다.", true);
    renderEmptyState(
      els.aprTbody,
      "데이터 로드 실패",
      "fa-exclamation-triangle",
    );
  }
}

function renderApprovals() {
  // 기존 내용 비우기
  els.aprTbody.innerHTML = "";

  if (!approvals.length) {
    renderEmptyState(
      els.aprTbody,
      "대기중인 승인 요청이 없습니다.",
      "fa-clipboard-check",
    );
    return;
  }

  const frag = document.createDocumentFragment();
  for (const a of approvals) {
    const tr = document.createElement("tr");

    // - customer*: 기존 방식 유지
    // - provision/lifelove*: payload.displayTarget 우선 사용(관리자가 ID를 몰라도 식별 가능)
    const target =
      a?.payload?.displayTarget ||
      (a.targetId
        ? a.targetId
        : a.payload
          ? `${a.payload.name || ""}/${a.payload.birth || ""}`
          : "-");

    // 요약 내용
    const summary = summarizeApproval(a);

    // 타입 한글화 및 뱃지 색상
    const typeName = getApprovalTypeName(a.type);
    let typeBadgeClass = "badge-weak-grey";
    if (a.type.includes("add")) typeBadgeClass = "badge-weak-success";
    else if (a.type.includes("update")) typeBadgeClass = "badge-weak-primary";
    else if (a.type.includes("delete")) typeBadgeClass = "badge-weak-danger";

    tr.innerHTML = `
      <td class="text-center"><div class="flex items-center justify-center"><input type="checkbox" class="input-toss apr-chk" data-id="${a.id}"></div></td>
      <td class="text-sm text-slate-500">${fmtServerTimestamp(a.requestedAt) || "-"}</td>
      <td class="font-medium text-slate-900 dark:text-slate-100">${a.requestedBy || "-"}</td>
      <td><span class="badge badge-sm ${typeBadgeClass}">${typeName}</span></td>
      <td class="text-sm text-slate-600 max-w-[150px] truncate" title="${target}">${target}</td>
      <td class="text-sm text-slate-700 dark:text-slate-300 max-w-[250px] truncate" title="${summary}">${summary}</td>
      <td class="text-center">
        <div class="flex items-center justify-center gap-1">
          <button class="btn btn-primary-weak btn-sm px-3" data-approve="${a.id}">승인</button>
          <button class="btn btn-danger-weak btn-sm px-3" data-reject="${a.id}">거부</button>
        </div>
      </td>`;
    frag.appendChild(tr);
  }
  els.aprTbody.appendChild(frag);
}

function summarizeApproval(a) {
  try {
    // ✅ 고객
    if (a.type === "customer_add") {
      const p = a.payload || {};
      return `추가: ${p.name || ""} / ${p.birth || ""} / ${p.status || ""}`;
    }
    if (a.type === "customer_update") {
      const ch = Object.keys(a.changes || {})
        .slice(0, 5)
        .map((k) => `${k}→${a.changes[k]}`)
        .join(", ");
      return `수정: ${ch}${Object.keys(a.changes || {}).length > 5 ? " …" : ""}`;
    }
    if (a.type === "customer_delete") return `삭제: ${a.targetId}`;

    // ✅ 제공(통계) - payload.displaySummary 우선
    if (a.type === "provision_delete") {
      const t = a?.payload?.displayTarget || a.targetId || "-";
      return a?.payload?.displaySummary || `제공 삭제: ${t}`;
    }
    if (a.type === "provision_update") {
      const p = a?.payload || {};
      // ✅ 통계 페이지에서 사람이 읽을 수 있는 문구를 만들어 payload.displaySummary로 넣어주므로 최우선 표시
      if (p.displaySummary) return p.displaySummary;

      const parts = [];
      const oldHandler = String(p.handledBy || p.handler || "").trim();
      const requestedHandler = String(p.requestedHandler || "").trim();
      if (p.newCustomerId && p.newCustomerId !== p.oldCustomerId) {
        const nm = String(p.newCustomerName || "").trim() || "-";
        parts.push(`이용자 -> ${nm}`);
      }
      if (requestedHandler && requestedHandler !== oldHandler) {
        parts.push(`처리자 -> ${requestedHandler}`);
      }
      const t = p.displayTarget || a.targetId || "-";
      return parts.length ? `수정: ${parts.join(" | ")}` : `수정: ${t}`;
    }

    // ✅ 생명사랑
    if (a.type === "lifelove_delete") {
      const t = a?.payload?.displayTarget || a.targetId || "-";
      return a?.payload?.displaySummary || `생명사랑 제공 삭제: ${t}`;
    }

    // ✅ 고객 업로드(비관리자 승인 요청 대비)
    if (a.type === "customer_bulk_upload") {
      const p = a.payload || {};
      const n = Array.isArray(p.rows) ? p.rows.length : 0;
      return `업로드: ${n}건`;
    }
  } catch {}
  return "-";
}

async function applyCustomerBulkUploadApproval(item) {
  const p = item?.payload || {};
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const options = p.options || {};
  const deactivateTargets = Array.isArray(p.deactivateTargets)
    ? p.deactivateTargets
    : [];

  const email = auth.currentUser?.email || "";
  const BATCH_LIMIT = 400;

  let batch = writeBatch(db);
  let written = 0;

  for (const r of rows) {
    const name = (r?.name || "").trim();
    const birth = (r?.birth || "").trim();
    if (!name || !birth) continue;
    const id = slugId(name, birth);

    batch.set(
      doc(db, "customers", id),
      {
        ...r,
        updatedAt: Timestamp.now(),
        updatedBy: email,
      },
      { merge: true },
    );
    written++;
    if (written % BATCH_LIMIT === 0) {
      await batch.commit();
      batch = writeBatch(db);
    }
  }
  if (written % BATCH_LIMIT !== 0) await batch.commit();

  let deactivated = 0;
  if (
    options?.statusMode === "all-support-stop-others" &&
    deactivateTargets.length
  ) {
    let b = writeBatch(db);
    for (const id of deactivateTargets) {
      if (!id) continue;
      b.update(doc(db, "customers", id), {
        status: "중단",
        updatedAt: Timestamp.now(),
        updatedBy: email,
      });
      deactivated++;
      if (deactivated % BATCH_LIMIT === 0) {
        await b.commit();
        b = writeBatch(db);
      }
    }
    if (deactivated % BATCH_LIMIT !== 0) await b.commit();
  }

  return { written, deactivated };
}

async function approveOne(id) {
  const item = approvals.find((x) => x.id === id);
  if (!item) return;
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
      { merge: true },
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
  } else if (item.type === "customer_bulk_upload") {
    const { written, deactivated } =
      await applyCustomerBulkUploadApproval(item);
    await logEvent("approval_approve", {
      approvalType: "customer_bulk_upload",
      written,
      deactivated,
    });
  } else if (item.type === "provision_update") {
    await applyProvisionUpdateApproval(item);
    await logEvent("approval_approve", {
      approvalType: "provision_update",
      targetId: item.targetId,
      summary: item?.payload?.displaySummary || summarizeApproval(item),
      target: item?.payload?.displayTarget || null,
    });
  } else if (item.type === "provision_delete") {
    await applyProvisionDeleteApproval(item);
    await logEvent("approval_approve", {
      approvalType: "provision_delete",
      targetId: item.targetId,
      target: item?.payload?.displayTarget || null,
    });
  } else if (item.type === "lifelove_delete") {
    await applyLifeloveDeleteApproval(item);
    await logEvent("approval_approve", {
      approvalType: "lifelove_delete",
      targetId: item.targetId,
      target: item?.payload?.displayTarget || null,
    });
  } else throw new Error("알 수 없는 유형");
  await deleteDoc(doc(collection(db, "approvals"), id));
  showToast("승인되었습니다.");
  await loadApprovals();
}
async function rejectOne(id) {
  const item = approvals.find((x) => x.id === id);
  await deleteDoc(doc(collection(db, "approvals"), id));
  showToast("거부 처리되었습니다.");
  if (item)
    await logEvent("approval_reject", {
      approvalType: item.type,
      targetId: item.targetId || null,
      name: item?.payload?.name,
      birth: item?.payload?.birth,
      target: item?.payload?.displayTarget || null,
      summary: item?.payload?.displaySummary || summarizeApproval(item),
    });
  await loadApprovals();
}

async function loadCustomerLogs() {
  if (!els.cLogsTbody) return;
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const qLogs = query(
    collection(db, "customerLogs"),
    where("createdAt", ">=", Timestamp.fromDate(cutoff)),
    orderBy("createdAt", "desc"),
    limit(300),
  );
  const snap = await getDocs(qLogs);
  cLogs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  renderCustomerLogs();
}
function renderCustomerLogs() {
  if (!cLogs.length) {
    renderEmptyState(
      els.cLogsTbody,
      "최근 30일 활동 로그가 없습니다.",
      "fa-history",
    );
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
      <td class="text-sm text-slate-500">${time}</td>
      <td class="font-medium text-slate-800 dark:text-slate-200">${actor}</td>
      <td><span class="badge badge-sm badge-weak-grey">${type}</span></td>
      <td class="text-sm text-slate-600">${target}</td>
      <td class="text-sm text-slate-500">${detail}</td>
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
    if (l.type === "approval_reject") return `거부: ${safe(l.approvalType)}`;
    if (l.type === "customer_add") return `직접 등록`;
    if (l.type === "customer_update")
      return `직접 수정 · ${sliceObj(l.changes)}`;
    if (l.type === "customer_delete") return `직접 삭제`;
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

async function ensureAdminSession(force = false) {
  // 1. [방어 코드] 만료 경고 모달(카운트다운)이 이미 떠 있다면?
  // -> 사용자가 '지금 갱신'을 누르길 기다려야 하므로, 중복해서 인증 모달을 띄우지 않고 중단합니다.
  if (document.getElementById("sts-countdown")) {
    throw new Error("renewal-warning-active");
  }

  if (ADMIN_STS && !force) return;
  if (__adminSessionPromise) return __adminSessionPromise;

  __adminSessionPromise = (async () => {
    const user = auth.currentUser;
    if (!user) throw new Error("no-user");

    const idToken = await user.getIdToken(true);

    // 2. 인증(Captcha) 모달 띄우기
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
    scheduleStsRenewal();
  })().finally(() => {
    __adminSessionPromise = null;
  });

  return __adminSessionPromise;
}
