// A fake expo-notifications: the tap that launched the app (__notifications.last) and taps while it runs (__tap).
const listeners = new Set();
export const __notifications = { last: null };
export const getLastNotificationResponseAsync = async () => __notifications.last;
export function addNotificationResponseReceivedListener(fn) {
  listeners.add(fn);
  return { remove: () => listeners.delete(fn) };
}
export function __tap(response) {
  for (const fn of [...listeners]) fn(response);
}
