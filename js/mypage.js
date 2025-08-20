// mypage.js — 관리자 뱃지: custom claims role === 'admin' 기준
import { auth, db } from "./components/firebase-config.js";
import {
  onAuthStateChanged,
  signOut,
  signInWithCustomToken,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  doc,
  getDoc,
  updateDoc,
  deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { showToast } from "./components/comp.js";

/* 토스트 컨테이너 보장 */
if (!document.getElementById("toast")) {
  const el = document.createElement("div");
  el.id = "toast";
  document.body.appendChild(el);
}

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
