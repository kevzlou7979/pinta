/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{html,svelte,ts,js}"],
  theme: {
    extend: {
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
          magenta: "#C72D7D",
          ink: "#1A1A1A",
        },
      },
    },
  },
  plugins: [],
};
