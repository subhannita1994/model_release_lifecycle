import type { Config } from 'tailwindcss';

// All theme values live in src/theme.css as CSS custom properties (the single
// source of truth). Tailwind only maps to those vars, so the brand can be
// swapped by editing theme.css without touching components.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: 'var(--paper)',
        'paper-2': 'var(--paper-2)',
        card: 'var(--card)',
        'card-2': 'var(--card-2)',
        line: 'var(--line)',
        'line-hi': 'var(--line-hi)',
        ink: 'var(--ink)',
        'ink-2': 'var(--ink-2)',
        'ink-3': 'var(--ink-3)',
        'ink-hover': 'var(--ink-hover)',
        accent: 'var(--accent)',
        'accent-2': 'var(--accent-2)',
        'accent-wash': 'var(--accent-wash)',
        'accent-line': 'var(--accent-line)',
        plum: 'var(--plum)',
        'plum-wash': 'var(--plum-wash)',
        amber: 'var(--amber)',
        'amber-wash': 'var(--amber-wash)',
        moss: 'var(--moss)',
        'moss-wash': 'var(--moss-wash)',
        info: 'var(--info)',
        'info-wash': 'var(--info-wash)',
        pass: 'var(--pass)',
        'pass-wash': 'var(--pass-wash)',
        fail: 'var(--fail)',
        'fail-wash': 'var(--fail-wash)',
        warn: 'var(--warn)',
        'warn-wash': 'var(--warn-wash)',
      },
      borderRadius: {
        xl: 'var(--r-xl)',
        lg: 'var(--r-lg)',
        DEFAULT: 'var(--r)',
        pill: '999px',
      },
      boxShadow: {
        lift: 'var(--lift)',
        'lift-hi': 'var(--lift-hi)',
        'lift-float': 'var(--lift-float)',
        drawer: 'var(--lift-drawer)',
      },
      fontFamily: {
        display: 'var(--f-display)',
        body: 'var(--f-body)',
        data: 'var(--f-data)',
      },
      transitionTimingFunction: {
        soft: 'cubic-bezier(.2,.7,.3,1)',
      },
    },
  },
  plugins: [],
} satisfies Config;
