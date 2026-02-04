import { auth, db } from "./components/firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  getRedirectResult,
  onAuthStateChanged,
  updateProfile,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  signOut,
  sendEmailVerification,
  signInWithCustomToken,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  collection,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { showToast } from "./components/comp.js";

let SIGNUP_IN_PROGRESS = false;

/* ===== 기능 플래그 ===== */
const FEATURES = {
  REDIRECT_TO_LAST_PATH: true,
  RATE_LIMIT_CLIENT_BACKOFF: true,
  ENFORCE_EMAIL_VERIFIED: true,
  ROLE_APPROVAL_REQUIRED: true,

  CAPTCHA_LOGIN: true,
  CAPTCHA_SIGNUP: true,
  CAPTCHA_RESET: true,
};

// 배포/로컬 브릿지 서버
const AUTH_SERVER =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://localhost:3000"
    : "https://foodmarket-pos.onrender.com";

const ui = {
  emailForm: document.getElementById("email-form"),
  emailLoginBtn: document.getElementById("email-login-btn"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  remember: document.getElementById("remember-me"),
  error: document.getElementById("login-error"),
  pwToggle: document.getElementById("login-pw-toggle"),

  googleBtn: document.getElementById("google-login-btn"),
  kakaoBtn: document.getElementById("kakao-login-btn"),
  naverBtn: document.getElementById("naver-login-btn"),

  emailSignupBtn: document.getElementById("email-signup-btn"),
  modal: document.getElementById("signup-modal"),
  sName: document.getElementById("signup-name"),
  sEmail: document.getElementById("signup-email"),
  sPw: document.getElementById("signup-password"),
  sPw2: document.getElementById("signup-password2"),
  sAgree: document.getElementById("signup-agree"),
  sError: document.getElementById("signup-error"),
  sSubmit: document.getElementById("signup-submit-btn"),
  sCancel: document.getElementById("signup-cancel-btn"),
  pwStrength: document.getElementById("pw-strength"),
  sPwToggle: document.getElementById("signup-pw-toggle"),
  sPw2Toggle: document.getElementById("signup-pw2-toggle"),

  resetOpen: document.getElementById("reset-password-btn"),
  resetModal: document.getElementById("reset-modal"),
  rEmail: document.getElementById("reset-email"),
  rError: document.getElementById("reset-error"),
  rSubmit: document.getElementById("reset-submit-btn"),
  rCancel: document.getElementById("reset-cancel-btn"),
};

if (!document.getElementById("toast")) {
  const el = document.createElement("div");
  el.id = "toast";
  document.body.appendChild(el);
}

function setBtnLoading(el, on) {
  if (!el) return;
  el.classList.toggle("loading", on);
  el.disabled = !!on;
}
function showError(msg = "") {
  if (ui.error) ui.error.textContent = msg;
}
function showSignupError(msg = "") {
  if (ui.sError) ui.sError.textContent = msg;
}
function showResetError(msg = "") {
  if (ui.rError) ui.rError.textContent = msg;
}

function saveLastPath() {
  if (FEATURES.REDIRECT_TO_LAST_PATH)
    sessionStorage.setItem("last_path", location.pathname + location.search);
}
function getPostLoginRedirect(defaultPath = "dashboard.html") {
  if (!FEATURES.REDIRECT_TO_LAST_PATH) return defaultPath;
  const p = sessionStorage.getItem("last_path");
  sessionStorage.removeItem("last_path");
  if (p && !/index\.html?$/.test(p)) return p;
  return defaultPath;
}

/* ===== Firestore user doc ===== */
async function ensureUserDoc(user) {
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);
  const base = {
    uid: user.uid,
    email: user.email || "",
    name: user.displayName || "",
    providers: user.providerData.map((p) => p.providerId),
  };
  if (!snap.exists()) {
    await setDoc(ref, {
      ...base,
      role: "pending",
      createdAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
    });
  } else {
    await setDoc(
      ref,
      { lastLoginAt: serverTimestamp(), providers: base.providers },
      { merge: true }
    );
  }
  return (await getDoc(ref)).data();
}

