/** @type {import('tailwindcss').Config} */
// Mirror of frontend/tailwind.config.js so the desktop POS produces
// the same compiled CSS for shared class names.
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};
