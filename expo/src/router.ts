/**
 * Automatic screen tracking for expo-router apps. Call once in the root layout:
 *
 *   import { useApparentScreens } from "apparent-expo/router";
 *   export default function RootLayout() { useApparentScreens(); … }
 */
import { useEffect } from "react";
import { usePathname, useSegments } from "expo-router";
import { Apparent } from "./index";

/** Route segments to a stable screen name: ["(tabs)", "practice", "[topic]"] → "practice/[topic]". */
export function screenName(segments: readonly string[]): string {
  const parts = segments.filter((s) => s && !(s.startsWith("(") && s.endsWith(")")));
  return parts.length ? parts.join("/") : "home";
}

export function useApparentScreens(): void {
  const segments = useSegments() as unknown as string[];
  const pathname = usePathname();
  const name = screenName(segments);
  useEffect(() => {
    // The concrete path only when it adds something ("/practice/recht" for "practice/[topic]").
    Apparent.screen(name, pathname && pathname !== `/${name}` && pathname !== "/" ? { path: pathname } : undefined);
  }, [name, pathname]);
}
