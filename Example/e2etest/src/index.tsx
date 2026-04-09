import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { UpdateProvider, Pushy, useUpdate } from 'react-native-update';
import {
  LOCAL_UPDATE_APP_KEYS,
  LOCAL_UPDATE_LABELS,
  getLocalUpdateEndpoint,
} from '../e2e/localUpdateConfig.ts';

let eventListener:
  | ((type: string, data?: Record<string, unknown>) => void)
  | null = null;
const updatePlatform = Platform.OS === 'android' ? 'android' : 'ios';

function App() {
  const {
    checkUpdate,
    client,
    packageVersion,
    currentHash,
    lastError,
    progress: { received, total } = {},
    currentVersionInfo,
  } = useUpdate();
  const [lastEvent, setLastEvent] = useState('idle');
  const [lastEventData, setLastEventData] = useState('(empty)');
  const bundleLabelGlobal = globalThis as typeof globalThis & {
    __RNU_E2E_BUNDLE_LABEL?: string;
  };
  const bundleLabel =
    bundleLabelGlobal.__RNU_E2E_BUNDLE_LABEL || LOCAL_UPDATE_LABELS.base;

  useEffect(() => {
    const listener = (type: string, data?: Record<string, unknown>) => {
      setLastEvent(type);
      const message = JSON.stringify(data ?? {});
      setLastEventData(message || '(empty)');
    };
    eventListener = listener;
    return () => {
      if (eventListener === listener) {
        eventListener = null;
      }
    };
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.welcome}>react-native-update e2etest</Text>
      <Text testID="bundle-label">bundleLabel: {bundleLabel}</Text>
      <Text testID="current-hash">currentHash: {currentHash || '(empty)'}</Text>
      <Text testID="package-version">packageVersion: {packageVersion}</Text>
      <Text testID="client-version">clientVersion: {client?.version}</Text>
      <Text testID="endpoint">
        endpoint: {getLocalUpdateEndpoint(updatePlatform)}
      </Text>
      <Text testID="progress">
        progress: {received || 0} / {total || 0}
      </Text>
      <Text testID="last-event">lastEvent: {lastEvent}</Text>
      <Text testID="last-event-data">lastEventData: {lastEventData}</Text>
      <Text testID="last-error">lastError: {lastError?.message || '(none)'}</Text>
      <Text testID="version-info">
        currentVersionInfo: {JSON.stringify(currentVersionInfo) || '(empty)'}
      </Text>

      <Pressable
        testID="check-update"
        style={styles.button}
        onPress={() => {
          setLastEvent('triggerCheckUpdate');
          setLastEventData('(manual)');
          checkUpdate();
        }}
      >
        <Text style={styles.buttonText}>Check Update</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    backgroundColor: '#F5FCFF',
  },
  welcome: {
    fontSize: 20,
    textAlign: 'center',
    marginBottom: 12,
  },
  button: {
    marginTop: 16,
    borderRadius: 8,
    backgroundColor: '#0a84ff',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  buttonText: {
    textAlign: 'center',
    color: '#ffffff',
    fontWeight: '600',
  },
});

const updateClient = new Pushy({
  appKey: LOCAL_UPDATE_APP_KEYS[updatePlatform],
  server: {
    main: [getLocalUpdateEndpoint(updatePlatform)],
  },
  debug: true,
  updateStrategy: 'silentAndNow',
  checkStrategy: null,
  autoMarkSuccess: true,
  logger: ({ type, data }) => {
    eventListener?.(type, data);
  },
});

export default function Root() {
  return (
    <UpdateProvider client={updateClient}>
      <App />
    </UpdateProvider>
  );
}
