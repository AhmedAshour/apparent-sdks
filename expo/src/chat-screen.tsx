/**
 * The ready-made in-app chat (Apparent.chat): one look in every app, with the app's own colour, font and roundness.
 * No native code and no extra packages; put it on a screen of its own.
 *
 *   import { ApparentChatScreen } from "apparent-expo/chat-screen";
 *   <ApparentChatScreen theme={{ accent: "#0F7B5F", font: "Inter" }} onClose={() => router.back()} bottomInset={insets.bottom} />
 *
 * Photos: pass `pickImage` (e.g. expo-image-picker with `base64: true`) and a photo button shows.
 * A badge: `useChatUnread()` gives the number of answers not seen yet (0 when the person never wrote).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator, FlatList, I18nManager, Image, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text,
  TextInput, View, useColorScheme,
} from "react-native";
import { Apparent } from "./index";
import type { ChatMessage } from "./chat";
import { CHAT_WORDS, chatColors, chatRadius, chatRows, splitLinks, type ChatRow, type ChatTheme, type ChatWords, type ShownMessage } from "./chat-view";

export { CHAT_WORDS, type ChatTheme, type ChatWords } from "./chat-view";

export type PickedImage = { base64: string; uri?: string };

export type ApparentChatScreenProps = {
  theme?: ChatTheme;
  /** Your own words (another language, another title). Anything left out stays English. */
  words?: Partial<ChatWords>;
  /** Shows a close button in the header. Leave out when your navigation draws its own header (and pass header={false}). */
  onClose?: () => void;
  /** Draw the title bar (default true). */
  header?: boolean;
  /** Opens the photo picker; resolve null when the person cancels. Without it there's no photo button. */
  pickImage?: () => Promise<PickedImage | null>;
  /** Space under the box for the home indicator (react-native-safe-area-context's insets.bottom). */
  bottomInset?: number;
  /** Space above the header for the status bar, when the screen isn't inside a SafeAreaView. */
  topInset?: number;
  /** Pushed up with the keyboard by this much (a navigation header above the screen). */
  keyboardOffset?: number;
  /** For day labels and times; default the phone's. */
  locale?: string;
  /** Right-to-left text (Arabic, Hebrew…); default the app's layout direction. */
  rtl?: boolean;
};

let localId = 0;

