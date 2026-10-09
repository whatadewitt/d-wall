// Section 4 memory rules: screens get timers, listeners, the event stream and fetch
// only through ScreenContext, so the shell can release everything on unmount.
import tseslint from 'typescript-eslint';

const message = 'Screens must use the ScreenContext (ctx) for this. See docs/spec.md section 4.';
const banned = ['setInterval', 'addEventListener', 'EventSource', 'fetch'];
const globalObjects = ['window', 'globalThis', 'self'];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser },
  },
  {
    files: ['client/src/screens/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': ['error', ...banned.map((name) => ({ name, message }))],
      'no-restricted-properties': [
        'error',
        ...globalObjects.flatMap((object) => banned.map((property) => ({ object, property, message }))),
        { object: 'document', property: 'addEventListener', message },
      ],
    },
  },
);
