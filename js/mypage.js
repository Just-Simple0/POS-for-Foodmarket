import { auth, db } from "./components/firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
  signInWithCustomToken,
  sendPasswordResetEmail,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updateEmail,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  getDoc,
  updateDoc,
  deleteField,
  collection,
  addDoc,
  serverTimestamp,
  getDocs,
  query,
  orderBy,
  limit,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  showToast,
  openCaptchaModal,
  openConfirm,
  setBusy,
  makeSectionSkeleton,
} from "./components/comp.js";

const AUTH_SERVER =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://localhost:3000"
    : "https://foodmarket-pos.onrender.com";

const ui = {
  profile: {
    name: document.getElementById("user-name"),
    email: document.getElementById("user-email"),
    lastLogin: document.getElementById("user-last-login"),
    adminIcon: document.getElementById("admin-icon"), // 왕관 아이콘 추가
    adminText: document.getElementById("admin-badge-text"), // 텍스트 배지 추가
    logout: document.getElementById("logout-btn"),
  },
  status: {
    google: document.getElementById("status-google"),
    kakao: document.getElementById("status-kakao"),
  },
  linkBtn: {
    google: document.getElementById("link-google"),
    kakao: document.getElementById("link-kakao"),
  },
  unlinkBtn: {
    google: document.getElementById("unlink-google"),
    kakao: document.getElementById("unlink-kakao"),
  },
  btnResetPw: document.getElementById("btn-reset-password"),
  btnLogoutOthers: document.getElementById("btn-logout-others"),
  btnOpenChangeEmail: document.getElementById("btn-open-change-email"),
  btnCancelChangeEmail: document.getElementById("btn-cancel-change-email"),
  formChangeEmail: document.getElementById("form-change-email"),
  btnOpenDeleteRequest: document.getElementById("btn-open-delete-request"),
  btnCancelDeleteRequest: document.getElementById("btn-cancel-delete-request"),
  formDeleteRequest: document.getElementById("form-delete-request"),
  loginTbody: document.getElementById("login-history"),
};

// --- Modal Helper ---
function openModal(modalId) {
  document.getElementById(modalId)?.classList.remove("hidden");
}
function closeModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) {
    el.classList.add("hidden");
    el.querySelector("form")?.reset();
  }
}

// --- Social Status Helper ---
function setStatus(provider, connected) {
  const el = ui.status[provider];
  if (!el) return;

  if (connected) {
    el.textContent = "연결됨";
    // [수정] TDS 표준 초록색 계열로 변경
    el.className = "text-xs font-bold text-emerald-600 dark:text-emerald-400";
  } else {
    el.textContent = "미연결";
    el.className = "text-xs font-medium text-slate-400";
  }

  // [기존 로직 보존] 버튼 토글
  ui.linkBtn[provider]?.classList.toggle("hidden", connected);
  ui.unlinkBtn[provider]?.classList.toggle("hidden", !connected);
}

async function refreshFederations(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  const fed = snap.exists() ? snap.data().federations || {} : {};
  setStatus("google", !!fed.google);
  setStatus("kakao", !!fed.kakao);
}

/** * [수정] 사용자 기본 정보 표시 (아바타 제외)
 */
function bindUserProfile(user) {
  ui.profile.name.textContent = user.displayName || "이름 없음";
  ui.profile.email.textContent = user.email || "-";
  ui.profile.lastLogin.textContent = new Date(
    user.metadata.lastSignInTime,
  ).toLocaleString("ko-KR");
}

/** * [수정] 관리자 권한 실시간 감시 (onSnapshot 활용)
 * DB의 role 필드 변경 시 즉시 반영됩니다.
 */
let unsubscribeRole = null;
function watchUserRole(uid) {
  if (unsubscribeRole) unsubscribeRole(); // 중복 리스너 방지
  unsubscribeRole = onSnapshot(doc(db, "users", uid), (snap) => {
    if (!snap.exists()) return;
    const isAdmin = snap.data()?.role === "admin";
    // UI 요소 실시간 토글
    ui.profile.adminIcon?.classList.toggle("hidden", !isAdmin);
    ui.profile.adminText?.classList.toggle("hidden", !isAdmin);
  });
}

