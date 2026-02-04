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
import { showToast, setBusy } from "./components/comp.js"; // comp.js의 setBusy 활용

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

const AUTH_SERVER =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://localhost:3000"
    : "https://foodmarket-pos.onrender.com";

/* UI 매핑 (새로운 HTML ID 및 구조 반영) */
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
  sClose: document.getElementById("signup-close-icon"),
  pwStrength: document.getElementById("pw-strength"),
  sPwToggle: document.getElementById("signup-pw-toggle"),
  sPw2Toggle: document.getElementById("signup-pw2-toggle"),
  sEmailErr: document.getElementById("signup-email-error"),
  sPwErr: document.getElementById("signup-pw-error"),
  sPw2Err: document.getElementById("signup-pw2-error"),

  resetOpen: document.getElementById("reset-password-btn"),
  resetModal: document.getElementById("reset-modal"),
  rEmail: document.getElementById("reset-email"),
  rError: document.getElementById("reset-error"),
  rSubmit: document.getElementById("reset-submit-btn"),
  rCancel: document.getElementById("reset-cancel-btn"),
  rClose: document.getElementById("reset-close-icon"),
  rEmailErr: document.getElementById("reset-email-error"),

  socialModal: document.getElementById("social-keep-modal"),
  socialNo: document.getElementById("social-keep-no"),
  socialYes: document.getElementById("social-keep-yes"),
};

/* ===== [추가] Turnstile 테마 동기화 (OS 무시, 사이트 테마 적용) ===== */
function applyTurnstileTheme() {
  // 1. html 태그에 'dark' 클래스가 있는지 확인
  const isDark = document.documentElement.classList.contains("dark");
  const theme = isDark ? "dark" : "light";

  // 2. 모든 Turnstile 위젯에 강제로 적용
  ["ts-login", "ts-signup", "ts-reset"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.setAttribute("data-theme", theme);
    }
  });
}

// 스크립트 로드 시 즉시 실행
applyTurnstileTheme();

