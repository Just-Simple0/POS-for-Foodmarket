// mypage.js — 관리자 뱃지: custom claims role === 'admin' 기준
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
import { showToast, openCaptchaModal } from "./components/comp.js";

const AUTH_SERVER =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://localhost:3000"
    : "https://foodmarket-pos.onrender.com";

const ui = {
  name: document.getElementById("user-name"),
  email: document.getElementById("user-email"),
  last: document.getElementById("user-last-login"),
  roleText: document.getElementById("user-role"),
  adminBadge: document.getElementById("admin-badge"),
  logout: document.getElementById("logout-btn"),
  // 보안/로그 기록
  btnResetPw: document.getElementById("btn-reset-password"),
  btnLogoutOthers: document.getElementById("btn-logout-others"),
  btnOpenChangeEmail: document.getElementById("btn-open-change-email"),
  btnCancelChangeEmail: document.getElementById("btn-cancel-change-email"),
  formChangeEmail: document.getElementById("form-change-email"),
  btnOpenDeleteRequest: document.getElementById("btn-open-delete-request"),
  btnCancelDeleteRequest: document.getElementById("btn-cancel-delete-request"),
  formDeleteRequest: document.getElementById("form-delete-request"),
  loginTbody: document.getElementById("login-history"),

  status: {
    google: document.getElementById("status-google"),
    kakao: document.getElementById("status-kakao"),
    naver: document.getElementById("status-naver"),
  },
  linkBtn: {
    google: document.getElementById("link-google"),
    kakao: document.getElementById("link-kakao"),
    naver: document.getElementById("link-naver"),
  },
  unlinkBtn: {
    google: document.getElementById("unlink-google"),
    kakao: document.getElementById("unlink-kakao"),
    naver: document.getElementById("unlink-naver"),
  },
};

/* ===== 모달 접근성 유틸: ESC 닫기 + 포커스 트랩 + 초기 포커스 ===== */
const modalState = {
  active: null,
  lastFocus: null,
  escHandler: null,
  tabHandler: null,
  clickHandler: null,
};
function getFocusable(container) {
  return Array.from(
    container.querySelectorAll(
      '[data-initial-focus], a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
}
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  modalState.active = modal;
  modalState.lastFocus = document.activeElement;
  const content = modal.querySelector(".modal-content") || modal;
  const focusables = getFocusable(content);
  const first =
    focusables.find((el) => el.hasAttribute("data-initial-focus")) ||
    focusables[0];
  (first || content).focus({ preventScroll: true });
  // ESC 닫기
  modalState.escHandler = (e) => {
    if (e.key === "Escape") closeModal(modalId);
  };
  // 탭 포커스 루프
  modalState.tabHandler = (e) => {
    if (e.key !== "Tab") return;
    const nodes = getFocusable(content);
    if (!nodes.length) return;
    const firstEl = nodes[0];
    const lastEl = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === firstEl) {
      lastEl.focus();
      e.preventDefault();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      firstEl.focus();
      e.preventDefault();
    }
  };
  // 오버레이 클릭 닫기 (모달 외부 클릭)
  modalState.clickHandler = (e) => {
    if (e.target === modal) closeModal(modalId);
  };
  document.addEventListener("keydown", modalState.escHandler);
  document.addEventListener("keydown", modalState.tabHandler);
  modal.addEventListener("mousedown", modalState.clickHandler);
  // 컨테이너 자체도 포커스 가능하도록
  if (!modal.hasAttribute("tabindex")) modal.setAttribute("tabindex", "-1");
}
function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  const form = modal.querySelector("form");
  if (form) form.reset();
  document.removeEventListener("keydown", modalState.escHandler || (() => {}));
  document.removeEventListener("keydown", modalState.tabHandler || (() => {}));
  modal.removeEventListener("mousedown", modalState.clickHandler || (() => {}));
  if (
    modalState.lastFocus &&
    typeof modalState.lastFocus.focus === "function"
  ) {
    modalState.lastFocus.focus();
  }
  modalState.active = null;
  modalState.lastFocus = null;
  modalState.escHandler = null;
  modalState.tabHandler = null;
  modalState.clickHandler = null;
}

