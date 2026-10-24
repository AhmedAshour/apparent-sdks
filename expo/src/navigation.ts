/**
 * Automatic screen tracking for React Navigation (bare React Native apps, or Expo apps without expo-router).
 * No dependency on @react-navigation: it only calls getCurrentRoute() on the container's ref.
 *
 *   import { NavigationContainer, useNavigationContainerRef } from "@react-navigation/native";
 *   import { apparentScreens } from "apparent-expo/navigation";
 *
 *   const ref = useNavigationContainerRef();
 *   <NavigationContainer ref={ref} {...apparentScreens(ref)}>…</NavigationContainer>
 *
 * Already using onReady / onStateChange? Call `track()` from yours: `const screens = apparentScreens(ref)` then
 * `onStateChange={(s) => { screens.onStateChange(); mine(s); }}`.
 */
import { Apparent } from "./index";

type Route = { name: string } | undefined;
type Navigator = { getCurrentRoute(): Route };
/** What useNavigationContainerRef() / createNavigationContainerRef() / useRef() give you. */
export type NavigationRef = Navigator | { current: Navigator | null };

function currentRoute(ref: NavigationRef): Route {
  try {
    const nav = typeof (ref as Navigator).getCurrentRoute === "function" ? (ref as Navigator) : (ref as { current: Navigator | null }).current;
    return nav?.getCurrentRoute() ?? undefined;
  } catch {
    return undefined; // not ready yet
  }
}

/** Handlers for <NavigationContainer>: each time the focused route changes, one screen_view named after the route. */
export function apparentScreens(ref: NavigationRef): { onReady(): void; onStateChange(): void; track(): void } {
  const track = () => {
    const route = currentRoute(ref);
    if (route?.name) Apparent.screen(route.name);
  };
  return { onReady: track, onStateChange: track, track };
}