async function gateAfterLogin(user, preloadedDoc) {
  if (FEATURES.ENFORCE_EMAIL_VERIFIED && !user.emailVerified) {
    try {
      await sendEmailVerification(user);
    } catch {}
    showError("이메일 인증 후 로그인 가능합니다. 메일함을 확인해 주세요.");
    await signOut(auth);
    return false;
  }
  if (FEATURES.ROLE_APPROVAL_REQUIRED) {
    const data = preloadedDoc || (await ensureUserDoc(user));
    const role = (data?.role || "pending").toLowerCase();
    if (!["admin", "manager", "user"].includes(role)) {
      showError(
        "계정이 생성되었습니다. 관리자가 권한을 부여하면 로그인할 수 있습니다."
      );
      await signOut(auth);
      return false;
    }
  }
  return true;
}

/* ===== Turnstile helpers ===== */
async function getCaptchaToken(which = "login", timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = window._tsTokens?.[which];
    if (t) return t;
    if (window.turnstile) {
      const idEl =
        which === "login"
          ? document.getElementById("ts-login")
          : which === "signup"
          ? document.getElementById("ts-signup")
          : which === "reset"
          ? document.getElementById("ts-reset")
          : null;
      if (idEl) {
        const viaApi = window.turnstile.getResponse(idEl);
        if (viaApi) return viaApi;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("captcha-timeout");
}
async function verifyCaptcha(token) {
  if (!token) return false;
  for (const p of ["/captcha/verify", "/api/captcha/verify"]) {
    try {
      const r = await fetch(`${AUTH_SERVER}${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      });
      if (!r.ok) continue;
      const data = await r.json().catch(() => ({}));
      if (data?.success) return true;
    } catch {}
  }
  return false;
}
function resetCaptcha(which = "login") {
  try {
    if (window._tsTokens) window._tsTokens[which] = null;
    const idEl =
      which === "login"
        ? document.getElementById("ts-login")
        : which === "signup"
        ? document.getElementById("ts-signup")
        : which === "reset"
        ? document.getElementById("ts-reset")
        : null;
    if (window.turnstile && idEl) window.turnstile.reset(idEl);
  } catch {}
}

/* ===== Backoff ===== */
const FAIL_KEY = "login_fail_info";
const now = () => Date.now();
const getFailInfo = () => {
  try {
    return JSON.parse(localStorage.getItem(FAIL_KEY) || "{}");
  } catch {
    return {};
  }
};
const setFailInfo = (o) => localStorage.setItem(FAIL_KEY, JSON.stringify(o));
const recordFail = () => {
  const info = getFailInfo();
  const n = (info.count || 0) + 1;
  const base = 10_000;
  const delay = Math.min(5 * 60_000, base * Math.pow(2, Math.max(0, n - 3)));
  setFailInfo({ count: n, until: now() + delay });
};
const resetFail = () => setFailInfo({ count: 0, until: 0 });
const backoffMs = () => {
  const i = getFailInfo();
  if (!i.until) return 0;
  return Math.max(0, i.until - now());
};
const formatMs = (ms) => {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60),
    r = s % 60;
  return `${m}분${r ? " " + r + "초" : ""}`;
};

/* ===== OAuth hash handling (token or error) ===== */
(function handleHash() {
  if (!location.hash) return;
  const p = new URLSearchParams(location.hash.slice(1));
  const token = p.get("token");
  const error = p.get("error");
  const provider = p.get("provider");
  // clear hash early
  history.replaceState(null, "", location.pathname + location.search);

  if (token) {
    signInWithCustomToken(auth, token).catch((e) => {
      console.error("custom token signIn failed", e);
      showToast("소셜 로그인 처리 중 오류가 발생했습니다.", true);
    });
  } else if (error) {
    if (error === "not_linked") {
      showToast(
        `해당 ${
          provider || "소셜"
        } 계정은 아직 연동되지 않았습니다. 먼저 이메일 계정을 만들고 로그인한 뒤, 계정 연동에서 연결해 주세요.`,
        true
      );
    } else if (error === "missing_idtoken" || error === "invalid_idtoken") {
      showToast("연동을 완료하려면 다시 시도해 주세요.", true);
    } else {
      showToast(`소셜 로그인 오류: ${error}`, true);
    }
  }
})();

/* ===== Redirect on auth ===== */
onAuthStateChanged(auth, async (user) => {
  if (SIGNUP_IN_PROGRESS) return;
  if (!user) return;
  if (FEATURES?.ENFORCE_EMAIL_VERIFIED && !user.emailVerified) return;
  if (!(await gateAfterLogin(user /*, preloadedDoc */))) return;
  showError("");
  // ⑥ 로그인 이력 저장 (최근 5개는 mypage에서 조회)
  try {
    const providers = (user.providerData || []).map((p) => p.providerId);
    let ip = null;
    try {
      const r = await fetch("/api/utils/ip");
      if (r.ok) {
        const j = await r.json();
        ip = j?.ip || null;
      }
    } catch {}
    await addDoc(collection(db, "users", user.uid, "logins"), {
      at: serverTimestamp(),
      ip,
      provider: providers,
    });
  } catch {}
  location.replace(getPostLoginRedirect("dashboard.html"));
});
getRedirectResult(auth).catch((e) =>
  console.warn("getRedirectResult", e?.code || e)
);

/* ===== Caps lock & toggle ===== */
function mountCapsHint(input, hintEl) {
  if (!input || !hintEl) return;
  input.addEventListener("keydown", (e) => {
    if (e.getModifierState && e.getModifierState("CapsLock"))
      hintEl.classList.remove("hidden");
    else hintEl.classList.add("hidden");
  });
  input.addEventListener("blur", () => hintEl.classList.add("hidden"));
}
function mountPwToggle(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input || !btn) return;
  const update = (show) => {
    input.type = show ? "text" : "password";
    btn.setAttribute("aria-pressed", String(show));
    btn.setAttribute("aria-label", show ? "비밀번호 숨기기" : "비밀번호 표시");
    btn.title = show ? "비밀번호 숨기기" : "비밀번호 표시";
  };
  btn.addEventListener("click", () => update(input.type !== "text"));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && input.type === "text") update(false);
  });
}
mountCapsHint(
  document.getElementById("password"),
  document.getElementById("caps-hint-login")
);
mountCapsHint(
  document.getElementById("signup-password"),
  document.getElementById("caps-hint-signup1")
);
mountCapsHint(
  document.getElementById("signup-password2"),
  document.getElementById("caps-hint-signup2")
);
mountPwToggle("password", "login-pw-toggle");
mountPwToggle("signup-password", "signup-pw-toggle");
mountPwToggle("signup-password2", "signup-pw2-toggle");

/* ===== Signup input validation ===== */
function validateEmailFormat(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
function pwStrengthLabel(pw) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return ["매우 약함", "약함", "보통", "강함", "매우 강함"][s] || "-";
}
function updateSignupState() {
  const email = ui.sEmail.value.trim();
  const pw = ui.sPw.value,
    pw2 = ui.sPw2.value,
    agree = ui.sAgree.checked;
  const okEmail = validateEmailFormat(email);
  const okPw = pw.length >= 6;
  const okMatch = pw && pw === pw2;

  ui.sEmail.classList.toggle("input-valid", okEmail);
  ui.sEmail.classList.toggle("input-invalid", email && !okEmail);
  ui.sPw.classList.toggle("input-valid", okPw);
  ui.sPw.classList.toggle("input-invalid", pw && !okPw);
  ui.sPw2.classList.toggle("input-valid", okMatch);
  ui.sPw2.classList.toggle("input-invalid", pw2 && !okMatch);

  ui.sSubmit.disabled = !(okEmail && okPw && okMatch && agree);
}
["input", "change", "blur"].forEach((ev) => {
  ui.sEmail?.addEventListener(ev, updateSignupState);
  ui.sPw?.addEventListener(ev, updateSignupState);
  ui.sPw2?.addEventListener(ev, updateSignupState);
  ui.sAgree?.addEventListener(ev, updateSignupState);
});
updateSignupState();

/* ===== Modal open/close ===== */
function openModal(m) {
  m.classList.remove("hidden");
  m.setAttribute("aria-hidden", "false");
  document.body.classList.add("is-modal-open");
}
function closeModal(m) {
  m.classList.add("hidden");
  m.setAttribute("aria-hidden", "true");
  document.body.classList.remove("is-modal-open");
}
ui.emailSignupBtn?.addEventListener("click", () => {
  showSignupError("");
  ui.pwStrength.textContent = "강도: -";
  ui.sEmail.value = (ui.email?.value || "").trim();
  ui.sName.value = "";
  ui.sPw.value = "";
  ui.sPw2.value = "";
  ui.sAgree.checked = false;
  openModal(ui.modal);
});
ui.sCancel?.addEventListener("click", () => closeModal(ui.modal));

function setBtnBusy(btn, busy = true) {
  if (!btn) return;
  btn.classList.toggle("button-busy", busy);
  btn.disabled = !!busy;
}

function showBlocking(modalEl, text = "처리 중...") {
  if (!modalEl) return;
  const host = modalEl.querySelector(".modal-content") || modalEl;
  let ov = host.querySelector(".blocking");
  if (!ov) {
    ov = document.createElement("div");
    ov.className = "blocking";
    ov.innerHTML = `<div class="blocking-inner"><div class="spinner-lg"></div><span class="msg"></span></div>`;
    host.appendChild(ov);
  }
  ov.querySelector(".msg").textContent = text;
  ov.style.display = "flex";
}

function hideBlocking(modalEl) {
  if (!modalEl) return;
  const host = modalEl.querySelector(".modal-content") || modalEl;
  const ov = host.querySelector(".blocking");
  if (ov) ov.style.display = "none";
}

/* ===== Email login ===== */
ui.emailForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  setBtnLoading(ui.emailLoginBtn, true);
  saveLastPath();

  const wait = FEATURES.RATE_LIMIT_CLIENT_BACKOFF ? backoffMs() : 0;
  if (wait > 0) {
    setBtnLoading(ui.emailLoginBtn, false);
    return showError(
      `로그인 시도가 많습니다. ${formatMs(wait)} 후 다시 시도해 주세요.`
    );
  }

  try {
    const persistence = ui.remember?.checked
      ? browserLocalPersistence
      : browserSessionPersistence;
    await setPersistence(auth, persistence);

    if (FEATURES.CAPTCHA_LOGIN) {
      const token = await getCaptchaToken("login");
      const ok = await verifyCaptcha(token);
      if (!ok) {
        showError("로봇 방지 검증에 실패했습니다.");
        resetCaptcha("login");
        return;
      }
    }

    const cred = await signInWithEmailAndPassword(
      auth,
      ui.email.value.trim(),
      ui.password.value
    );

    if (FEATURES?.ENFORCE_EMAIL_VERIFIED && !cred.user.emailVerified) {
      await signOut(auth);
      showToast(
        "이메일 인증 후 로그인할 수 있습니다. 메일함을 확인해 주세요.",
        true
      );
      return;
    }

    let userDoc = null;
    try {
      userDoc = await ensureUserDoc(cred.user);
    } catch (e) {
      console.error("[ensureUserDoc] permission error:", e);
      showToast(
        "프로필 초기화 권한 오류가 발생했습니다. 관리자에게 문의해 주세요.",
        true
      );
    }

    resetFail();
    if (!(await gateAfterLogin(cred.user, userDoc))) return;
    location.replace(getPostLoginRedirect("dashboard.html"));
  } catch (err) {
    console.error(err);
    if (FEATURES.RATE_LIMIT_CLIENT_BACKOFF) recordFail();
    const code = err?.code || err?.message || "";
    if (
      code === "auth/invalid-credential" ||
      code === "auth/wrong-password" ||
      code === "auth/user-not-found"
    ) {
      showError("이메일 또는 비밀번호를 확인해 주세요.");
    } else if (code === "captcha-timeout") {
      showError("로봇 방지 검증 시간이 초과되었습니다. 다시 시도해 주세요.");
    } else {
      showError("로그인 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    }
  } finally {
    setBtnLoading(ui.emailLoginBtn, false);
  }
});

/* ===== Signup ===== */
ui.sPw?.addEventListener(
  "input",
  () => (ui.pwStrength.textContent = `강도: ${pwStrengthLabel(ui.sPw.value)}`)
);

ui.sSubmit?.addEventListener("click", async () => {
  showSignupError("");

  const email = ui.sEmail.value.trim(),
    name = ui.sName.value.trim(),
    pw = ui.sPw.value,
    pw2 = ui.sPw2.value;

  if (!email) return showSignupError("이메일을 입력해 주세요.");
  if (pw.length < 6)
    return showSignupError("비밀번호는 6자 이상이어야 합니다.");
  if (pw !== pw2) return showSignupError("비밀번호가 일치하지 않습니다.");
  if (!ui.sAgree.checked) return showSignupError("약관에 동의해 주세요.");

  setBtnLoading(ui.sSubmit, true); // 기존 로딩 상태 유지
  setBtnBusy(ui.sSubmit, true); // 버튼 중앙 스피너
  SIGNUP_IN_PROGRESS = true; // 자동 리다이렉트 무시
  // 모달 내 입력요소 잠금 + 오버레이 표시
  const modalInputs = ui.modal?.querySelectorAll(
    "input,button,select,textarea"
  );
  modalInputs?.forEach((el) => (el.disabled = true));
  showBlocking(ui.modal, "계정을 생성하는 중...");

  try {
    if (FEATURES.CAPTCHA_SIGNUP) {
      const token = await getCaptchaToken("signup");
      const ok = await verifyCaptcha(token);
      if (!ok) {
        throw new Error("captcha-verify-failed");
      }
    }

    const cred = await createUserWithEmailAndPassword(auth, email, pw);

    if (name) {
      try {
        await updateProfile(cred.user, { displayName: name });
      } catch {}
    }
    await ensureUserDoc(cred.user);
    try {
      await sendEmailVerification(cred.user);
    } catch {}

    closeModal(ui.modal); // ✅ 먼저 모달 닫기
    try {
      await signOut(auth);
    } catch {} // 자동 로그인 즉시 종료
    showToast("가입이 완료되었습니다. 이메일 인증 후 로그인 가능합니다.");
  } catch (err) {
    console.error("signup error:", err);
    if (err?.message === "captcha-verify-failed") {
      showSignupError("로봇 방지 검증에 실패했습니다.");
    } else {
      showSignupError(
        err.code === "auth/email-already-in-use"
          ? "이미 등록된 이메일입니다."
          : err.code === "auth/invalid-email"
          ? "이메일 형식을 확인해 주세요."
          : err.code === "auth/weak-password"
          ? "비밀번호는 6자 이상이어야 합니다."
          : err.code === "auth/operation-not-allowed"
          ? "이메일/비밀번호 로그인이 비활성화되어 있습니다(콘솔에서 활성화 필요)."
          : "계정 생성 중 오류가 발생했습니다."
      );
    }
    showToast("계정 생성 실패", true);
  } finally {
    hideBlocking(ui.modal);
    modalInputs?.forEach((el) => (el.disabled = false));
    setBtnBusy(ui.sSubmit, false);
    setBtnLoading(ui.sSubmit, false);
    SIGNUP_IN_PROGRESS = false;
  }
});

/* ===== Reset password ===== */
ui.resetOpen?.addEventListener("click", () => {
  showResetError("");
  ui.rEmail.value = (ui.email?.value || "").trim();
  openModal(ui.resetModal);
});
ui.rCancel?.addEventListener("click", () => closeModal(ui.resetModal));
ui.rSubmit?.addEventListener("click", async () => {
  showResetError("");
  setBtnLoading(ui.rSubmit, true);
  try {
    if (FEATURES.CAPTCHA_RESET) {
      const token = await getCaptchaToken("reset");
      const ok = await verifyCaptcha(token);
      if (!ok) {
        showResetError("로봇 방지 검증에 실패했습니다.");
        resetCaptcha("reset");
        return;
      }
    }
    await sendPasswordResetEmail(auth, ui.rEmail.value.trim());
    closeModal(ui.resetModal);
    showToast("비밀번호 재설정 메일을 보냈습니다. 메일함을 확인해 주세요.");
  } catch (err) {
    console.error("reset error:", err);
    showResetError("재설정 메일을 보낼 수 없습니다. 이메일을 확인해 주세요.");
  } finally {
    setBtnLoading(ui.rSubmit, false);
  }
});

/* ===== Social (login-mode only; linking is separate when logged-in) ===== */
ui.googleBtn?.addEventListener("click", () => {
  const returnUrl = location.origin + "/index.html";
  location.href = `${AUTH_SERVER}/auth/google/start?mode=login&return=${encodeURIComponent(
    returnUrl
  )}`;
});

// Kakao / Naver 은 "연동된 사용자만 로그인 허용"
function startProviderLogin(provider) {
  const returnUrl = location.origin + "/index.html"; // 토큰/에러를 index로 돌려받음
  location.href = `${AUTH_SERVER}/auth/${provider}/start?mode=login&return=${encodeURIComponent(
    returnUrl
  )}`;
}
ui.kakaoBtn?.addEventListener("click", () => startProviderLogin("kakao"));
ui.naverBtn?.addEventListener("click", () => startProviderLogin("naver"));
