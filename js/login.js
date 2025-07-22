// js/login.js
import { auth } from "./firebase-config.js";
import {
  GoogleAuthProvider,
  signInWithPopup,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const provider = new GoogleAuthProvider();

document
  .getElementById("google-login-btn")
  .addEventListener("click", async () => {
    try {
      const result = await signInWithPopup(auth, provider);
      alert(`환영합니다, ${result.user.displayName}님`);
      window.location.href = "dashboard.html";
    } catch (error) {
      alert("로그인에 실패했습니다.");
      console.error(error);
    }
  });