export function ApparentChatScreen(props: ApparentChatScreenProps) {
  const { theme = {}, onClose, header = true, pickImage, bottomInset = 0, topInset = 0, keyboardOffset = 0, locale } = props;
  const words = { ...CHAT_WORDS, ...props.words };
  const phoneDark = useColorScheme() === "dark";
  const c = chatColors(theme, phoneDark);
  const r = chatRadius(theme);
  const font = theme.font ? { fontFamily: theme.font } : null;
  const bold = theme.fontBold ? { fontFamily: theme.fontBold } : { ...font, fontWeight: "600" as const };
  const rtl = props.rtl ?? I18nManager.isRTL;
  // React Native swaps left and right in an RTL layout, so the physical side is asked for the other way round there.
  const align = rtl !== I18nManager.isRTL ? "right" : "left";

  const [server, setServer] = useState<ChatMessage[] | null>(null);
  const [local, setLocal] = useState<ShownMessage[]>([]);
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState<PickedImage | null>(null);
  const list = useRef<FlatList<ChatRow>>(null);

  useEffect(() => {
    const off = Apparent.chat.subscribe((m) => setServer(m));
    // Nothing to load when the person never wrote: the subscription never calls back then.
    const t = setTimeout(() => setServer((s) => s ?? []), 2500);
    return () => { off(); clearTimeout(t); };
  }, []);

  // Answers on screen are read.
  const lastTeam = server?.filter((m) => m.from === "team").at(-1)?.id;
  useEffect(() => { if (lastTeam) Apparent.chat.markRead(); }, [lastTeam]);

  const messages = useMemo(() => {
    const known = new Set((server ?? []).map((m) => m.id));
    return [...(server ?? []), ...local.filter((m) => !known.has(m.id))].sort((a, b) => a.ts - b.ts);
  }, [server, local]);
  // Inverted list: the newest row sits at the bottom and stays there as messages come in.
  const rows = useMemo(() => chatRows(messages, words, locale).reverse(), [messages, words.today, words.yesterday, locale]);

  const deliver = useCallback(async (m: ShownMessage, image?: PickedImage | null) => {
    setLocal((l) => [...l.filter((x) => x.id !== m.id), { ...m, state: "sending" }]);
    try {
      const saved = await Apparent.chat.send(m.text, image ? { base64: image.base64 } : undefined);
      setLocal((l) => l.filter((x) => x.id !== m.id).concat({ ...saved, localImage: m.localImage }));
    } catch {
      setLocal((l) => l.map((x) => (x.id === m.id ? { ...x, state: "failed" } : x)));
    }
  }, []);

  const images = useRef(new Map<string, PickedImage>()) as { current: Map<string, PickedImage> };
  const send = () => {
    const body = text.trim();
    if (!body && !photo) return;
    const m: ShownMessage = { id: `local-${++localId}`, ts: Date.now(), from: "user", text: body, image: null, localImage: photo?.uri ?? null };
    if (photo) images.current.set(m.id, photo);
    setText("");
    setPhoto(null);
    void deliver(m, photo);
    list.current?.scrollToOffset({ offset: 0, animated: true });
  };
  const retry = (m: ShownMessage) => void deliver(m, images.current.get(m.id));

  const addPhoto = async () => {
    if (!pickImage) return;
    try { const p = await pickImage(); if (p?.base64) setPhoto(p); } catch { /* the picker said no */ }
  };

  const bubble = (row: Extract<ChatRow, { kind: "message" }>) => {
    const m = row.message;
    const mine = m.from === "user";
    const small = Math.min(6, r);
    // On the sender's side the bottom corner is small (a tail), and the top one too inside a group.
    const side = mine ? "End" : "Start";
    const corners = { [`borderTop${side}Radius`]: row.first ? r : small, [`borderBottom${side}Radius`]: small };
    const image = m.image ?? m.localImage ?? null;
    return (
      <View style={{ alignItems: mine ? "flex-end" : "flex-start", marginTop: row.first ? 10 : 2 }}>
        <Pressable
          disabled={m.state !== "failed"}
          onPress={() => retry(m)}
          accessibilityRole={m.state === "failed" ? "button" : undefined}
          accessibilityLabel={m.state === "failed" ? `${m.text} ${words.failed}` : undefined}
          style={[s.bubble, { borderRadius: r, backgroundColor: mine ? c.accent : c.team, opacity: m.state === "sending" ? 0.7 : 1 }, corners]}
        >
          {image ? <Image source={{ uri: image }} style={[s.image, { borderRadius: Math.max(0, r - 6) }]} resizeMode="cover" accessibilityIgnoresInvertColors /> : null}
          {m.text ? (
            <Text selectable style={[s.text, font, { color: mine ? c.onAccent : c.onTeam, textAlign: align }]}>
              {splitLinks(m.text).map((p, i) => p.url
                ? <Text key={i} style={{ color: mine ? c.linkOnAccent : c.link, textDecorationLine: "underline" }} onPress={() => void Linking.openURL(p.url!).catch(() => {})} accessibilityRole="link">{p.text}</Text>
                : <Text key={i}>{p.text}</Text>)}
            </Text>
          ) : null}
        </Pressable>
        {(row.time || m.state) ? (
          <Text style={[s.meta, font, { color: m.state === "failed" ? c.danger : c.muted, textAlign: mine ? "right" : "left" }]}>
            {m.state === "sending" ? words.sending : m.state === "failed" ? words.failed : row.time}
          </Text>
        ) : null}
      </View>
    );
  };

  const canSend = Boolean(text.trim() || photo);
  return (
    <KeyboardAvoidingView style={[s.screen, { backgroundColor: c.background }]} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={keyboardOffset}>
      {header ? (
        <View style={[s.header, { paddingTop: 12 + topInset, borderBottomColor: c.line }]}>
          <View style={s.headerText}>
            <Text style={[s.title, bold, { color: c.onTeam }]} accessibilityRole="header" maxFontSizeMultiplier={2}>{words.title}</Text>
            {words.subtitle ? <Text style={[s.subtitle, font, { color: c.muted }]} maxFontSizeMultiplier={2}>{words.subtitle}</Text> : null}
          </View>
          {onClose ? (
            <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel={words.close} style={[s.close, { backgroundColor: c.team }]}>
              <Text style={[s.closeX, { color: c.onTeam }]} maxFontSizeMultiplier={1.4}>✕</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {server === null ? (
        <View style={s.center}><ActivityIndicator color={c.muted} /></View>
      ) : rows.length === 0 ? (
        <View style={s.center}>
          <View style={[s.emptyMark, { backgroundColor: c.accent, borderRadius: r + 6 }]}><Text style={[s.emptyIcon, { color: c.onAccent }]} maxFontSizeMultiplier={1.4}>💬</Text></View>
          <Text style={[s.emptyTitle, bold, { color: c.onTeam }]}>{words.emptyTitle}</Text>
          <Text style={[s.emptyBody, font, { color: c.muted }]}>{words.emptyBody}</Text>
        </View>
      ) : (
        <FlatList
          ref={list}
          inverted
          data={rows}
          keyExtractor={(row: ChatRow) => row.key}
          contentContainerStyle={s.list}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }: { item: ChatRow }) => item.kind === "day"
            ? <Text style={[s.day, font, { color: c.muted }]}>{item.label}</Text>
            : bubble(item)}
        />
      )}

      {photo?.uri ? (
        <View style={[s.preview, { borderTopColor: c.line }]}>
          <Image source={{ uri: photo.uri }} style={[s.previewImage, { borderRadius: Math.min(10, r) }]} />
          <Pressable onPress={() => setPhoto(null)} hitSlop={10} accessibilityRole="button" accessibilityLabel={words.close} style={[s.previewX, { backgroundColor: c.team }]}>
            <Text style={{ color: c.onTeam }} maxFontSizeMultiplier={1.4}>✕</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={[s.bar, { borderTopColor: c.line, paddingBottom: 8 + bottomInset }]}>
        {pickImage ? (
          <Pressable onPress={addPhoto} hitSlop={8} accessibilityRole="button" accessibilityLabel={words.addPhoto} style={[s.round, { backgroundColor: c.input }]}>
            <Text style={[s.plus, { color: c.muted }]} maxFontSizeMultiplier={1.4}>＋</Text>
          </Pressable>
        ) : null}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={words.placeholder}
          placeholderTextColor={c.muted}
          multiline
          style={[s.input, font, { backgroundColor: c.input, color: c.onTeam, borderRadius: Math.min(r, 20), textAlign: align }]}
          accessibilityLabel={words.placeholder}
        />
        <Pressable
          onPress={send}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel={words.send}
          accessibilityState={{ disabled: !canSend }}
          style={[s.round, { backgroundColor: canSend ? c.accent : c.input }]}
        >
          <Text style={[s.arrow, { color: canSend ? c.onAccent : c.muted }]} maxFontSizeMultiplier={1.4}>↑</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

/** Answers this person hasn't seen yet, for a badge. Checks when mounted and every `everyMs` (default a minute). */
export function useChatUnread(everyMs = 60_000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const check = () => void Apparent.chat.unread().then((x) => { if (live) setN(x); }).catch(() => {});
    check();
    const t = setInterval(check, everyMs);
    return () => { live = false; clearInterval(t); };
  }, [everyMs]);
  return n;
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
  headerText: { flex: 1 },
  title: { fontSize: 20 },
  subtitle: { fontSize: 13, marginTop: 2 },
  close: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  closeX: { fontSize: 14 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  emptyMark: { width: 64, height: 64, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  emptyIcon: { fontSize: 28 },
  emptyTitle: { fontSize: 20, textAlign: "center" },
  emptyBody: { fontSize: 15, lineHeight: 21, textAlign: "center", marginTop: 6 },
  list: { paddingHorizontal: 14, paddingVertical: 12 },
  day: { fontSize: 12, textAlign: "center", marginTop: 18, marginBottom: 4 },
  bubble: { maxWidth: "82%", paddingHorizontal: 14, paddingVertical: 9 },
  text: { fontSize: 16, lineHeight: 22 },
  image: { width: 220, height: 220, marginVertical: 4 },
  meta: { fontSize: 11, marginTop: 4, marginHorizontal: 6 },
  preview: { flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 14, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth },
  previewImage: { width: 64, height: 64 },
  previewX: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", marginStart: -12, marginTop: -8 },
  bar: { flexDirection: "row", alignItems: "flex-end", gap: 8, paddingHorizontal: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minHeight: 40, maxHeight: 140, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, fontSize: 16 },
  round: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  plus: { fontSize: 22 },
  arrow: { fontSize: 20, fontWeight: "700" },
});
