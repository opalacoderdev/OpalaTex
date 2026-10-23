import { useEffect, useState } from 'react';

/**
 * Wide enough for a list and a detail side by side: a tablet in either
 * orientation, a phone held sideways, a Chromebook window. Below it, screens
 * stack as on a phone.
 */
export const TWO_PANE_QUERY = '(min-width: 720px)';

export function useMediaQuery(query) {
  const read = () => Boolean(globalThis.matchMedia?.(query).matches);
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    const list = globalThis.matchMedia?.(query);
    if (!list) return undefined;
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}
