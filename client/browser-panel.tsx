import { useRpc, useSubscription, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import {
  browserRpc,
  browserStream,
  browserAck,
  decodeFrame,
  VIEWPORT,
  type BrowserInput,
} from "../shared/browser";
import { bindBrowserSurface, frameSource } from "./web";

export function BrowserPanel({ workspaceId, theme, layout }: PluginWorkspacePanelProps) {
  const call = useRpc(browserRpc);
  const acknowledge = useRpc(browserAck);
  const [address, setAddress] = useState("");
  const [title, setTitle] = useState("Host browser");
  const [error, setError] = useState("");
  const [picture, setPicture] = useState<{
    uri: string;
    sequence: number;
    streamId: string;
  } | null>(null);
  const [generation, retry] = useState(0);
  const [surface, setSurface] = useState<View | null>(null);
  const [width, setWidth] = useState<number>(VIEWPORT.width);
  const [drag, setDrag] = useState(false);
  const streamId = useRef("");
  const releasePicture = useRef<() => void>(() => {});
  const [keyboardText, setKeyboardText] = useState("");
  const editingAddress = useRef(false);
  const touch = useRef({ x: 0, y: 0, moved: false });
  const pending = useRef(0);
  const styles = useStyles(theme, layout.compact);
  const send = useCallback(
    (input: BrowserInput) => {
      if (
        pending.current >= 128 &&
        !((input.action === "key" || input.action === "pointer") && input.phase === "up")
      ) {
        setError("Input connection is falling behind; reopen the panel");
        return;
      }
      pending.current++;
      void call({ ...input, workspaceId })
        .catch((cause: unknown) => setError(String(cause)))
        .finally(() => pending.current--);
    },
    [call, workspaceId],
  );
  useEffect(() => bindBrowserSurface(surface, send), [surface, send]);
  useEffect(() => {
    setPicture(null);
    streamId.current = "";
    return () => releasePicture.current();
  }, [workspaceId, generation]);
  // A key remount on Retry creates a fresh subscription without periodic screenshot requests.
  return (
    <Stream
      key={`${workspaceId}:${generation}`}
      workspaceId={workspaceId}
      onEvent={(event) => {
        if (event instanceof Uint8Array) {
          const frame = decodeFrame(event);
          const source = frameSource(frame.jpeg);
          releasePicture.current();
          releasePicture.current = source.release;
          setPicture({ uri: source.uri, sequence: frame.sequence, streamId: streamId.current });
        } else {
          streamId.current = event.streamId;
          setTitle(event.title || "Host browser");
          if (!editingAddress.current) setAddress(event.url === "about:blank" ? "" : event.url);
        }
      }}
    >
      {(status) => (
        <View style={styles.screen}>
          <Text style={styles.title}>{title}</Text>
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
              onSubmitEditing={() => send({ action: "navigate", url: address })}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="localhost:3000 or a URL"
              placeholderTextColor={theme.colors.foregroundMuted}
              accessibilityLabel="Browser address"
            />
            <Action
              label="Go"
              onPress={() => send({ action: "navigate", url: address })}
              styles={styles}
            />
            {(["back", "forward", "reload"] as const).map((action) => (
              <Action
                key={action}
                label={action}
                onPress={() => send({ action })}
                styles={styles}
              />
            ))}
          </View>
          <View style={styles.row}>
            <Text style={styles.muted}>{error || status}</Text>
            <Action
              label="Reconnect"
              onPress={() => {
                setError("");
                retry((value) => value + 1);
              }}
              styles={styles}
            />
          </View>
          <View
            ref={setSurface}
            style={styles.viewport}
            accessibilityLabel="Interactive host browser"
            onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
            onStartShouldSetResponder={() => Platform.OS !== "web"}
            onResponderGrant={(event) => {
              const { locationX: x, locationY: y } = event.nativeEvent;
              touch.current = { x, y, moved: false };
              if (drag)
                send({
                  action: "pointer",
                  phase: "down",
                  x: (x / width) * VIEWPORT.width,
                  y: (y / width) * VIEWPORT.width,
                  button: "left",
                });
            }}
            onResponderMove={(event) => {
              const { locationX: x, locationY: y } = event.nativeEvent;
              const previous = touch.current;
              if (Math.abs(x - previous.x) + Math.abs(y - previous.y) > 3) previous.moved = true;
              if (drag)
                send({
                  action: "pointer",
                  phase: "move",
                  x: (x / width) * VIEWPORT.width,
                  y: (y / width) * VIEWPORT.width,
                  button: "left",
                });
              else if (previous.moved)
                send({
                  action: "scroll",
                  x: ((previous.x - x) / width) * VIEWPORT.width,
                  y: ((previous.y - y) / width) * VIEWPORT.width,
                });
              touch.current = { x, y, moved: previous.moved };
            }}
            onResponderRelease={(event) => {
              const { locationX: x, locationY: y } = event.nativeEvent;
              if (drag)
                send({
                  action: "pointer",
                  phase: "up",
                  x: (x / width) * VIEWPORT.width,
                  y: (y / width) * VIEWPORT.width,
                  button: "left",
                });
              else if (!touch.current.moved)
                send({
                  action: "click",
                  x: (x / width) * VIEWPORT.width,
                  y: (y / width) * VIEWPORT.width,
                });
            }}
            onResponderTerminate={() => {
              if (drag) send({ action: "pointer", phase: "up", x: 0, y: 0, button: "left" });
            }}
          >
            {picture ? (
              <Image
                source={{ uri: picture.uri }}
                resizeMode="stretch"
                style={styles.image}
                onLoad={() => {
                  void acknowledge({
                    streamId: picture.streamId,
                    sequence: picture.sequence,
                  }).catch((cause: unknown) => setError(String(cause)));
                }}
                onError={() => setError("Frame could not be displayed; reconnect to retry")}
              />
            ) : (
              <Text style={styles.muted}>Connecting to host Chrome…</Text>
            )}
          </View>
          {Platform.OS !== "web" ? (
            <View style={styles.row}>
              <TextInput
                style={styles.address}
                value={keyboardText}
                placeholder="Tap to type in the focused page field"
                placeholderTextColor={theme.colors.foregroundMuted}
                accessibilityLabel="Host browser keyboard"
                autoCorrect={false}
                autoCapitalize="none"
                onFocus={() => setKeyboardText("")}
                onChangeText={(text) => {
                  const previous = [...keyboardText];
                  const next = [...text];
                  let common = 0;
                  while (
                    common < previous.length &&
                    common < next.length &&
                    previous[common] === next[common]
                  )
                    common++;
                  for (let index = common; index < previous.length; index++)
                    send({ action: "key", key: "Backspace", phase: "press" });
                  const inserted = next.slice(common).join("");
                  if (inserted) send({ action: "type", text: inserted });
                  setKeyboardText(text);
                }}
                onSubmitEditing={() => send({ action: "key", key: "Enter", phase: "press" })}
              />
              <Action
                label={drag ? "Drag mode" : "Scroll mode"}
                onPress={() => setDrag((value) => !value)}
                styles={styles}
              />
              {(["Tab", "Escape"] as const).map((key) => (
                <Action
                  key={key}
                  label={key}
                  onPress={() => send({ action: "key", key, phase: "press" })}
                  styles={styles}
                />
              ))}
            </View>
          ) : (
            <Text style={styles.muted}>
              Click the page to focus. Type, scroll, drag, or paste directly.
            </Text>
          )}
        </View>
      )}
    </Stream>
  );
}

function Stream({
  workspaceId,
  onEvent,
  children,
}: {
  workspaceId: string;
  onEvent: (event: Uint8Array | { streamId: string; url: string; title: string }) => void;
  children: (status: string) => React.ReactNode;
}) {
  const subscription = useSubscription(browserStream, { workspaceId }, onEvent);
  return children(
    subscription.status === "error" ? subscription.error.message : subscription.status,
  );
}
function Action({
  label,
  onPress,
  styles,
}: {
  label: string;
  onPress(): void;
  styles: ReturnType<typeof useStyles>;
}) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.button}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}
function useStyles(theme: PluginWorkspacePanelProps["theme"], compact: boolean) {
  return useMemo(
    () =>
      StyleSheet.create({
        screen: {
          flex: 1,
          padding: compact ? 10 : 18,
          gap: 10,
          backgroundColor: theme.colors.surface0,
        },
        title: { color: theme.colors.foreground, fontSize: 18, fontWeight: "600" },
        muted: { color: theme.colors.foregroundMuted },
        row: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
        address: {
          flex: 1,
          minWidth: 150,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 6,
          padding: 8,
          color: theme.colors.foreground,
        },
        button: { backgroundColor: theme.colors.surface2, padding: 8, borderRadius: 6 },
        buttonText: { color: theme.colors.foreground },
        viewport: {
          width: "100%",
          aspectRatio: VIEWPORT.width / VIEWPORT.height,
          backgroundColor: theme.colors.surface2,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        },
        image: { width: "100%", height: "100%" },
      }),
    [theme, compact],
  );
}
