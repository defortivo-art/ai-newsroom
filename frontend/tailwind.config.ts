import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        serif: ['"Noto Serif KR"', '"Nanum Myeongjo"', "Batang", "serif"],
        sans: ['"Pretendard"', '"Noto Sans KR"', '"Malgun Gothic"', "sans-serif"],
      },
      colors: {
        ink: "#111111",
        paper: "#faf8f3",
        brand: "#8b1a1a",
      },
    },
  },
  plugins: [],
};

export default config;
