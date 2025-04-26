/* eslint-disable react-native/no-inline-styles */
/* eslint-disable react/react-in-jsx-scope */
import {useCallback, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  TextInput,
  Button,
  StyleSheet,
  SafeAreaView,
  Text,
  View,
  TouchableOpacity,
} from 'react-native';

import {PushyModule} from 'react-native-update';
const Hash = '9D5CE6EBA420717BE7E7D308B11F8207681B066C951D68F3994D19828F342474';
const UUID = '00000000-0000-0000-0000-000000000000';
const DownloadUrl = 'https://localhost:3000/diff.ppk-patch';
const AppPatchDownloadUrl = 'https://github.com/bozaigao/test_pushy_server/raw/refs/heads/main/hdiff.app-patch';
const AppPatchHash = 'f5ba92c7c04250d4b8a446c8267ef459';
const PPKDownloadUrl = 'https://github.com/bozaigao/test_pushy_server/raw/refs/heads/main/hdiff.ppk-patch';
const PPKPatchHash = '6b3d26b7d868d1f67aedadb7f0b342d9';
const OriginHash = 'f5ba92c7c04250d4b8a446c8267ef459';


const CustomDialog = ({title, visible, onConfirm}) => {
  if (!visible) {
    return null;
  }

  return (
    <View style={styles.overlay}>
      <View style={styles.dialog}>
        <Text style={styles.title}>{title}</Text>
        <TouchableOpacity
          testID="done"
          style={styles.button}
          onPress={onConfirm}>
          <Text style={styles.buttonText}>确认</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};
export default function TestConsole({visible, onClose}) {
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [options, setOptions] = useState();
  const [alertVisible, setAlertVisible] = useState(false);
  const [alertMsg, setAlertMsg] = useState('');
  const NativeTestMethod = useMemo(() => {
    return [
      {
        name: 'setLocalHashInfo',
        invoke: () => {
          setText(
            `setLocalHashInfo\n${Hash}\n{\"version\":\"1.0.0\",\"size\":\"19M\"}`,
          );
        },
      },
      {
        name: 'getLocalHashInfo',
        invoke: () => {
          setText(`getLocalHashInfo\n${Hash}`);
        },
      },
      {
        name: 'setUuid',
        invoke: () => {
          setText(`setUuid\n${UUID}`);
        },
      },
      {
        name: 'reloadUpdate',
        invoke: () => {
          setText('reloadUpdate');
          setOptions({hash: Hash});
        },
      },
      {
        name: 'setNeedUpdateForApp',
        invoke: () => {
          setText('setNeedUpdate');
          setOptions({hash: AppPatchHash});
        },
      },
      {
        name: 'setNeedUpdateForPPK',
        invoke: () => {
          setText('setNeedUpdate');
          setOptions({hash: PPKPatchHash});
        },
      },
      {
        name: 'markSuccess',
        invoke: () => {
          setText('markSuccess');
          setOptions(undefined);
        },
      },
      {
        name: 'downloadPatchFromPpk',
        invoke: () => {
          setText('downloadPatchFromPpk');
          setOptions({updateUrl: PPKDownloadUrl, hash: PPKPatchHash, originHash: OriginHash});
        },
      },
      {
        name: 'downloadPatchFromPackage',
        invoke: () => {
          setText('downloadPatchFromPackage');
          setOptions({updateUrl: AppPatchDownloadUrl, hash: AppPatchHash});
        },
      },
      {
        name: 'downloadFullUpdate',
        invoke: () => {
          setText('downloadFullUpdate');
          setOptions({updateUrl: DownloadUrl, hash: Hash});
        },
      },
      {
        name: 'downloadAndInstallApk',
        invoke: () => {
          setText('downloadAndInstallApk');
          setOptions({url: DownloadUrl, target: Hash, hash: Hash});
        },
      },
    ];
  }, []);

  const renderTestView = useCallback(() => {
    const views = [];
    for (let i = 0; i < NativeTestMethod.length; i++) {
      views.push(
        <TouchableOpacity
          key={i}
          testID={NativeTestMethod[i].name}
          onPress={() => {
            NativeTestMethod[i].invoke();
          }}>
          <Text>{NativeTestMethod[i].name}</Text>
        </TouchableOpacity>,
      );
    }
    return <View>{views}</View>;
  }, [NativeTestMethod]);
  if (!visible) {
    return null;
  }

  return (
    <SafeAreaView style={{flex: 1, padding: 10}}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 10,
        }}>
        <Text>调试Pushy方法（方法名，参数，值换行）</Text>
        <Button title="关闭" onPress={() => onClose()} />
      </View>
      <TextInput
        autoCorrect={false}
        autoCapitalize="none"
        style={{
          borderWidth: StyleSheet.hairlineWidth * 4,
          borderColor: 'black',
          height: '30%',
          marginTop: 20,
          marginBottom: 20,
          padding: 10,
          fontSize: 20,
        }}
        textAlignVertical="top"
        multiline={true}
        value={text}
        onChangeText={setText}
      />
      {running && <ActivityIndicator />}
      <TouchableOpacity
        style={{
          backgroundColor: 'rgb(0,140,237)',
          justifyContent: 'center',
          alignItems: 'center',
          paddingTop: 10,
          paddingBottom: 10,
          marginBottom: 5,
        }}
        testID="submit"
        onPress={async () => {
          setRunning(true);
          try {
            const inputs = text.split('\n');
            const methodName = inputs[0];
            let params = [];
            if (inputs.length === 1) {
              if (options) {
                await PushyModule[methodName](options);
              } else {
                await PushyModule[methodName]();
              }
            } else {
              if (inputs.length === 2) {
                params = [inputs[1]];
              } else {
                params = [inputs[1], inputs[2]];
                console.log({inputs, params});
              }
              await PushyModule[methodName](...params);
            }
            setAlertVisible(true);
            setAlertMsg('done');
          } catch (e) {
            setAlertVisible(true);
            setAlertMsg(e.message);
          }
          setRunning(false);
        }}>
        <Text style={{color: 'white'}}>执行</Text>
      </TouchableOpacity>
      <Button title="重置" onPress={() => setText('')} />
      {renderTestView()}
      <CustomDialog
        title={alertMsg}
        visible={alertVisible}
        onConfirm={() => {
          setAlertVisible(false);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  dialog: {
    backgroundColor: 'white',
    borderRadius: 10,
    padding: 20,
    width: '80%',
    alignItems: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  button: {
    backgroundColor: '#2196F3',
    borderRadius: 5,
    paddingVertical: 10,
    paddingHorizontal: 20,
  },
  buttonText: {
    color: 'white',
    fontWeight: 'bold',
  },
});
