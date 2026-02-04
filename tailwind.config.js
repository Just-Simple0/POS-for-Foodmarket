/** @type {import('tailwindcss').Config} */

// 1. TDS Full Color Palette Definition
const tdsColors = {
  // Primary (Blue)
  blue: {
    DEFAULT: "#3182F6",
    50: "#E8F3FF",
    100: "#D4E6FF",
    200: "#A9CCFF",
    300: "#7EB2FF",
    400: "#559AF9",
    500: "#3182F6", // Primary
    600: "#1B64DA", // Hover
    700: "#163761",
    800: "#112946",
    900: "#0C1C31",
  },
  // Danger / Error (Red)
  red: {
    DEFAULT: "#F04452",
    50: "#FEE2E2",
    100: "#FFDCDC",
    200: "#FFB0B0",
    300: "#FF8080",
    400: "#F25D69",
    500: "#F04452", // Error
    600: "#E42939",
    700: "#C21E2C",
    800: "#9E1622",
    900: "#7A1019",
  },
  // Typography / Backgrounds (Grey)
  grey: {
    DEFAULT: "#8B95A1",
    50: "#F9FAFB",
    100: "#F2F4F6", // Background
    200: "#E5E8EB",
    300: "#D1D6DB",
    400: "#B0B8C1",
    500: "#8B95A1", // Slate replacement
    600: "#6B7684",
    700: "#4E5968", // Text Weak
    800: "#333D4B", // Text Normal
    900: "#191F28", // Text Strong
  },
  // Sub Colors (Warning, Success, Etc.)
  orange: {
    DEFAULT: "#FF8D00",
    50: "#FFF8ED",
    100: "#FFF2D9",
    200: "#FFE0B2",
    300: "#FFCC80",
    400: "#FFB74D",
    500: "#FF8D00",
    600: "#F57C00",
    700: "#E65100",
    800: "#BF360C",
    900: "#3E2723",
  },
  yellow: {
    DEFAULT: "#FFD300",
    50: "#FFFCF0",
    100: "#FFF9DB",
    200: "#FFF0B2",
    300: "#FFE680",
    400: "#FFDC4D",
    500: "#FFD300",
    600: "#FFB300",
    700: "#FF8F00",
    800: "#FF6F00",
    900: "#F57F17",
  },
  green: {
    DEFAULT: "#00C73C",
    50: "#E6FBF0",
    100: "#C1F6D8",
    200: "#8CECB6",
    300: "#55DE93",
    400: "#24CD76",
    500: "#00C73C",
    600: "#00A632",
    700: "#008528",
    800: "#00641E",
    900: "#004214",
  },
  teal: {
    DEFAULT: "#00D6C1",
    50: "#E0FDF9",
    100: "#B3F8EF",
    200: "#80F0E2",
    300: "#4DE6D4",
    400: "#26DBC5",
    500: "#00D6C1",
    600: "#00B2A0",
    700: "#008F80",
    800: "#006B60",
    900: "#004740",
  },
  purple: {
    DEFAULT: "#946BE3",
    50: "#F4F0FC",
    100: "#E4D9F8",
    200: "#D0BFF2",
    300: "#BCA3EB",
    400: "#A887E6",
    500: "#946BE3",
    600: "#7A4ED9",
    700: "#6034CC",
    800: "#491FA8",
    900: "#341285",
  },
};

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
          "Pretendard Variable",
          "Pretendard",
          "-apple-system",
          "BlinkMacSystemFont",
          "system-ui",
          "Roboto",
          "Helvetica Neue",
          "Segoe UI",
          "Apple SD Gothic Neo",
          "Noto Sans KR",
          "Malgun Gothic",
          "Apple Color Emoji",
          "Segoe UI Emoji",
          "Segoe UI Symbol",
          "sans-serif",
        ],
      },
      // 2. Override & Extend Colors
      colors: {
        // [Override] 기존 Tailwind 컬러를 TDS 컬러로 덮어쓰기
        slate: tdsColors.grey,
        gray: tdsColors.grey,
        zinc: tdsColors.grey,
        neutral: tdsColors.grey,
        blue: tdsColors.blue,
        red: tdsColors.red,
        orange: tdsColors.orange,
        yellow: tdsColors.yellow,
        green: tdsColors.green,
        teal: tdsColors.teal,
        purple: tdsColors.purple,

        // [Semantic] 의미론적 이름 정의 (추천)
        primary: {
          DEFAULT: tdsColors.blue.DEFAULT,
          weak: tdsColors.blue[50],
          ...tdsColors.blue,
        },
        danger: {
          DEFAULT: tdsColors.red.DEFAULT,
          weak: tdsColors.red[50],
          ...tdsColors.red,
        },
        success: {
          DEFAULT: tdsColors.green.DEFAULT,
          weak: tdsColors.green[50],
          ...tdsColors.green,
        },
        warning: {
          DEFAULT: tdsColors.orange.DEFAULT,
          weak: tdsColors.orange[50],
          ...tdsColors.orange,
        },

        // [Backgrounds] 배경 전용 토큰
        background: "#FFFFFF",
        surface: tdsColors.grey[100], // #F2F4F6

        // [Legacy] 기존 toss 객체 호환
        toss: {
          blue: tdsColors.blue.DEFAULT,
          "blue-dark": tdsColors.blue[600],
          "blue-light": "rgba(100, 168, 255, 0.15)",
          grey: tdsColors.grey[700],
          "grey-light": tdsColors.grey[100],
          red: tdsColors.red.DEFAULT,
          "red-dark": tdsColors.red[600],
          "red-light": "rgba(251, 136, 144, 0.15)",
        },
      },
      // ... (boxShadow, borderRadius 등은 그대로 유지)
      boxShadow: {
        soft: "0 10px 30px rgba(0, 0, 0, 0.04)",
        lifted: "0 16px 40px rgba(0, 0, 0, 0.08)",
        floating: "0 20px 60px rgba(0, 0, 0, 0.12)",
        elevated: "0 10px 24px rgba(0, 0, 0, 0.08)",
        input: "0 0 0 1px rgba(0, 0, 0, 0.04)",
      },
      borderRadius: {
        xl: "12px",
        "2xl": "18px",
        "3xl": "24px",
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
    // 자동 변환될 클래스들
    "text-slate-700",
    "border-slate-300",
    "bg-red-50",
    "text-red-700",
    "border-red-300",
    "bg-blue-600",
    "text-green-600",
    "bg-orange-50",
  ],
  plugins: [],
};
