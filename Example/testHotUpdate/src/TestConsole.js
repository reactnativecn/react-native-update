/* eslint-disable react-native/no-inline-styles */
/* eslint-disable react/react-in-jsx-scope */
import {useState} from 'react';
import {
  Alert,
  ActivityIndicator,
  Modal,
  TextInput,
  Button,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {PushyModule} from 'react-native-update/src/core';
const Hash = '9D5CE6EBA420717BE7E7D308B11F8207681B066C951D68F3994D19828F342474';
const UUID = '00000000-0000-0000-0000-000000000000';
const DownloadUrl =
  'http://cos.pgyer.com/697913e94d7441f20c686e2b0996a1aa.apk?sign=7a8f11b1df82cba45c8ac30b1acec88c&t=1680404102&response-content-disposition=attachment%3Bfilename%3DtestHotupdate_1.0.apk';

export default function TestConsole({visible, onClose}) {
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const convertCommands = (cmd, params) => {
    if (typeof params === 'string') {
      return `${cmd}\n${params}`;
    }
    let paramText = '';
    for (const [k, v] of Object.entries(params)) {
      paramText += `\n${k}\n${v}`;
    }
    return `${cmd}${paramText}`;
  };
  const shortCuts = [
      {
        name: 'setLocalHashInfo',
        invoke: () => {
          setText(
            convertCommands('setLocalHashInfo', {
              version: '1.0.0',
              size: '19M',
            }),
          );
        },
      },
      {
        name: 'getLocalHashInfo',
        invoke: () => {
          setText(convertCommands('getLocalHashInfo', Hash));
        },
      },
      {
        name: 'setUuid',
        invoke: () => {
          setText(convertCommands('setUuid', UUID));
        },
      },
      {
        name: 'reloadUpdate',
        invoke: () => {
          setText(convertCommands('reloadUpdate', {hash: Hash}));
        },
      },
      {
        name: 'setNeedUpdate',
        invoke: () => {
          setText(convertCommands('setNeedUpdate', {hash: Hash}));
        },
      },
      {
        name: 'markSuccess',
        invoke: () => {
          setText(convertCommands('markSuccess'));
        },
      },
      {
        name: 'downloadPatchFromPpk',
        invoke: () => {
          setText(
            convertCommands('downloadPatchFromPpk', {
              updateUrl: DownloadUrl,
              hash: Hash,
              originHash: Hash,
            }),
          );
        },
      },
      {
        name: 'downloadPatchFromPackage',
        invoke: () => {
          setText(
            convertCommands('downloadPatchFromPackage', {
              updateUrl: DownloadUrl,
              hash: Hash,
            }),
          );
        },
      },
      {
        name: 'downloadFullUpdate',
        invoke: () => {
          setText(
            convertCommands('downloadFullUpdate', {
              updateUrl: DownloadUrl,
              hash: Hash,
            }),
          );
        },
      },
      {
        name: 'downloadAndInstallApk',
        invoke: () => {
          setText(
            convertCommands('downloadAndInstallApk', {
              url: DownloadUrl,
              target: Hash,
              hash: Hash,
            }),
          );
        },
      },
    ];

  return (
    <Modal visible={visible}>
      <SafeAreaView style={{flex: 1, padding: 10}}>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
          <Text>调试Pushy方法（方法名，参数，值换行）</Text>
          <Button title="Close" onPress={onClose} />
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
              let params;
              if (inputs.length === 1) {
                await PushyModule[methodName]();
              } else {
                if (inputs.length === 2) {
                  params = inputs[1];
                } else {
                  params = {};
                  for (let i = 1; i < inputs.length; i += 2) {
                    params[inputs[i]] = inputs[i + 1];
                  }
                  console.log({inputs, params});
                }
                await PushyModule[methodName](params);
              }
              Alert.alert('done');
            } catch (e) {
              Alert.alert(e.message);
            }
            setRunning(false);
          }}>
          <Text style={{color: 'white'}}>执行</Text>
        </TouchableOpacity>
        <Button title="重置" onPress={() => setText('')} />
        {
          <View>
            {shortCuts.map(({name, invoke}, i) => (
              <TouchableOpacity
                key={i}
                testID={name}
                onPress={() => {
                  invoke();
                }}>
                <Text>{name}</Text>
              </TouchableOpacity>
            ))}
          </View>
        }
      </SafeAreaView>
    </Modal>
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
