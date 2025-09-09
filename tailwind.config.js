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
        brand: {
          50: "#EFF6FF",
          100: "#DBEAFE",
          300: "#93C5FD",
          600: "#2563EB",
          700: "#1D4ED8",
        },
      },
    },
  },
  safelist: [
    "hidden",
    "bg-brand-50",
    "border-brand-300",
    "text-brand-700",
    "bg-white",
    "text-slate-700",
    "border-slate-300",
    "bg-red-50",
    "text-red-700",
    "border-red-300",
  ],
  plugins: [],
};
