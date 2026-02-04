import { auth } from "./components/firebase-config.js";
import {
  confirmPasswordReset,
  applyActionCode,
  checkActionCode,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { showToast, setBusy } from "./components/comp.js";

const urlParams = new URLSearchParams(window.location.search);
const mode = urlParams.get("mode"); // verifyEmail, resetPassword 등
const actionCode = urlParams.get("oobCode");
const contentEl = document.getElementById("action-content");

async function init() {
  if (!actionCode) {
    renderError("인증 코드가 올바르지 않거나 만료되었습니다.");
    return;
  }

  try {
    // 1. 코드 유효성 검사 및 사용자 정보 가져오기
    const info = await checkActionCode(auth, actionCode);

    switch (mode) {
      case "resetPassword":
        renderResetForm(info.data.email);
        break;
      case "verifyEmail":
        handleVerifyEmail();
        break;
      case "recoverEmail":
        handleRecoverEmail();
        break;
      default:
        renderError("지원하지 않는 요청 모드입니다.");
    }
  } catch (e) {
    renderError("만료되었거나 이미 사용된 링크입니다. 다시 시도해 주세요.");
  }
}

/** [UI] 에러 메시지 렌더링 - TDS 스타일 */
function renderError(msg) {
  contentEl.innerHTML = `
    <div class="text-center py-4 space-y-4">
      <div class="w-16 h-16 bg-red-50 dark:bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-2">
        <i class="fa-solid fa-circle-exclamation text-danger text-3xl"></i>
      </div>
      <div>
        <h2 class="text-xl font-bold text-slate-900 dark:text-white mb-1">인증에 실패했습니다</h2>
        <p class="text-slate-500 text-[15px] leading-relaxed">${msg}</p>
      </div>
      <button onclick="location.href='index.html'" class="btn btn-light btn-md w-full !mt-6">홈으로 가기</button>
    </div>
  `;
}

/** [UI] 비밀번호 재설정 폼 - TDS field-group 활용 */
function renderResetForm(email) {
  contentEl.innerHTML = `
    <div class="text-left space-y-6">
      <div>
        <h2 class="text-2xl font-bold text-slate-900 dark:text-white">비밀번호 재설정</h2>
        <p class="text-slate-500 text-sm mt-1"><strong>${email}</strong> 계정의 새로운 비밀번호를 입력하세요.</p>
      </div>
      
      <div class="field-group">
        <label class="field-label">새 비밀번호</label>
        <div class="field-box">
          <input type="password" id="new-password" class="field-input" placeholder="8자리 이상 입력" autofocus />
        </div>
      </div>
      
      <button id="btn-reset" class="btn btn-primary btn-lg w-full shadow-lifted">비밀번호 변경하기</button>
    </div>
  `;

  document.getElementById("btn-reset").onclick = async () => {
    const newPw = document.getElementById("new-password").value;
    const btn = document.getElementById("btn-reset");

    if (newPw.length < 8) {
      showToast("비밀번호는 최소 8자리 이상이어야 합니다.", true);
      return;
    }

    setBusy(btn, true);
    try {
      await confirmPasswordReset(auth, actionCode, newPw);
      showToast("변경이 완료되었습니다! 다시 로그인해 주세요.");
      setTimeout(() => (location.href = "index.html"), 2000);
    } catch (e) {
      showToast("비밀번호 변경 중 오류가 발생했습니다.", true);
    } finally {
      setBusy(btn, false);
    }
  };
}

/** [로직] 이메일 인증 처리 - TDS 스타일 결과 페이지 */
async function handleVerifyEmail() {
  try {
    await applyActionCode(auth, actionCode);
    contentEl.innerHTML = `
      <div class="text-center py-6 space-y-6 animate-fade-in">
        <div class="w-20 h-20 bg-green-50 dark:bg-green-500/10 rounded-full flex items-center justify-center mx-auto shadow-soft">
          <i class="fa-solid fa-circle-check text-success text-5xl"></i>
        </div>
        <div>
          <h2 class="text-2xl font-bold text-slate-900 dark:text-white mb-2">이메일 인증 완료</h2>
          <p class="text-slate-500 text-[15px] leading-relaxed">이메일 인증이 성공적으로 완료되었습니다.<br>이제 모든 기능을 이용할 수 있습니다.</p>
        </div>
        <button onclick="location.href='dashboard.html'" class="btn btn-primary btn-lg w-full">시작하기</button>
      </div>
    `;
  } catch (e) {
    renderError("이메일 인증 처리 중 오류가 발생했습니다.");
  }
}

/** [로직] 이메일 변경 복구 처리 */
async function handleRecoverEmail() {
  try {
    await applyActionCode(auth, actionCode);
    showToast("이전 이메일로 안전하게 복구되었습니다.");
    renderError(
      "보안을 위해 이메일을 이전 주소로 복구했습니다. 비밀번호를 변경하시길 권장합니다.",
    );
  } catch (e) {
    renderError("이메일 복구 요청을 처리하지 못했습니다.");
  }
}

init();
