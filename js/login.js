// js/login.js
import { auth, db } from "./components/firebase-config.js";
import {
  GoogleAuthProvider,
  OAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  linkWithPopup,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* ===== 기능 플래그 ===== */
const FEATURES = {
  ROLE_ACCESS_CONTROL: true,
  REQUIRED_ROLE: "admin",
  REDIRECT_TO_LAST_PATH: true,
  MAINTENANCE_MODE: true,
  MAINTENANCE_MESSAGE: "현재 시스템 점검 중입니다. 관리자만 접속 가능합니다.",
};
/* ====================== */

const ui = {
  emailForm: document.getElementById("email-form"),
  emailLoginBtn: document.getElementById("email-login-btn"),
  emailSignupBtn: document.getElementById("email-signup-btn"),
  resetBtn: document.getElementById("reset-password-btn"),
  googleBtn: document.getElementById("google-login-btn"),
  kakaoBtn: document.getElementById("kakao-login-btn"),
  naverBtn: document.getElementById("naver-login-btn"),
  error: document.getElementById("login-error"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
};

const AUTH_SERVER = "https://foodmarket-pos.onrender.com";
const returnUrl = `${location.origin}/oauth-complete.html`;

function setLoading(el, on) {
  if (!el) return;
  el.classList.toggle("loading", on);
  el.disabled = !!on;
}
function showError(msg = "") {
  if (ui.error) ui.error.textContent = msg;
}
function saveLastPath() {
  if (FEATURES.REDIRECT_TO_LAST_PATH) {
    sessionStorage.setItem("last_path", location.pathname + location.search);
  }
}
function getPostLoginRedirect(defaultPath = "dashboard.html") {
  if (!FEATURES.REDIRECT_TO_LAST_PATH) return defaultPath;
  const p = sessionStorage.getItem("last_path");
  sessionStorage.removeItem("last_path");
  if (p && !/index\.html?$/.test(p)) return p;
  return defaultPath;
}

/* ----- 사용자 문서 생성/업데이트 & 역할 게이트 ----- */
async function ensureUserDoc(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      uid: user.uid,
      email: user.email || "",
      name: user.displayName || "",
      role: "user",
      createdAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
      providers: user.providerData.map((p) => p.providerId),
    });
  } else {
    await setDoc(
      ref,
      {
        lastLoginAt: serverTimestamp(),
        providers: user.providerData.map((p) => p.providerId),
      },
      { merge: true }
    );
  }
  return (await getDoc(ref)).data();
}
async function gateByRole(user) {
  if (!FEATURES.ROLE_ACCESS_CONTROL && !FEATURES.MAINTENANCE_MODE) return true;
  const data = await ensureUserDoc(user);
  const role = (data?.role || "user").toLowerCase();
  if (FEATURES.MAINTENANCE_MODE && role !== "admin") {
    showError(FEATURES.MAINTENANCE_MESSAGE);
    return false;
  }
  if (FEATURES.ROLE_ACCESS_CONTROL && role !== FEATURES.REQUIRED_ROLE) {
    showError(`접근 권한이 없습니다. (필요 역할: ${FEATURES.REQUIRED_ROLE})`);
    return false;
  }
  return true;
}

// Kakao
document.getElementById("kakao-login-btn")?.addEventListener("click", () => {
  location.href = `${AUTH_SERVER}/auth/kakao/start?return=${encodeURIComponent(
    returnUrl
  )}`;
});

// Naver
document.getElementById("naver-login-btn")?.addEventListener("click", () => {
  location.href = `${AUTH_SERVER}/auth/naver/start?return=${encodeURIComponent(
    returnUrl
  )}`;
});

/* ===== 리디렉트 결과 (소셜 폴백) ===== */
getRedirectResult(auth)
  .then(async (res) => {
    if (res?.user) {
      if (!(await gateByRole(res.user))) return;
      showError("");
      location.replace(getPostLoginRedirect("dashboard.html"));
    }
  })
  .catch((e) => {
    console.error("getRedirectResult", e);
    showError(`[${e.code}] ${e.message || "리디렉트 처리 중 오류"}`);
  });

/* ===== 이미 로그인된 경우 바로 이동 ===== */
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  if (!(await gateByRole(user))) return;
  showError("");
  location.replace(getPostLoginRedirect("dashboard.html"));
});