/* 유틸 */
function setBusy(el, on) {
  if (!el) return;
  el.disabled = !!on;
  el.classList.toggle("is-busy", !!on);
}
function setStatus(provider, connected) {
  const el = ui.status[provider];
  if (!el) return;
  el.classList.remove("loading");
  el.textContent = connected ? "연결됨" : "미연결";
  el.classList.toggle("connected", connected);
  el.classList.toggle("disconnected", !connected);
  ui.linkBtn[provider]?.classList.toggle("hidden", connected);
  ui.unlinkBtn[provider]?.classList.toggle("hidden", !connected);
}

/* Firestore 유저 문서 */
async function readUserDoc(uid) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}
async function refreshFederations(uid) {
  const data = await readUserDoc(uid);
  const fed = data?.federations || {};
  setStatus("google", !!fed.google);
  setStatus("kakao", !!fed.kakao);
  setStatus("naver", !!fed.naver);
}

/* 권한 UI 적용: 오직 claims.role === 'admin'만 관리자 뱃지 */
function applyRoleFromClaims(claims = {}) {
  const role = (claims?.role || "").toLowerCase() || "user";
  if (ui.roleText) ui.roleText.textContent = role;
  if (ui.adminBadge)
    ui.adminBadge.style.display = role === "admin" ? "inline-block" : "none";
}

