import { useEffect } from 'react';
import { useLocation } from 'react-router';

/** Reports every router location (path, search and hash) to a test. */
export function LocationProbe({ onLocation }: { onLocation: (url: string) => void }) {
  const { pathname, search, hash } = useLocation();
  useEffect(() => {
    onLocation(pathname + search + hash);
  }, [onLocation, pathname, search, hash]);
  return null;
}