/* ===== 이메일/비밀번호 로그인 & 회원가입 & 재설정 ===== */
ui.emailForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  setLoading(ui.emailLoginBtn, true);
  saveLastPath();
  try {
    const cred = await signInWithEmailAndPassword(
      auth,
      ui.email.value.trim(),
      ui.password.value
    );
    if (!(await gateByRole(cred.user))) return;
    location.replace(getPostLoginRedirect("dashboard.html"));
  } catch (err) {
    showError("이메일 또는 비밀번호를 확인해 주세요.");
    console.error(err);
  } finally {
    setLoading(ui.emailLoginBtn, false);
  }
});

ui.emailSignupBtn?.addEventListener("click", async () => {
  showError("");
  setLoading(ui.emailSignupBtn, true);
  try {
    const cred = await createUserWithEmailAndPassword(
      auth,
      ui.email.value.trim(),
      ui.password.value
    );
    // 새 계정 생성 시 기본 문서 생성
    await ensureUserDoc(cred.user);
    showError(
      "계정이 생성되었습니다. 소셜 계정과 연동하려면 아래 버튼으로 연동해 주세요."
    );
  } catch (err) {
    console.error(err);
    showError(
      err.code === "auth/email-already-in-use"
        ? "이미 등록된 이메일입니다. 로그인하거나 비밀번호를 재설정하세요."
        : "계정 생성 중 오류가 발생했습니다."
    );
  } finally {
    setLoading(ui.emailSignupBtn, false);
  }
});

ui.resetBtn?.addEventListener("click", async () => {
  if (!ui.email.value) {
    showError("비밀번호 재설정을 위해 이메일을 입력해 주세요.");
    return;
  }
  try {
    await sendPasswordResetEmail(auth, ui.email.value.trim());
    showError("비밀번호 재설정 메일을 보냈습니다.");
  } catch (err) {
    console.error(err);
    showError("재설정 메일 발송 중 오류가 발생했습니다.");
  }
});

/* ===== 공통: 소셜 로그인 or 현재 계정에 연동(link) ===== */
async function signInOrLink(provider, buttonEl) {
  showError("");
  setLoading(buttonEl, true);
  saveLastPath();

  const watchdog = setTimeout(() => {
    if (!auth.currentUser) {
      showError(
        "로그인 진행이 지연됩니다. 팝업 차단 또는 허용 도메인 설정을 확인해 주세요."
      );
    }
  }, 6000);

  try {
    if (auth.currentUser) {
      // 이미 이메일 계정으로 로그인된 상태에서 소셜 연동
      await linkWithPopup(auth.currentUser, provider);
      await ensureUserDoc(auth.currentUser);
      showError("계정이 성공적으로 연동되었습니다.");
      return;
    }
    // 일반 로그인
    await signInWithPopup(auth, provider);
  } catch (e) {
    // 팝업 실패 시 리디렉트 폴백
    if (
      e?.code === "auth/popup-blocked" ||
      e?.code === "auth/popup-closed-by-user" ||
      e?.code === "auth/cancelled-popup-request" ||
      e?.code === "auth/unauthorized-domain" ||
      e?.code === "auth/operation-not-supported-in-this-environment"
    ) {
      try {
        await signInWithRedirect(auth, provider);
        return;
      } catch (re) {
        console.error("redirect error:", re);
        showError(`[${re.code}] ${re.message || "리디렉트 로그인 실패"}`);
      }
    } else if (
      e?.code === "auth/credential-already-in-use" ||
      e?.code === "auth/account-exists-with-different-credential"
    ) {
      showError(
        "이미 다른 계정과 연결된 자격 증명입니다. 기존 계정으로 로그인 후 연동하세요."
      );
    } else {
      console.error(e);
      showError(`[${e.code}] ${e.message || "로그인 중 오류가 발생했습니다."}`);
    }
  } finally {
    clearTimeout(watchdog);
    setLoading(buttonEl, false);
  }
}

/* ----- Google ----- */
const googleProvider = new GoogleAuthProvider();
ui.googleBtn?.addEventListener("click", () =>
  signInOrLink(googleProvider, ui.googleBtn)
);