/* 연동/해지 */
async function startLink(provider) {
  const user = auth.currentUser;
  if (!user) return showToast("로그인을 먼저 해주세요.", true);
  const idToken = await user.getIdToken(true);
  const ret = location.origin + "/mypage.html";
  location.href = `${AUTH_SERVER}/auth/${provider}/start?mode=link&idToken=${encodeURIComponent(
    idToken
  )}&return=${encodeURIComponent(ret)}`;
}
async function unlink(provider) {
  const user = auth.currentUser;
  if (!user) return showToast("로그인을 먼저 해주세요.", true);
  if (!confirm(`${provider} 연동을 해지하시겠습니까?`)) return;

  try {
    setBusy(ui.unlinkBtn[provider], true);
    const idToken = await user.getIdToken(true);
    const res = await fetch(`${AUTH_SERVER}/links/${provider}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) throw new Error(await res.text().catch(() => "unlink_failed"));

    await updateDoc(doc(db, "users", user.uid), {
      [`federations.${provider}`]: deleteField(),
      updatedAt: new Date(),
    });

    await refreshFederations(user.uid);
    showToast(`${provider} 연동이 해제되었습니다.`);
  } catch (e) {
    console.error("unlink error", e);
    showToast("연동 해지에 실패했습니다.", true);
  } finally {
    setBusy(ui.unlinkBtn[provider], false);
  }
}

/* 콜백 해시 처리(세션 갱신 전용) */
(function handleHashOnLoad() {
  if (!location.hash) return;
  const p = new URLSearchParams(location.hash.slice(1));
  const token = p.get("token");
  const error = p.get("error");
  const provider = p.get("provider");

  (async () => {
    if (token) {
      try {
        await signInWithCustomToken(auth, token);
        const t = await auth.currentUser.getIdTokenResult(true);
        applyRoleFromClaims(t.claims);
        showToast(
          `${(provider || "").replace("_linked", "")} 연동이 완료되었습니다.`
        );
      } catch {
        showToast("세션 갱신에 실패했습니다.", true);
      }
    } else if (error === "not_linked") {
      showToast(
        `해당 ${provider || "소셜"} 계정은 연동되어 있지 않습니다.`,
        true
      );
    }
    history.replaceState(null, "", location.pathname + location.search);
  })();
})();

/* 초기 로딩 */
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  ui.name.textContent = user.displayName || "직원";
  ui.email.textContent = user.email || "-";
  const lastLogin = new Date(user.metadata.lastSignInTime);
  ui.last.textContent = lastLogin.toLocaleString("ko-KR");

  // 🔐 커스텀 클레임 로딩 → role === 'admin'만 뱃지 노출
  try {
    const tokenResult = await user.getIdTokenResult(true);
    applyRoleFromClaims(tokenResult.claims);
  } catch (e) {
    console.warn("getIdTokenResult failed", e);
    applyRoleFromClaims({});
  }

  await refreshFederations(user.uid);

  /* ② 비밀번호 재설정 메일 */
  if (ui.btnResetPw) {
    const hasPw = user.providerData.some((p) => p.providerId === "password");
    ui.btnResetPw.classList.toggle("hidden", !hasPw);
    ui.btnResetPw.onclick = async () => {
      ui.btnResetPw.classList.add("is-busy");
      try {
        await sendPasswordResetEmail(auth, user.email);
        showToast("비밀번호 재설정 메일을 보냈어요. 메일함을 확인해 주세요.");
      } catch (e) {
        showToast("전송 실패: " + (e?.message || e), true);
      } finally {
        ui.btnResetPw.classList.remove("is-busy");
      }
    };
  }

  /* ③ 다른 기기에서 로그아웃 */
  if (ui.btnLogoutOthers) {
    ui.btnLogoutOthers.onclick = async () => {
      ui.btnLogoutOthers.classList.add("is-busy");
      try {
        const [idToken, cfToken] = await Promise.all([
          user.getIdToken(true),
          openCaptchaModal({
            action: "revoke_tokens",
            title: "보안 확인",
            subtitle: "다른 기기에서 모두 로그아웃하려면 인증이 필요합니다.",
          }),
        ]);
        if (!cfToken)
          throw new Error("보안 검증 실패: 캡차 토큰을 받을 수 없습니다.");
        const res = await fetch(`${AUTH_SERVER}/api/auth/revokeTokens`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + idToken,
            "x-cf-turnstile-token": cfToken || "",
          },
          body: JSON.stringify({}),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.message || "요청 실패");
        showToast("다른 기기에서 모두 로그아웃됐어요.");
      } catch (e) {
        showToast("처리 실패: " + (e?.message || e), true);
      } finally {
        ui.btnLogoutOthers.classList.remove("is-busy");
      }
    };
  }

  /* ④ 이메일 변경 (모달) */
  if (ui.btnOpenChangeEmail && ui.formChangeEmail && ui.btnCancelChangeEmail) {
    const modal = document.getElementById("modal-change-email");
    const inputPw = document.getElementById("chg-current-pw");
    const inputNew = document.getElementById("chg-new-email");

    ui.btnOpenChangeEmail.onclick = () => openModal("modal-change-email");
    ui.btnCancelChangeEmail.onclick = () => closeModal("modal-change-email");

    ui.formChangeEmail.onsubmit = async (ev) => {
      ev.preventDefault();
      ui.formChangeEmail.classList.add("is-busy");
      try {
        const cf = await openCaptchaModal({
          action: "change_email",
          title: "보안 확인",
          subtitle: "이메일 변경 전에 인증이 필요합니다.",
        });
        if (!cf)
          throw new Error("보안 검증 실패: 캡차 토큰을 받을 수 없습니다.");

        const cred = EmailAuthProvider.credential(user.email, inputPw.value);
        await reauthenticateWithCredential(user, cred);
        await updateEmail(user, inputNew.value.trim());
        showToast("이메일이 변경되었어요. 다시 로그인해 주세요.");
        closeModal("modal-change-email");
      } catch (e) {
        showToast("이메일 변경 실패: " + (e?.message || e), true);
      } finally {
        ui.formChangeEmail.classList.remove("is-busy");
      }
    };
  }

  /* ⑥ 최근 로그인 기록 표시 */
  if (ui.loginTbody) {
    try {
      const qref = query(
        collection(db, "users", user.uid, "logins"),
        orderBy("at", "desc"),
        limit(5)
      );
      const snap = await getDocs(qref);
      ui.loginTbody.innerHTML = "";
      if (snap.empty) {
        ui.loginTbody.innerHTML = `<tr><td colspan="3">기록이 없습니다.</td></tr>`;
      } else {
        snap.forEach((doc) => {
          const d = doc.data();
          const date = d?.at?.toDate ? d.at.toDate() : null;
          const at = date ? date.toLocaleString("ko-KR") : "-";
          const ip = d?.ip || "-";
          const provider = Array.isArray(d?.provider)
            ? d.provider.join(",")
            : d?.provider || "-";
          const tr = document.createElement("tr");
          tr.innerHTML = `<td>${at}</td><td>${ip}</td><td>${provider}</td>`;
          ui.loginTbody.appendChild(tr);
        });
      }
    } catch (e) {
      ui.loginTbody.innerHTML = `<tr><td colspan="3">불러오기 실패</td></tr>`;
    }
  }

  /* ⑨ 계정 삭제 요청 */
  if (
    ui.btnOpenDeleteRequest &&
    ui.formDeleteRequest &&
    ui.btnCancelDeleteRequest
  ) {
    const inputReason = document.getElementById("del-reason");
    const inputConsent = document.getElementById("del-consent");

    ui.btnOpenDeleteRequest.onclick = () => openModal("modal-delete-request");
    ui.btnCancelDeleteRequest.onclick = () =>
      closeModal("modal-delete-request");

    ui.formDeleteRequest.onsubmit = async (ev) => {
      ev.preventDefault();
      if (!inputConsent.checked) return showToast("동의가 필요합니다.", true);
      ui.formDeleteRequest.classList.add("is-busy");
      try {
        const [idToken, cfToken] = await Promise.all([
          user.getIdToken(true),
          openCaptchaModal({
            action: "delete_request",
            title: "보안 확인",
            subtitle: "계정 삭제 요청 전에 인증이 필요합니다.",
          }),
        ]);
        if (!cfToken)
          throw new Error("보안 검증 실패: 캡차 토큰을 받을 수 없습니다.");
        const res = await fetch(`${AUTH_SERVER}/api/account/delete-request`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + idToken,
            "x-cf-turnstile-token": cfToken || "",
          },
          body: JSON.stringify({ reason: (inputReason.value || "").trim() }),
        });
        if (res.ok) {
          showToast("삭제 요청이 접수되었어요. 관리자가 검토 후 처리합니다.");
          closeModal("modal-delete-request");
        } else {
          // 서버 실패 → Firestore fallback
          await addDoc(collection(db, "deletionRequests"), {
            uid: user.uid,
            email: user.email,
            reason: (inputReason.value || "").trim(),
            at: serverTimestamp(),
            status: "requested",
          });
          showToast("삭제 요청이 접수되었어요. (로컬 기록)", true);
          closeModal("modal-delete-request");
        }
      } catch (e) {
        showToast("요청 실패: " + (e?.message || e), true);
      } finally {
        ui.formDeleteRequest.classList.remove("is-busy");
      }
    };
  }
});

/* ===== 역할 변경 즉시 반영: 실시간 구독 + 토큰 강제 갱신 ===== */
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  try {
    // users/{uid}.role 변동 실시간 감지
    const stop = onSnapshot(doc(db, "users", user.uid), async (snap) => {
      if (!snap.exists()) return;
      const role = String(snap.data()?.role || "user").toLowerCase();
      // 페이지(마이페이지) 역할 텍스트/배지 업데이트
      if (ui.roleText) ui.roleText.textContent = role;
      if (ui.adminBadge)
        ui.adminBadge.style.display =
          role === "admin" ? "inline-block" : "none";
      // 커스텀 클레임도 즉시 갱신 시도
      try {
        await user.getIdToken(true);
      } catch {}
    });
    // 필요 시 페이지 이탈에서 stop() 호출(생략 가능: SPA 단일 페이지)
  } catch (e) {
    console.warn("[role-watch] failed:", e);
  }
});

/* 버튼 바인딩 */
ui.logout?.addEventListener("click", async () => {
  await signOut(auth);
  window.location.href = "index.html";
});
ui.linkBtn.google?.addEventListener("click", () => startLink("google"));
ui.linkBtn.kakao?.addEventListener("click", () => startLink("kakao"));
ui.linkBtn.naver?.addEventListener("click", () => startLink("naver"));
ui.unlinkBtn.google?.addEventListener("click", () => unlink("google"));
ui.unlinkBtn.kakao?.addEventListener("click", () => unlink("kakao"));
ui.unlinkBtn.naver?.addEventListener("click", () => unlink("naver"));
