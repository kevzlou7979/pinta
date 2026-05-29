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
        // Night palette — neutral charcoal surfaces for dark mode.
        // Kept hue-free so the warm brand.pink-light accent reads as the
        // single point of color against deep charcoal.
        night: {
          bg: "#0F0F12",
          alt: "#15151A",
          card: "#1A1A20",
          line: "#2A2A33",
          line2: "#3A3A45",
          text: "#ECECF0",
          dim: "#A8A8B5",
          mute: "#7A7A88",
        },
      },
    },
  },
  plugins: [],
};
