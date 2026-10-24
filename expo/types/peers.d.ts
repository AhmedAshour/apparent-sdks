// Just enough of the peer packages' types (expo-application, expo-localization and react-native-device-info are
// optional and loaded with require(), see src/index.ts) to build the SDK without installing React Native here.
// Apps typecheck against the real packages.
declare module "react-native" {
  export type AppStateStatus = "active" | "background" | "inactive" | "unknown" | "extension";
  export const AppState: { currentState: AppStateStatus; addEventListener(type: "change", fn: (s: AppStateStatus) => void): { remove(): void } };
  export const Platform: { OS: string; Version: string | number };
  export const Settings: { get(key: string): unknown };
  export const I18nManager: { getConstants?: () => { localeIdentifier?: string | null } };
}
declare module "@react-native-async-storage/async-storage" {
  const AsyncStorage: { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void> };
  export default AsyncStorage;
}
declare module "expo-router" {
  export function useSegments(): string[];
  export function usePathname(): string;
}
declare module "react" {
  export function useEffect(fn: () => void | (() => void), deps?: unknown[]): void;
}
