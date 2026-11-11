import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { browserRpc, VIEWPORT, type BrowserAction } from "../shared/browser";

export function BrowserPanel({ workspaceId, theme, layout }: PluginWorkspacePanelProps) {
  const call = useRpc(browserRpc);
  const [address, setAddress] = useState("");
  const [typedText, setTypedText] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("Opening host browser…");
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState<number>(VIEWPORT.width);
  const editingAddress = useRef(false);
  const pendingCount = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const styles = useStyles(theme, layout.compact);

  const run = useCallback(
    (input: BrowserAction) => {
      // Skip only periodic snapshots. User commands must wait their turn, never disappear.
      if (input.action === "snapshot" && pendingCount.current > 0) return;
      pendingCount.current += 1;
      const execute = async () => {
        if (input.action !== "snapshot") setBusy(true);
        try {
          const result = await call(input);
          setImage(result.image);
          setTitle(result.title);
          if (!editingAddress.current) setAddress(result.url === "about:blank" ? "" : result.url);
          setStatus("");
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error));
        } finally {
          pendingCount.current -= 1;
          if (pendingCount.current === 0) setBusy(false);
        }
      };
      queue.current = queue.current.then(execute, execute);
      return queue.current;
    },
    [call],
  );

  useEffect(() => {
    void run({ action: "snapshot", workspaceId });
    const timer = setInterval(() => void run({ action: "snapshot", workspaceId }), 2_000);
    return () => clearInterval(timer);
  }, [run, workspaceId]);

  const navigate = () => {
    editingAddress.current = false;
    void run({ action: "navigate", workspaceId, url: address });
  };
  const click = (x: number, y: number) => {
    void run({
      action: "click",
      workspaceId,
      x: Math.round((x / width) * VIEWPORT.width),
      y: Math.round((y / (width * (VIEWPORT.height / VIEWPORT.width))) * VIEWPORT.height),
    });
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="always"
    >
      <Text style={styles.heading}>{title || "Host browser"}</Text>
      <View style={styles.row}>
        <TextInput
          style={styles.address}
          value={address}
          onChangeText={setAddress}
          onFocus={() => {
            editingAddress.current = true;
          }}
          onBlur={() => {
            editingAddress.current = false;
          }}
          onSubmitEditing={navigate}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          placeholder="localhost:3000 or a URL"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="Browser address"
        />
        <Action label="Go" onPress={navigate} styles={styles} disabled={busy} />
      </View>
      <View style={styles.row}>
        <Action
          label="Back"
          onPress={() => void run({ action: "back", workspaceId })}
          styles={styles}
          disabled={busy}
        />
        <Action
          label="Forward"
          onPress={() => void run({ action: "forward", workspaceId })}
          styles={styles}
          disabled={busy}
        />
        <Action
          label="Reload"
          onPress={() => void run({ action: "reload", workspaceId })}
          styles={styles}
          disabled={busy}
        />
        <Action
          label="↑"
          onPress={() => void run({ action: "scroll", workspaceId, x: 0, y: -550 })}
          styles={styles}
          disabled={busy}
        />
        <Action
          label="↓"
          onPress={() => void run({ action: "scroll", workspaceId, x: 0, y: 550 })}
          styles={styles}
          disabled={busy}
        />
      </View>
      <Text style={styles.status}>
        {status || (busy ? "Updating…" : "Browser runs on the selected host")}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Browser page; tap to click"
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        onPress={(event) => click(event.nativeEvent.locationX, event.nativeEvent.locationY)}
        style={styles.viewport}
      >
        {image ? (
          <Image
            source={{ uri: `data:image/jpeg;base64,${image}` }}
            resizeMode="stretch"
            style={styles.image}
          />
        ) : (
          <Text style={styles.empty}>Browser screenshot appears here</Text>
        )}
      </Pressable>
      <View style={styles.row}>
        <TextInput
          style={styles.address}
          value={typedText}
          onChangeText={setTypedText}
          onSubmitEditing={() => {
            void run({ action: "type", workspaceId, text: typedText });
            setTypedText("");
          }}
          placeholder="Type into selected page field"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="Text to type in browser"
        />
        <Action
          label="Type"
          onPress={() => {
            void run({ action: "type", workspaceId, text: typedText });
            setTypedText("");
          }}
          styles={styles}
          disabled={busy || !typedText}
        />
      </View>
      <View style={styles.row}>
        {(["Enter", "Tab", "Escape", "Backspace"] as const).map((key) => (
          <Action
            key={key}
            label={key}
            onPress={() => void run({ action: "key", workspaceId, key })}
            styles={styles}
            disabled={busy}
          />
        ))}
      </View>
    </ScrollView>
  );
}

function Action({
  label,
  onPress,
  styles,
  disabled,
}: {
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof useStyles>;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={styles.button}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function useStyles(theme: PluginWorkspacePanelProps["theme"], compact: boolean) {
  return useMemo(
    () =>
      StyleSheet.create({
        screen: { flex: 1, backgroundColor: theme.colors.surface0 },
        content: { padding: compact ? 12 : 24, gap: 10 },
        heading: { color: theme.colors.foreground, fontSize: 18, fontWeight: "600" },
        row: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
        address: {
          flex: 1,
          minWidth: 180,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 6,
          paddingHorizontal: 10,
          paddingVertical: 7,
          color: theme.colors.foreground,
        },
        button: {
          backgroundColor: theme.colors.surface2,
          borderRadius: 6,
          paddingHorizontal: 10,
          paddingVertical: 8,
        },
        buttonText: { color: theme.colors.foreground, fontWeight: "600" },
        status: { color: theme.colors.foregroundMuted },
        viewport: {
          width: "100%",
          aspectRatio: VIEWPORT.width / VIEWPORT.height,
          backgroundColor: theme.colors.surface2,
          alignItems: "center",
          justifyContent: "center",
        },
        image: { width: "100%", height: "100%" },
        empty: { color: theme.colors.foregroundMuted },
      }),
    [theme, compact],
  );
}
