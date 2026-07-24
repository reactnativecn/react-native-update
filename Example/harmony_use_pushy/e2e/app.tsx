import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Pushy, UpdateProvider, useUpdate } from 'react-native-update';
import {
  getLocalUpdateEndpoint,
  LOCAL_UPDATE_APP_KEY,
  LOCAL_UPDATE_LABELS,
} from './localUpdateConfig';

function App() {
  const {
    checkUpdate,
    packageVersion,
    currentHash,
    lastError,
    client,
    progress: { received, total } = {},
  } = useUpdate();
  const bundleLabelGlobal = globalThis as typeof globalThis & {
    __RNU_E2E_BUNDLE_LABEL?: string;
  };
  const bundleLabel =
    bundleLabelGlobal.__RNU_E2E_BUNDLE_LABEL || LOCAL_UPDATE_LABELS.base;

  return (
    <View style={styles.container}>
      <Text style={styles.welcome}>react-native-update harmony e2e</Text>
      <Text testID="bundle-label">bundleLabel: {bundleLabel}</Text>
      <Text testID="current-hash">currentHash: {currentHash || '(empty)'}</Text>

      <Pressable
        testID="check-update"
        style={styles.button}
        onPress={() => {
          checkUpdate();
        }}
      >
        <Text style={styles.buttonText}>Check Update</Text>
      </Pressable>

      <Text testID="package-version">packageVersion: {packageVersion}</Text>
      <Text testID="client-version">clientVersion: {client?.version}</Text>
      <Text testID="endpoint" numberOfLines={1}>
        endpoint: {getLocalUpdateEndpoint()}
      </Text>
      <Text testID="progress">
        progress: {received || 0} / {total || 0}
      </Text>
      <Text testID="last-error" numberOfLines={1}>
        lastError: {lastError?.message || '(none)'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#F5FCFF',
  },
  welcome: {
    fontSize: 20,
    textAlign: 'center',
    marginBottom: 12,
  },
  button: {
    marginTop: 8,
    marginBottom: 8,
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
  appKey: LOCAL_UPDATE_APP_KEY,
  server: {
    main: [getLocalUpdateEndpoint()],
  },
  debug: true,
  updateStrategy: 'silentAndNow',
  checkStrategy: null,
});

export default function Root() {
  return (
    <UpdateProvider client={updateClient}>
      <App />
    </UpdateProvider>
  );
}
