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
let checkStateListener:
  | ((state: {
      status: string;
      resultKind: string;
      hash?: string;
    }) => void)
  | null = null;
type UpdateStrategyMode = 'silentAndNow' | 'silentAndLater';
const updatePlatform = Platform.OS === 'android' ? 'android' : 'ios';

function App() {
  const {
    checkUpdate,
    client: contextClient,
    packageVersion,
    currentHash,
    lastError,
    progress: { received, total } = {},
    currentVersionInfo,
  } = useUpdate();
  const client = contextClient!;
  const [lastEvent, setLastEvent] = useState('idle');
  const [lastEventData, setLastEventData] = useState('(empty)');
  const [lastEventVersion, setLastEventVersion] = useState('(none)');
  const [lastCheckStatus, setLastCheckStatus] = useState('(none)');
  const [lastCheckResult, setLastCheckResult] = useState('(none)');
  const [selectedStrategy, setSelectedStrategy] = useState<UpdateStrategyMode>(
    'silentAndNow',
  );
  const bundleLabelGlobal = globalThis as typeof globalThis & {
    __RNU_E2E_BUNDLE_LABEL?: string;
  };
  const bundleLabel =
    bundleLabelGlobal.__RNU_E2E_BUNDLE_LABEL || LOCAL_UPDATE_LABELS.base;

  const applyStrategy = (strategy: UpdateStrategyMode) => {
    client.setOptions({ updateStrategy: strategy });
    setSelectedStrategy(strategy);
  };

  useEffect(() => {
    const listener = (type: string, data?: Record<string, unknown>) => {
      setLastEvent(type);
      const message = JSON.stringify(data ?? {});
      setLastEventData(message || '(empty)');
      setLastEventVersion(
        typeof data?.newVersion === 'string' ? data.newVersion : '(none)',
      );
    };
    const checkListener = (state: {
      status: string;
      resultKind: string;
      hash?: string;
    }) => {
      setLastCheckStatus(state.status);
      setLastCheckResult(
        state.hash
          ? `${state.resultKind}:${state.hash}`
          : state.resultKind,
      );
    };
    eventListener = listener;
    checkStateListener = checkListener;
    return () => {
      if (eventListener === listener) {
        eventListener = null;
      }
      if (checkStateListener === checkListener) {
        checkStateListener = null;
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
      <Text testID="update-strategy">updateStrategy: {selectedStrategy}</Text>
      <Text testID="endpoint">
        endpoint: {getLocalUpdateEndpoint(updatePlatform)}
      </Text>
      <Text testID="progress">
        progress: {received || 0} / {total || 0}
      </Text>
      <Text testID="last-event">lastEvent: {lastEvent}</Text>
      <Text testID="last-event-data">lastEventData: {lastEventData}</Text>
      <Text testID="last-event-version">lastEventVersion: {lastEventVersion}</Text>
      <Text testID="last-check-status">lastCheckStatus: {lastCheckStatus}</Text>
      <Text testID="last-check-result">lastCheckResult: {lastCheckResult}</Text>
      <Text testID="last-error">lastError: {lastError?.message || '(none)'}</Text>
      <Text testID="version-info">
        currentVersionInfo: {JSON.stringify(currentVersionInfo) || '(empty)'}
      </Text>

      <View style={styles.buttonRow}>
        <Pressable
          testID="strategy-silent-now"
          style={styles.button}
          onPress={() => {
            applyStrategy('silentAndNow');
          }}
        >
          <Text style={styles.buttonText}>Use SilentAndNow</Text>
        </Pressable>

        <Pressable
          testID="strategy-silent-later"
          style={styles.button}
          onPress={() => {
            applyStrategy('silentAndLater');
          }}
        >
          <Text style={styles.buttonText}>Use SilentAndLater</Text>
        </Pressable>
      </View>

      <Pressable
        testID="check-update"
        style={styles.button}
        onPress={() => {
          setLastEvent('triggerCheckUpdate');
          setLastEventData('(manual)');
          setLastEventVersion('(none)');
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
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
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
  afterCheckUpdate: state => {
    const result = state.result;
    const resultKind = result?.update
      ? 'update'
      : result?.upToDate
        ? 'upToDate'
        : result?.expired
          ? 'expired'
          : result?.paused
            ? `paused:${result.paused}`
            : '(none)';
    checkStateListener?.({
      status: state.status,
      resultKind,
      hash: result?.hash,
    });
  },
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