// --- Core Auth Logic ---
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    if (unsubscribeRole) unsubscribeRole();
    window.location.href = "index.html";
    return;
  }

  // 1번 모듈: 기본 정보 표시 및 실시간 권한 감시 시작
  bindUserProfile(user);
  watchUserRole(user.uid);

  // 2. 기존 소셜 상태 로드 로직
  await refreshFederations(user.uid);

  // 3번 모듈: 위에서 만든 함수들 연결
  const hasPw = user.providerData.some((p) => p.providerId === "password");
  if (ui.btnResetPw) {
    ui.btnResetPw.classList.toggle("hidden", !hasPw);
    ui.btnResetPw.onclick = () => handlePasswordReset(user, ui.btnResetPw);
  }

  ui.btnLogoutOthers.onclick = () =>
    handleLogoutOthers(user, ui.btnLogoutOthers);
  ui.btnOpenChangeEmail.onclick = () => openModal("modal-change-email");
  ui.btnCancelChangeEmail.onclick = () => closeModal("modal-change-email");
  ui.formChangeEmail.onsubmit = (e) =>
    handleChangeEmail(user, ui.formChangeEmail, e);

  if (ui.btnOpenDeleteRequest) {
    ui.btnOpenDeleteRequest.onclick = () => openModal("modal-delete-request");
  }
  if (ui.btnCancelDeleteRequest) {
    ui.btnCancelDeleteRequest.onclick = () =>
      closeModal("modal-delete-request");
  }
  if (ui.formDeleteRequest) {
    ui.formDeleteRequest.onsubmit = (e) =>
      handleDeleteRequest(user, ui.formDeleteRequest, e);
  }

  /// [수정] 4번 모듈: 로그인 기록 로드 함수 호출
  loadLoginHistory(user.uid);
});

async function handlePasswordReset(user, btn) {
  setBusy(btn, true);
  try {
    await sendPasswordResetEmail(auth, user.email);
    showToast("비밀번호 재설정 메일을 보냈습니다.");
  } catch (e) {
    showToast("전송 실패", true);
  } finally {
    setBusy(btn, false);
  }
}

/**
 * [수정] 다른 기기 로그아웃 로직 (독립 함수화)
 */
async function handleLogoutOthers(user, btn) {
  const ok = await openConfirm({
    title: "기기 로그아웃",
    message: "현재 기기를 제외한 모든 곳에서 로그아웃할까요?",
    variant: "warn",
  });
  if (!ok) return;

  setBusy(btn, true);
  try {
    const idToken = await user.getIdToken(true);
    const cfToken = await openCaptchaModal({ action: "revoke_tokens" });
    if (!cfToken) return;

    const res = await fetch(`${AUTH_SERVER}/api/auth/revokeTokens`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
        "x-cf-turnstile-token": cfToken,
      },
    });
    if (res.ok) showToast("모든 기기에서 로그아웃되었습니다.");
  } catch (e) {
    showToast("처리 중 오류가 발생했습니다.", true);
  } finally {
    setBusy(btn, false);
  }
}

/**
 * [수정] 이메일 변경 로직 (독립 함수화)
 */
async function handleChangeEmail(user, form, e) {
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"]');
  const curPw = document.getElementById("chg-current-pw").value;
  const newEmail = document.getElementById("chg-new-email").value.trim();

  setBusy(btn, true);
  try {
    const cred = EmailAuthProvider.credential(user.email, curPw);
    await reauthenticateWithCredential(user, cred);
    await updateEmail(user, newEmail);
    showToast("이메일이 변경되었습니다. 다시 로그인해주세요.");
    setTimeout(() => signOut(auth), 2000);
  } catch (err) {
    showToast("변경 실패: 비밀번호를 확인해주세요.", true);
  } finally {
    setBusy(btn, false);
  }
}

async function handleDeleteRequest(user, form, e) {
  e.preventDefault();
  const btn = form.querySelector('button[type="submit"]');
  const reason = document.getElementById("del-reason")?.value || "";
  const consent = document.getElementById("del-consent")?.checked;

  if (!consent) {
    showToast("삭제 동의 체크박스에 체크해 주세요.", true);
    return;
  }

  setBusy(btn, true);
  try {
    // Firestore에 삭제 요청 기록 저장
    await addDoc(collection(db, "deletionRequests"), {
      uid: user.uid,
      email: user.email,
      reason: reason,
      requestedAt: serverTimestamp(),
      status: "pending",
    });

    showToast("삭제 요청이 전송되었습니다.");
    closeModal("modal-delete-request");
    form.reset(); // 폼 초기화
  } catch (err) {
    showToast("요청 전송에 실패했습니다.", true);
    console.error(err);
  } finally {
    setBusy(btn, false);
  }
}

