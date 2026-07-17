import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import "./variables.css";
import "./style.css";

export default {
  extends: DefaultTheme,
  // No enhanceApp: CSS-only theme (BA-3). Keeps the build side-effect-free (INV-9).
} satisfies Theme;
