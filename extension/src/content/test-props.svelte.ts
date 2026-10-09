// Test helper: reactive props for mounting ElementEditor in repro tests
// (runes only compile inside .svelte / .svelte.ts modules).
export function reactiveProps<T extends object>(initial: T): T {
  const p = $state(initial);
  return p;
}