/* ===== Helper Functions ===== */
function showError(msg = "") {
  if (ui.error) {
    ui.error.innerHTML = msg; // textContent -> innerHTML 로 변경

    // 스타일 보정 (줄바꿈 시 간격 확보)
    ui.error.style.display = msg ? "block" : "none";
    ui.error.style.lineHeight = "1.5";
    ui.error.style.whiteSpace = "normal";
  }
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

/* ===== Firestore User Doc ===== */
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
      { merge: true },
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
      showError("계정 승인 대기 중입니다. 관리자에게 문의하세요.");
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
  try {
    const r = await fetch(`${AUTH_SERVER}/api/captcha/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    if (r.ok) {
      const data = await r.json();
      if (data?.success) return true;
    }
  } catch {}
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

/* ===== [수정] Backoff System (UX 개선됨) ===== */
const FAIL_KEY = "login_fail_info";
const now = () => Date.now();

const getFailInfo = () => {
  try {
    return JSON.parse(localStorage.getItem(FAIL_KEY) || "{}");
  } catch {
    return {};
  }
};

// 정보 저장 (마지막 실패 시간 lastFail 추가)
const setFailInfo = (o) => localStorage.setItem(FAIL_KEY, JSON.stringify(o));

const recordFail = () => {
  const info = getFailInfo();
  const currentTime = now();

  // [Smart Reset] 마지막 실패로부터 1분이 지났으면 카운트 리셋
  // (띄엄띄엄 실수한 사용자에게 패널티를 주지 않기 위함)
  if (info.lastFail && currentTime - info.lastFail > 60_000) {
    info.count = 0;
  }

  const n = (info.count || 0) + 1;

  // [UX 개선] 5회까지는 대기 시간 없음 (프리패스)
  if (n <= 5) {
    // 카운트는 증가시키되, until(차단 시간)은 설정하지 않음
    setFailInfo({ count: n, until: 0, lastFail: currentTime });
    return;
  }

  // [패널티 시작] 6회째부터 대기 시간 적용 (10초 -> 20초 -> 40초 ... 최대 5분)
  const base = 10_000; // 10초
  // n=6: 10s, n=7: 20s, n=8: 40s ...
  const delay = Math.min(5 * 60_000, base * Math.pow(2, n - 6));

  setFailInfo({ count: n, until: currentTime + delay, lastFail: currentTime });
};

const resetFail = () => setFailInfo({ count: 0, until: 0, lastFail: 0 });

const backoffMs = () => {
  const i = getFailInfo();
  if (!i.until) return 0;
  return Math.max(0, i.until - now());
};

// (formatMs는 기존과 동일하지만 편의상 포함)
const formatMs = (ms) => {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60),
    r = s % 60;
  return `${m}분${r ? " " + r + "초" : ""}`;
};

/* ===== OAuth Hash Handling ===== */
/* 전역 변수로 토큰 임시 저장 */
let pendingSocialToken = null;

/* [수정] OAuth Hash Handling */
(function handleHash() {
  if (!location.hash) return;
  const p = new URLSearchParams(location.hash.slice(1));
  const token = p.get("token");
  const error = p.get("error");
  const provider = p.get("provider") || "소셜";

  history.replaceState(null, "", location.pathname + location.search);

  if (token) {
    // [변경] 즉시 로그인하지 않고, 토큰 저장 후 모달 띄움
    pendingSocialToken = token;
    toggleModal(ui.socialModal, true);
  } else if (error) {
    // 에러 처리는 기존과 동일
    let msg = `로그인 오류: ${error}`;
    if (error === "not_linked") {
      const providerName =
        provider === "google"
          ? "구글"
          : provider === "kakao"
            ? "카카오"
            : "소셜";
      msg = `아직 연동되지 않은 <b>${providerName}</b> 계정입니다.<br>먼저 <b>[계정 만들기]</b>로 가입 후,<br>마이페이지에서 연동해 주세요.`;
    } else if (error === "missing_idtoken" || error === "invalid_idtoken") {
      msg = "인증 정보를 제대로 불러오지 못했습니다.";
    } else if (error === "cancelled") {
      msg = "로그인이 취소되었습니다.";
    }
    showError(msg);
  }
})();

/* [추가] 소셜 로그인 마무리 함수 */
async function finalizeSocialLogin(isKeep) {
  if (!pendingSocialToken) return;

  // 모달 닫기
  toggleModal(ui.socialModal, false);

  // 선택에 따른 Persistence 설정
  const persistence = isKeep
    ? browserLocalPersistence
    : browserSessionPersistence;

  // 버튼 로딩 대신 전체 화면 로딩 등을 보여주거나, 이미 빠르므로 생략 가능
  // 여기선 흐름만 처리
  try {
    await setPersistence(auth, persistence);
    await signInWithCustomToken(auth, pendingSocialToken);
    // 이후 onAuthStateChanged가 리다이렉트 처리
  } catch (e) {
    console.error(e);
    showError("소셜 로그인 처리에 실패했습니다.");
    pendingSocialToken = null;
  }
}

// 모달 버튼 이벤트 연결
ui.socialYes?.addEventListener("click", () => finalizeSocialLogin(true)); // 유지하기
ui.socialNo?.addEventListener("click", () => finalizeSocialLogin(false)); // 아니요 (유지 안 함)

/* ===== Auth State Listener ===== */
onAuthStateChanged(auth, async (user) => {
  if (SIGNUP_IN_PROGRESS) return;
  if (!user) return;
  if (FEATURES?.ENFORCE_EMAIL_VERIFIED && !user.emailVerified) return;
  if (!(await gateAfterLogin(user))) return;

  showError("");
  // 로그인 로그 기록
  try {
    const providers = (user.providerData || []).map((p) => p.providerId);
    let ip = null;
    try {
      const r = await fetch("https://api.ipify.org?format=json");
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
getRedirectResult(auth).catch((e) => console.warn(e));

/* ===== UI Logic: CapsLock & Password Toggle ===== */
function mountCapsHint(input, hintEl) {
  if (!input || !hintEl) return;

  // 상태 체크 헬퍼 함수
  const checkCaps = (e) => {
    // getModifierState가 지원되는 이벤트인지 확인 (KeyboardEvent, MouseEvent 모두 지원)
    if (e.getModifierState && e.getModifierState("CapsLock")) {
      hintEl.classList.remove("hidden");
    } else {
      hintEl.classList.add("hidden");
    }
  };

  // 1. 키보드를 누를 때 & 뗄 때 (Caps Lock 키 자체를 누르는 경우 포함)
  input.addEventListener("keydown", checkCaps);
  input.addEventListener("keyup", checkCaps);

  // 2. 마우스로 입력창을 클릭해서 포커스할 때 (이미 켜져있는 상태 감지)
  input.addEventListener("mousedown", checkCaps);

  // 3. 포커스를 잃으면 무조건 숨김
  input.addEventListener("blur", () => hintEl.classList.add("hidden"));
}
function mountPwToggle(inputId, btnId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input || !btn) return;

  btn.addEventListener("click", () => {
    const isPw = input.type === "password";
    input.type = isPw ? "text" : "password";
    // 아이콘 교체 (TDS 스타일: regular eye vs eye-slash)
    btn.innerHTML = isPw
      ? '<i class="fas fa-eye text-lg text-slate-800 dark:text-white"></i>'
      : '<i class="fas fa-eye-slash text-lg"></i>';
  });
}

mountCapsHint(ui.password, document.getElementById("caps-hint-login"));
mountCapsHint(ui.sPw, document.getElementById("caps-hint-signup1"));
mountCapsHint(ui.sPw2, document.getElementById("caps-hint-signup2"));

mountPwToggle("password", "login-pw-toggle");
mountPwToggle("signup-password", "signup-pw-toggle");
mountPwToggle("signup-password2", "signup-pw2-toggle");

/* ===== Login Submit ===== */
ui.emailForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  const btn = ui.emailLoginBtn;
  setBusy(btn, true); // comp.js setBusy 사용
  saveLastPath();

  const wait = FEATURES.RATE_LIMIT_CLIENT_BACKOFF ? backoffMs() : 0;
  if (wait > 0) {
    setBusy(btn, false);
    return showError(
      `로그인 시도가 많습니다. ${formatMs(wait)} 후 다시 시도하세요.`,
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
        showError("로봇 방지 검증 실패하였습니다.");
        resetCaptcha("login");
        return;
      }
    }

    const cred = await signInWithEmailAndPassword(
      auth,
      ui.email.value.trim(),
      ui.password.value,
    );

    // Auth Listener가 나머지 처리...
    resetFail();
  } catch (err) {
    console.error(err);
    if (FEATURES.RATE_LIMIT_CLIENT_BACKOFF) recordFail();
    if (FEATURES.CAPTCHA_LOGIN) resetCaptcha("login");
    const code = err.code || "";
    if (code === "auth/invalid-credential" || code === "auth/wrong-password") {
      showError("이메일 또는 비밀번호가 올바르지 않습니다.");
    } else if (code === "captcha-timeout") {
      showError("로봇 방지 검증 시간이 초과되었습니다.<br>다시 시도해 주세요.");
    } else {
      showError("로그인 오류가 발생했습니다.");
    }
  } finally {
    setBusy(btn, false);
  }
});

/* ===== Helper: 에러 토글 함수 ===== */
function toggleError(inputEl, errorTextEl, isError) {
  const group = inputEl.closest(".field-group");
  if (group) {
    if (isError) {
      group.classList.add("is-error");
      if (errorTextEl) errorTextEl.classList.remove("hidden");
    } else {
      group.classList.remove("is-error");
      if (errorTextEl) errorTextEl.classList.add("hidden");
    }
  }
}

/* ===== Signup Logic: Validation & State ===== */

function validateEmailFormat(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

// [수정] 비밀번호 강도 및 유효성 검사 (8자 이상, 영문+숫자 필수)
function analyzePassword(pw) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[A-Za-z]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++; // 특수문자 가산점

  // 필수 조건: 8자 이상 AND 영문 존재 AND 숫자 존재
  const isValid = pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw);

  const levels = ["취약", "약함", "보통", "안전", "매우 안전"];
  const colors = [
    "text-danger",
    "text-danger",
    "text-warning",
    "text-blue-500",
    "text-green-500",
  ];

  // 점수에 따른 라벨 (최대 4점)
  // isValid가 false라면 강도가 높아도 가입 불가 처리해야 함
  return {
    score: s,
    isValid: isValid,
    label: levels[s] || "-",
    color: colors[s] || "text-slate-400",
  };
}

// 전체 폼 상태 업데이트 (버튼 활성화용)
function updateSignupSubmitState() {
  const email = ui.sEmail.value.trim();
  const pw = ui.sPw.value;
  const pw2 = ui.sPw2.value;
  const agree = ui.sAgree.checked;

  const okEmail = validateEmailFormat(email);
  const { isValid: okPw } = analyzePassword(pw);
  const okMatch = pw && pw === pw2;

  // 버튼 활성화는 모든 조건이 만족될 때만
  ui.sSubmit.disabled = !(okEmail && okPw && okMatch && agree);
}

/* [1] 이메일: 입력 중엔 에러 끄기, 포커스 잃으면(Blur) 검사 */
ui.sEmail.addEventListener("input", () => {
  toggleError(ui.sEmail, ui.sEmailErr, false); // 타이핑 중엔 에러 숨김
  updateSignupSubmitState();
});
ui.sEmail.addEventListener("blur", () => {
  const val = ui.sEmail.value.trim();
  if (val && !validateEmailFormat(val)) {
    toggleError(ui.sEmail, ui.sEmailErr, true);
  }
});

/* [2] 비밀번호: 입력 시 강도 표시 및 실시간 에러 해제 */
ui.sPw.addEventListener("input", () => {
  const val = ui.sPw.value;

  // 강도 표시 로직
  if (val) {
    const { label, color, isValid } = analyzePassword(val);
    ui.pwStrength.textContent = `강도: ${label}`;
    ui.pwStrength.className = `text-xs font-bold ml-1 mt-1 ${color}`;
    ui.pwStrength.classList.remove("hidden");

    // 유효하지 않으면 에러 표시 (선택 사항: 입력 중에도 띄울지, blur에 띄울지)
    // 여기서는 입력 중에 조건 만족 여부를 체크하여 에러를 끕니다.
    // (조건 만족 시 에러 해제, 만족 못하면? -> 사용자가 입력 중이므로 일단 둠, Blur때 체크해도 됨)
    if (isValid) toggleError(ui.sPw, ui.sPwErr, false);
  } else {
    ui.pwStrength.classList.add("hidden");
    toggleError(ui.sPw, ui.sPwErr, false);
  }

  updateSignupSubmitState();
});

// 비밀번호 Blur 시 조건 불만족이면 에러 표시
ui.sPw.addEventListener("blur", () => {
  const val = ui.sPw.value;
  if (val) {
    const { isValid } = analyzePassword(val);
    if (!isValid) toggleError(ui.sPw, ui.sPwErr, true);
  }
});

/* [3] 비밀번호 확인: 일치 여부 */
ui.sPw2.addEventListener("input", () => {
  const pw = ui.sPw.value;
  const pw2 = ui.sPw2.value;
  // 입력 중 일치하면 에러 해제
  if (pw === pw2) toggleError(ui.sPw2, ui.sPw2Err, false);
  updateSignupSubmitState();
});
ui.sPw2.addEventListener("blur", () => {
  const pw = ui.sPw.value;
  const pw2 = ui.sPw2.value;
  if (pw2 && pw !== pw2) {
    toggleError(ui.sPw2, ui.sPw2Err, true);
  }
});

/* [4] 약관 동의 */
ui.sAgree.addEventListener("change", updateSignupSubmitState);

/* Modal Actions */
function toggleModal(el, show) {
  if (show) {
    el.classList.remove("hidden");
    document.body.classList.add("overflow-hidden");
  } else {
    el.classList.add("hidden");
    document.body.classList.remove("overflow-hidden");
  }
}

// Open Signup
ui.emailSignupBtn?.addEventListener("click", () => {
  showSignupError("");

  // 값 초기화
  ui.sEmail.value = (ui.email?.value || "").trim();
  ui.sName.value = "";
  ui.sPw.value = "";
  ui.sPw2.value = "";
  ui.sAgree.checked = false;

  // [수정] 상태(에러, 강도 텍스트) 완벽 초기화
  toggleError(ui.sEmail, ui.sEmailErr, false);
  toggleError(ui.sPw, ui.sPwErr, false);
  toggleError(ui.sPw2, ui.sPw2Err, false);

  ui.pwStrength.textContent = "강도: -";
  ui.pwStrength.classList.add("hidden"); // 강도 숨김
  ui.sSubmit.disabled = true; // 버튼 비활성화

  toggleModal(ui.modal, true);
});

// Close Signup
[ui.sCancel, ui.sClose].forEach((btn) =>
  btn?.addEventListener("click", () => toggleModal(ui.modal, false)),
);

// Signup Submit
ui.sSubmit?.addEventListener("click", async () => {
  showSignupError("");
  const email = ui.sEmail.value.trim();
  const name = ui.sName.value.trim();
  const pw = ui.sPw.value;

  setBusy(ui.sSubmit, true);
  SIGNUP_IN_PROGRESS = true;

  // Show blocking overlay inside modal
  const blocking = ui.modal.querySelector(".blocking");
  if (blocking) blocking.classList.remove("hidden");
  if (blocking) blocking.style.display = "flex";

  try {
    if (FEATURES.CAPTCHA_SIGNUP) {
      const token = await getCaptchaToken("signup");
      if (!(await verifyCaptcha(token))) throw new Error("captcha-fail");
    }

    const cred = await createUserWithEmailAndPassword(auth, email, pw);
    if (name) await updateProfile(cred.user, { displayName: name });
    await ensureUserDoc(cred.user);
    try {
      await sendEmailVerification(cred.user);
    } catch {}

    toggleModal(ui.modal, false);
    try {
      await signOut(auth);
    } catch {}
    showToast("가입 완료! 인증 메일을 확인해주세요.");
  } catch (err) {
    console.error(err);

    if (FEATURES.CAPTCHA_SIGNUP) resetCaptcha("signup");
    let msg = "가입 실패";
    if (err.message === "captcha-fail") msg = "로봇 검증애 실패하였습니다.";
    else if (err.code === "auth/email-already-in-use")
      msg = "이미 사용 중인 이메일입니다.";
    else if (err.code === "auth/weak-password")
      msg = "비밀번호가 너무 약합니다.";
    showSignupError(msg);
  } finally {
    if (blocking) blocking.classList.add("hidden");
    if (blocking) blocking.style.display = "none";
    setBusy(ui.sSubmit, false);
    SIGNUP_IN_PROGRESS = false;
  }
});

/* ===== [수정] Reset Password Logic ===== */

// 1. 모달 열기 (초기화 강화)
ui.resetOpen?.addEventListener("click", () => {
  showResetError("");

  // 값 및 에러 상태 초기화
  ui.rEmail.value = (ui.email?.value || "").trim();
  toggleError(ui.rEmail, ui.rEmailErr, false);

  toggleModal(ui.resetModal, true);
});

// 2. 닫기 버튼
[ui.rCancel, ui.rClose].forEach((btn) =>
  btn?.addEventListener("click", () => toggleModal(ui.resetModal, false)),
);

// 3. 이메일 유효성 검사 (입력 중 해제, Blur 시 검사)
ui.rEmail.addEventListener("input", () => {
  toggleError(ui.rEmail, ui.rEmailErr, false);
});
ui.rEmail.addEventListener("blur", () => {
  const val = ui.rEmail.value.trim();
  if (val && !validateEmailFormat(val)) {
    toggleError(ui.rEmail, ui.rEmailErr, true);
  }
});

// 4. 전송 (유효성 체크 추가)
ui.rSubmit?.addEventListener("click", async () => {
  showResetError("");
  const email = ui.rEmail.value.trim();

  // 유효성 1차 방어
  if (!email || !validateEmailFormat(email)) {
    toggleError(ui.rEmail, ui.rEmailErr, true);
    return showResetError("올바른 이메일을 입력해 주세요.");
  }

  setBusy(ui.rSubmit, true);

  try {
    if (FEATURES.CAPTCHA_RESET) {
      const token = await getCaptchaToken("reset");
      if (!(await verifyCaptcha(token))) throw new Error("captcha-fail");
    }

    await sendPasswordResetEmail(auth, email);
    toggleModal(ui.resetModal, false);
    showToast("재설정 메일을 발송했습니다. 메일함을 확인해 주세요.");
  } catch (err) {
    console.error(err);
    if (FEATURES.CAPTCHA_RESET) resetCaptcha("reset");

    let msg = "메일 발송 실패";
    if (err.message === "captcha-fail") msg = "로봇 검증에 실패했습니다.";
    else if (err.code === "auth/user-not-found")
      msg = "가입되지 않은 이메일입니다.";
    else if (err.code === "auth/invalid-email")
      msg = "이메일 형식이 올바르지 않습니다.";

    showResetError(msg);
  } finally {
    setBusy(ui.rSubmit, false);
  }
});

/* ===== Social Login ===== */
function goSocial(provider, btn) {
  // [UX 개선] 클릭 즉시 로딩 상태 표시 (페이지 이동 전 딜레이 동안 피드백)
  if (btn) setBusy(btn, true);

  const returnUrl = location.origin + "/index.html";

  // 실제 페이지 이동
  location.href = `${AUTH_SERVER}/auth/${provider}/start?mode=login&return=${encodeURIComponent(returnUrl)}`;
}

// 이벤트 리스너에 버튼 객체(this) 전달
ui.googleBtn?.addEventListener("click", function () {
  goSocial("google", this);
});
ui.kakaoBtn?.addEventListener("click", function () {
  goSocial("kakao", this);
});