/**
 * [수정] 최근 로그인 기록 로드 및 테이블 렌더링
 * @param {string} uid - 사용자 UID
 */
async function loadLoginHistory(uid) {
  const tbody = ui.loginTbody;
  if (!tbody) return;

  // 1. 스켈레톤 UI 표시
  const stopSkeleton = makeSectionSkeleton(tbody, 5);

  try {
    // 2. 데이터 가져오기(Promise)와 최소 대기 시간(500ms)을 병렬로 실행
    const fetchDataPromise = getDocs(
      query(
        collection(db, "users", uid, "logins"),
        orderBy("at", "desc"),
        limit(5),
      ),
    );

    const delayPromise = new Promise((resolve) => setTimeout(resolve, 2000)); // 0.5초 딜레이

    // 두 작업이 모두 끝날 때까지 대기
    const [snap] = await Promise.all([fetchDataPromise, delayPromise]);

    // 3. 데이터 유무에 따른 분기 처리
    if (snap.empty) {
      renderEmptyState(
        tbody,
        "로그인 기록이 없습니다.",
        "fa-clock-rotate-left",
      );
      return;
    }

    // 4. 테이블 행 생성
    tbody.innerHTML = "";
    snap.forEach((doc) => {
      const d = doc.data();
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="whitespace-nowrap font-medium text-slate-700 dark:text-slate-300">
          ${d.at?.toDate().toLocaleString("ko-KR") || "-"}
        </td>
        <td class="font-mono text-xs text-slate-500 dark:text-slate-400">${d.ip || "-"}</td>
        <td>
          <span class="badge badge-xs badge-weak-grey uppercase">${d.provider || "email"}</span>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error("Login history load failed:", e);
    tbody.innerHTML = `<tr><td colspan="3" class="text-center py-8 text-rose-500 font-medium">데이터 로드 실패</td></tr>`;
  } finally {
    if (typeof stopSkeleton === "function") stopSkeleton(); // 스켈레톤 종료
  }
}

// --- Social Link Actions ---
async function handleLink(provider) {
  const user = auth.currentUser;
  if (!user) return;

  // [추가] 클릭 즉시 로딩 상태 표시
  setBusy(ui.linkBtn[provider], true);

  const idToken = await user.getIdToken(true);
  const ret = location.origin + "/mypage.html";

  // [기존 로직 보존] 인증 서버로 이동
  location.href = `${AUTH_SERVER}/auth/${provider}/start?mode=link&idToken=${encodeURIComponent(idToken)}&return=${encodeURIComponent(ret)}`;
}

async function handleUnlink(provider) {
  // [기존 로직 보존] openConfirm 사용
  const ok = await openConfirm({
    title: "연동 해제",
    message: `${provider} 계정 연동을 해제하시겠습니까?`,
    variant: "danger",
  });
  if (!ok) return;

  const btn = ui.unlinkBtn[provider];
  setBusy(btn, true); // [추가] 로딩 시작

  try {
    const idToken = await auth.currentUser.getIdToken(true);
    // [기존 로직 보존] 백엔드 API 호출
    await fetch(`${AUTH_SERVER}/links/${provider}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${idToken}` },
    });
    // [기존 로직 보존] Firestore 필드 삭제
    await updateDoc(doc(db, "users", auth.currentUser.uid), {
      [`federations.${provider}`]: deleteField(),
    });

    await refreshFederations(auth.currentUser.uid);
    showToast(`${provider} 연동이 해제되었습니다.`);
  } catch (e) {
    showToast("해제 실패", true);
  } finally {
    setBusy(btn, false); // [추가] 로딩 종료
  }
}

// Event Listeners
ui.profile.logout.onclick = async () => {
  const ok = await openConfirm({
    title: "로그아웃",
    message: "정말 로그아웃 하시겠습니까?",
    variant: "danger",
  });

  if (ok) {
    await signOut(auth);
  }
};

["google", "kakao"].forEach((p) => {
  // [기존 함수명 handleLink, handleUnlink 그대로 사용]
  ui.linkBtn[p]?.addEventListener("click", () => handleLink(p));
  ui.unlinkBtn[p]?.addEventListener("click", () => handleUnlink(p));
});

// Role Watcher (실시간 권한 반영)
onAuthStateChanged(auth, (user) => {
  if (!user) return;
  onSnapshot(doc(db, "users", user.uid), (snap) => {
    const isAdmin = snap.data()?.role === "admin";
    ui.adminBadge?.classList.toggle("hidden", !isAdmin);
  });
});
