/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{html,svelte,ts,js}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Poppins",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      colors: {
        ink: {
          50: "#f8fafc",
          100: "#f1f5f9",
          200: "#e2e8f0",
          300: "#cbd5e1",
          400: "#94a3b8",
          500: "#64748b",
          600: "#475569",
          700: "#334155",
          800: "#1e293b",
          900: "#0f172a",
        },
        // Pinta brand — warm sunset swatch palette.
        brand: {
          cream: "#FFF1E0",
          yellow: "#FFD24D",
          amber: "#FFB84D",
          orange: "#FF8855",
          pink: "#FF3D6E",
          "pink-light": "#FF5A85",
          magenta: "#C72D7D",
          ink: "#1A1A1A",
        },
        // Night palette — indigo/violet surfaces for dark mode.
        // Mirrors the docs site so the brand reads the same on either.
        night: {
          bg: "#0E0A18",
          alt: "#161024",
          card: "#1A1430",
          line: "#2A2240",
          line2: "#3A3158",
          text: "#ECE8F7",
          dim: "#A8A0C4",
          mute: "#7A7299",
        },
      },
    },
  },
  plugins: [],
};
