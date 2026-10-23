// Vite serves these absolute runtime module paths in browser tests; they are
// resolved by the dev server rather than TypeScript.
declare module "/src/*";
