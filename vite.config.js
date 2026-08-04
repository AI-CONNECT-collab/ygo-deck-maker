import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // 相対パスにしておくことで GitHub Pages / Netlify / Vercel / ローカルどれでも動く
  base: "./",
});
