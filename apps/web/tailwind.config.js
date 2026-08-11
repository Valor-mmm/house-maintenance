/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        bg: "var(--color-bg)",
        surface: "var(--color-surface)",
        border: "var(--color-border)",
        ink: "var(--color-text)",
        muted: "var(--color-text-muted)",
        accent: {
          DEFAULT: "var(--color-accent)",
          strong: "var(--color-accent-strong)",
        },
        good: "var(--color-good)",
        warn: "var(--color-warn)",
        danger: "var(--color-danger)",
      },
      fontFamily: {
        display: ["Fraunces", "ui-serif", "serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "SF Mono", "monospace"],
      },
    },
  },
  plugins: [],
};
