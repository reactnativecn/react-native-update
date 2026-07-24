/* eslint-disable react/no-unstable-nested-components */
/* eslint-disable react-native/no-inline-styles */
import { useRef, useState } from 'react';
import {
  Image,
  Platform,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Camera } from 'react-native-camera-kit';
import {
  Banner,
  Button,
  Icon,
  Modal,
  PaperProvider,
  Portal,
  Snackbar,
} from 'react-native-paper';
import { LocalSvg } from 'react-native-svg/css';
import { Pushy, UpdateProvider, useUpdate } from 'react-native-update';

import _updateConfig from '../update.json';
import TestConsole from './TestConsole';

const nativePlatform = Platform.OS === 'ios' ? 'ios' : 'android';
const { appKey } = _updateConfig[nativePlatform];

import * as Sentry from '@sentry/react-native';

Sentry.init({
  dsn: 'https://2a40310a11174bfdb6b3ac9890117d57@o470455.ingest.us.sentry.io/4511533206208512',

  // Adds more context data to events (IP address, cookies, user, etc.)
  // For more information, visit: https://docs.sentry.io/platforms/react-native/data-management/data-collected/
  sendDefaultPii: true,

  // Enable Logs
  enableLogs: true,

  // Configure Session Replay
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1,
  integrations: [
    Sentry.mobileReplayIntegration(),
    Sentry.feedbackIntegration(),
  ],

  // uncomment the line below to enable Spotlight (https://spotlightjs.com)
  // spotlight: __DEV__,
});

function App() {
  const {
    client,
    checkUpdate,
    downloadUpdate,
    switchVersionLater,
    switchVersion,
    updateInfo,
    packageVersion,
    currentHash,
    parseTestQrCode,
    progress: { received, total } = {},
    currentVersionInfo,
  } = useUpdate();
  const [useDefaultAlert, setUseDefaultAlert] = useState(true);
  const [showTestConsole, setShowTestConsole] = useState(false);
  const [showUpdateBanner, setShowUpdateBanner] = useState(false);
  const [showUpdateSnackbar, setShowUpdateSnackbar] = useState(false);
  const snackbarVisible =
    !useDefaultAlert && showUpdateSnackbar && updateInfo?.update;
  const [showCamera, setShowCamera] = useState(false);
  const lastParsedCode = useRef('');
  const bundleLabel =
    (globalThis as unknown as Record<string, string>).__RNU_E2E_BUNDLE_LABEL ||
    'base';

  return (
    <View style={styles.container}>
      <Text style={styles.welcome}>欢迎使用Pushy热更新服务</Text>
      <View style={{ flexDirection: 'row' }}>
        <Text>
          {useDefaultAlert ? '当前使用' : '当前不使用'}默认的alert更新提示
        </Text>
        <Switch
          value={useDefaultAlert}
          onValueChange={(v) => {
            setUseDefaultAlert(v);
            client?.setOptions({
              updateStrategy: v ? null : 'alwaysAlert',
            });
            setShowUpdateSnackbar(!v);
          }}
        />
        <Button
          onPress={() => {
            Sentry.captureException(
              new Error(`test error ${new Date().toISOString()}`)
            );
          }}
        >
          Try Sentry event
        </Button>
      </View>
      <Button onPress={() => setShowCamera(true)}>打开相机</Button>
      <Portal>
        <Modal visible={showCamera} onDismiss={() => setShowCamera(false)}>
          <Camera
            style={{ minHeight: 320 }}
            scanBarcode={true}
            onReadCode={({ nativeEvent: { codeStringValue } }) => {
              // 防止重复扫码
              if (lastParsedCode.current === codeStringValue) {
                return;
              }
              lastParsedCode.current = codeStringValue;
              setTimeout(() => {
                lastParsedCode.current = '';
              }, 1000);
              setShowCamera(false);
              parseTestQrCode(codeStringValue);
            }} // optional
            showFrame={true} // (default false) optional, show frame with transparent layer (qr code or barcode will be read on this area ONLY), start animation for scanner, that stops when a code has been found. Frame always at center of the screen
            laserColor="red" // (default red) optional, color of laser in scanner frame
            frameColor="white" // (default white) optional, color of border of scanner frame
          />
        </Modal>
      </Portal>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text>png:</Text>
        <Image
          resizeMode={'contain'}
          source={require('./assets/shezhi.png')}
          style={styles.image}
        />
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text>svg:</Text>
        <LocalSvg
          asset={require('./assets/react-logo.svg')}
          style={{ width: 30, height: 30 }}
        />
      </View>
      <Text style={styles.instructions}>
        这是版本一 {'\n'}
        当前原生包版本号: {packageVersion}
        {'\n'}
        当前热更新版本Hash: {currentHash || '(空)'}
        {'\n'}
        当前热更新版本信息: {JSON.stringify(currentVersionInfo) || '(空)'}
      </Text>
      <Text testID="bundle-label">bundleLabel: {bundleLabel}</Text>
      <Text>
        下载进度：{received} / {total}
      </Text>
      <TouchableOpacity
        onPress={() => {
          checkUpdate();
          setShowUpdateSnackbar(true);
        }}
      >
        <Text style={styles.instructions}>点击这里检查更新</Text>
      </TouchableOpacity>

      <TouchableOpacity
        testID="testcase"
        style={{ marginTop: 15 }}
        onLongPress={() => {
          setShowTestConsole(true);
        }}
      >
        <Text style={styles.instructions}>
          react-native-update版本：{client?.version}
        </Text>
      </TouchableOpacity>
      <TestConsole
        visible={showTestConsole}
        onClose={() => setShowTestConsole(false)}
      />
      {snackbarVisible && (
        <Snackbar
          visible={snackbarVisible}
          onDismiss={() => {
            setShowUpdateSnackbar(false);
          }}
          action={{
            label: '更新',
            onPress: async () => {
              setShowUpdateSnackbar(false);
              await downloadUpdate();
              setShowUpdateBanner(true);
            },
          }}
        >
          <Text style={{ color: 'white' }}>
            有新版本({updateInfo.name})可用，是否更新？
          </Text>
        </Snackbar>
      )}
      <Banner
        style={{ width: '100%', position: 'absolute', top: 0 }}
        visible={showUpdateBanner}
        actions={[
          {
            label: '立即重启',
            onPress: switchVersion,
          },
          {
            label: '下次再说',
            onPress: () => {
              switchVersionLater();
              setShowUpdateBanner(false);
            },
          },
        ]}
        icon={({ size }) => (
          <Icon source="checkcircleo" size={size} color="#00f" />
        )}
      >
        更新已完成，是否立即重启？
      </Banner>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F5FCFF',
  },
  welcome: {
    fontSize: 20,
    textAlign: 'center',
    margin: 10,
  },
  instructions: {
    textAlign: 'center',
    color: '#333333',
    marginBottom: 5,
  },
  image: {},
});

// use Pushy for China users
const updateClient = new Pushy({
  appKey,
  debug: true,
  // updateStrategy: 'silentAndLater',
});

// use Cresc for global users
// const updateClient = new Cresc({
//   appKey,
//   debug: true,
// });

export default function Root() {
  return (
    <UpdateProvider client={updateClient}>
      <PaperProvider>
        <App />
      </PaperProvider>
    </UpdateProvider>
  );
}
