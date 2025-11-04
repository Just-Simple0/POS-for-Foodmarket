/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  corePlugins: { preflight: false }, // 기존 CSS 보존
  important: true, // 유틸/컴포넌트 우선순위 ↑
  content: [
    "./*.html",
    "./**/*.html",
    "./js/**/*.js",
    "./scripts/**/*.js",
    "./components/**/*.js",
  ],
  theme: {
    extend: {
      colors: {
        /* === TDS 느낌 팔레트 === */
        primary: {
          DEFAULT: "#0064FF",
          dark: "#0050CC",
          light: "#3380FF",
        },
        /* 밝은 배경/보더용 중립 */
        neutral: {
          50: "#F9FBFD",
          100: "#EFF3F8",
          300: "#C2C7D3",
          500: "#7E88A2",
          700: "#2D3548",
        },
        /* 텍스트 전용 명시 */
        text: {
          primary: "#1A1C23",
        },
        /* 상태색 */
        success: "#30C17D",
        danger: "#FF3B30",
        warning: "#FFAA00",
      },
      borderRadius: {
        xl: "0.75rem",
        "2xl": "1rem",
      },
      boxShadow: {
        card: "0 1px 2px rgba(0,0,0,0.05), 0 4px 12px rgba(0,0,0,0.08)",
      },
      fontFamily: {
        sans: [
          "Pretendard",
          "ui-sans-serif",
          "system-ui",
          "Apple SD Gothic Neo",
          "Segoe UI",
          "Noto Sans KR",
          "sans-serif",
        ],
      },
    },
  },
  safelist: [
    "hidden",
    "bg-white",
    "text-neutral-700",
    "border-neutral-300",
    "bg-neutral-50",
  ],
  plugins: [],
};
