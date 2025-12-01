/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  corePlugins: { preflight: false },
  important: true,
  content: [
    "./*.html",
    "./**/*.html",
    "./js/**/*.js",
    "./scripts/**/*.js",
    "./components/**/*.js",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Pretendard Variable",
          "Pretendard",
          "ui-sans-serif",
          "system-ui",
          "Apple SD Gothic Neo",
          "Segoe UI",
          "Noto Sans KR",
          "sans-serif",
        ],
      },
      colors: {
        primary: {
          DEFAULT: "#3182F6",
          weak: "#E8F3FF",
          50: "#E8F2FF",
          100: "#D4E6FF",
          200: "#A9CCFF",
          300: "#7EB2FF",
          400: "#559AF9",
          500: "#3182F6",
          600: "#2A70D1",
          700: "#245DAA",
          800: "#1E4B88",
          900: "#163761",
        },
        neutral: {
          dark: "#333D4B",
          weak: "#F2F4F6",
        },
        danger: {
          DEFAULT: "#EF4444",
          weak: "#FEE2E2",
        },
        common: {
          white: "#FFFFFF",
        },
        surface: "#F2F4F6",
      },
      boxShadow: {
        soft: "0 10px 30px rgba(15, 23, 42, 0.12)",
        lifted: "0 16px 40px rgba(15, 23, 42, 0.14)",
        floating: "0 20px 60px rgba(15, 23, 42, 0.18)",
        elevated: "0 10px 24px rgba(0, 0, 0, 0.08)",
        input: "0 6px 20px rgba(15, 23, 42, 0.06)",
      },
      borderRadius: {
        xl: "12px",
        "2xl": "18px",
      },
    },
  },
  safelist: [
    "hidden",
    "bg-primary",
    "bg-primary-50",
    "border-primary",
    "text-primary",
    "bg-white",
    "text-slate-700",
    "border-slate-300",
    "bg-red-50",
    "text-red-700",
    "border-red-300",
  ],
  plugins: [],
};
