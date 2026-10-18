// The palette the clinic dashboard was designed around: a teal brand, slate ink and
// white surfaces. These were previously declared in a script tag inside the page and
// handed to the browser version of the framework at runtime. That meant every doctor
// downloaded the framework, it compiled the styles in the browser on every visit, and
// the page flashed unstyled while it did. Compiling here instead means the stylesheet
// is ready before the first paint.
module.exports = {
  content: ['./src/dashboard.html'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#F0FDFA', 100: '#CCFBF1', 200: '#99F6E4', 300: '#5EEAD4',
          400: '#2DD4BF', 500: '#14B8A6', 600: '#0D9488', 700: '#0F766E',
          800: '#115E59', 900: '#134E4A', 950: '#042F2E'
        },
        ink: { DEFAULT: '#1E293B', soft: '#64748B', faint: '#94A3B8' }
      },
      fontFamily: { sans: ['"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'] },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        lift: '0 10px 30px -12px rgb(15 23 42 / 0.25)'
      },
      borderRadius: { xl: '0.875rem', '2xl': '1.125rem' }
    }
  },
  plugins: []
};