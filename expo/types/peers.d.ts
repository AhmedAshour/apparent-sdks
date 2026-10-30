// Just enough of the peer packages' types (expo-application, expo-localization and react-native-device-info are
// optional and loaded with require(), see src/index.ts) to build the SDK without installing React Native here.
// Apps typecheck against the real packages.
declare module "react-native" {
  export type AppStateStatus = "active" | "background" | "inactive" | "unknown" | "extension";
  export const AppState: { currentState: AppStateStatus; addEventListener(type: "change", fn: (s: AppStateStatus) => void): { remove(): void } };
  export const Platform: { OS: string; Version: string | number };
  export const Settings: { get(key: string): unknown };
  export const I18nManager: { isRTL: boolean; getConstants?: () => { localeIdentifier?: string | null } };
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
// The chat screen (src/chat-screen.tsx) is built against loose stand-ins; apps typecheck it against the real packages.
declare module "react-native" {
  export const View: any, Text: any, TextInput: any, Image: any, Pressable: any, FlatList: any, ActivityIndicator: any, KeyboardAvoidingView: any;
  export type FlatList<T> = { scrollToOffset(o: { offset: number; animated?: boolean }): void; __item?: T };
  export const StyleSheet: { create<T>(s: T): T; hairlineWidth: number };
  export const Linking: { openURL(url: string): Promise<unknown> };
  export function useColorScheme(): "light" | "dark" | null | undefined;
}
declare module "react" {
  export function useState<T>(v: T | (() => T)): [T, (v: T | ((p: T) => T)) => void];
  export function useRef<T>(v: T | null): { current: T | null };
  export function useMemo<T>(fn: () => T, deps: unknown[]): T;
  export function useCallback<T>(fn: T, deps: unknown[]): T;
}
declare module "react/jsx-runtime" {
  export const jsx: any, jsxs: any, Fragment: any;
}
declare namespace JSX {
  type Element = any;
  interface IntrinsicElements { [name: string]: any }
  interface IntrinsicAttributes { key?: string | number }
}
