import { useSyncExternalStore } from 'react';

export type Route =
  | { page: 'home' }
  | { page: 'stage'; id: string }
  | { page: 'mastery' };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  const stage = /^\/stage\/([\w-]+)$/.exec(path);
  if (stage) return { page: 'stage', id: stage[1] };
  if (path === '/mastery') return { page: 'mastery' };
  return { page: 'home' };
}

export function href(route: Route): string {
  switch (route.page) {
    case 'home': return '#/';
    case 'stage': return `#/stage/${route.id}`;
    case 'mastery': return '#/mastery';
  }
}

function subscribe(listener: () => void) {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}
