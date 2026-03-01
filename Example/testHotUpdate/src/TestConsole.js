/* eslint-disable react-native/no-inline-styles */
/* eslint-disable react/react-in-jsx-scope */
import {useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Button,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {PushyModule} from 'react-native-update/src/core';
import {
  LOCAL_UPDATE_FILES,
  LOCAL_UPDATE_HASHES,
  LOCAL_UPDATE_PORT,
} from '../e2e/localUpdateConfig';

const UUID = '00000000-0000-0000-0000-000000000000';

function createLocalAssetUrls() {
  const host = Platform.OS === 'android' ? '10.0.2.2' : '127.0.0.1';
  const baseUrl = `http://${host}:${LOCAL_UPDATE_PORT}/${Platform.OS}`;
  return {
    full: `${baseUrl}/${LOCAL_UPDATE_FILES.full}`,
    ppkDiff: `${baseUrl}/${LOCAL_UPDATE_FILES.ppkDiff}`,
    packageDiff: `${baseUrl}/${LOCAL_UPDATE_FILES.packageDiff}`,
    apk: `${baseUrl}/${LOCAL_UPDATE_FILES.apk}`,
  };
}

export default function TestConsole({visible, onClose}) {
  const [text, setText] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const urls = useMemo(createLocalAssetUrls, []);

  const convertCommands = (cmd, params) => {
    if (!params) {
      return cmd;
    }
    if (typeof params === 'string') {
      return `${cmd}\n${params}`;
    }
    let paramText = '';
    for (const [k, v] of Object.entries(params)) {
      paramText += `\n${k}\n${v}`;
    }
    return `${cmd}${paramText}`.trim();
  };

  const invokePushyMethod = async (methodName, params) => {
    if (methodName === 'setLocalHashInfo') {
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw new Error('setLocalHashInfo requires hash and info fields');
      }
      const {hash, ...info} = params;
      if (!hash) {
        throw new Error('setLocalHashInfo requires hash');
      }
      return PushyModule.setLocalHashInfo(hash, JSON.stringify(info));
    }

    if (params === undefined) {
      return PushyModule[methodName]();
    }

    return PushyModule[methodName](params);
  };
  const shortCuts = [
      {
        name: 'setLocalHashInfo',
        invoke: () => {
          setText(
            convertCommands('setLocalHashInfo', {
              hash: LOCAL_UPDATE_HASHES.full,
              version: '1.0.0-e2e',
              size: '19M-e2e',
            }),
          );
        },
      },
      {
        name: 'getLocalHashInfo',
        invoke: () => {
          setText(convertCommands('getLocalHashInfo', LOCAL_UPDATE_HASHES.full));
        },
      },
      {
        name: 'setUuid',
        invoke: () => {
          setText(convertCommands('setUuid', UUID));
        },
      },
      {
        name: 'reloadUpdateFull',
        invoke: () => {
          setText(
            convertCommands('reloadUpdate', {hash: LOCAL_UPDATE_HASHES.full}),
          );
        },
      },
      {
        name: 'setNeedUpdateFull',
        invoke: () => {
          setText(
            convertCommands('setNeedUpdate', {hash: LOCAL_UPDATE_HASHES.full}),
          );
        },
      },
      {
        name: 'downloadFullUpdate',
        invoke: () => {
          setText(
            convertCommands('downloadFullUpdate', {
              updateUrl: urls.full,
              hash: LOCAL_UPDATE_HASHES.full,
            }),
          );
        },
      },
      {
        name: 'downloadPatchFromPpk',
        invoke: () => {
          setText(
            convertCommands('downloadPatchFromPpk', {
              updateUrl: urls.ppkDiff,
              hash: LOCAL_UPDATE_HASHES.ppkPatch,
              originHash: LOCAL_UPDATE_HASHES.full,
            }),
          );
        },
      },
      {
        name: 'setNeedUpdatePatched',
        invoke: () => {
          setText(
            convertCommands('setNeedUpdate', {
              hash: LOCAL_UPDATE_HASHES.ppkPatch,
            }),
          );
        },
      },
      {
        name: 'reloadUpdatePatched',
        invoke: () => {
          setText(
            convertCommands('reloadUpdate', {
              hash: LOCAL_UPDATE_HASHES.ppkPatch,
            }),
          );
        },
      },
      {
        name: 'markSuccess',
        invoke: () => {
          setText(convertCommands('markSuccess'));
        },
      },
    ];

  if (Platform.OS === 'android') {
    shortCuts.push(
      {
        name: 'downloadPatchFromPackage',
        invoke: () => {
          setText(
            convertCommands('downloadPatchFromPackage', {
              updateUrl: urls.packageDiff,
              hash: LOCAL_UPDATE_HASHES.packagePatch,
            }),
          );
        },
      },
      {
        name: 'setNeedUpdatePackage',
        invoke: () => {
          setText(
            convertCommands('setNeedUpdate', {
              hash: LOCAL_UPDATE_HASHES.packagePatch,
            }),
          );
        },
      },
      {
        name: 'reloadUpdatePackage',
        invoke: () => {
          setText(
            convertCommands('reloadUpdate', {
              hash: LOCAL_UPDATE_HASHES.packagePatch,
            }),
          );
        },
      },
      {
        name: 'downloadAndInstallApk',
        invoke: () => {
          setText(
            convertCommands('downloadAndInstallApk', {
              url: urls.apk,
              target: 'update.apk',
              hash: LOCAL_UPDATE_HASHES.packagePatch,
            }),
          );
        },
      },
    );
  }

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
          <Button title="Close" onPress={onClose} testID="close-console" />
        </View>
        <TextInput
          testID="command-input"
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
            setResult(null);
            setRunning(true);
            try {
              const inputs = text
                .split('\n')
                .map(v => v.trim())
                .filter(v => v.length > 0);
              const methodName = inputs[0];
              if (!methodName || typeof PushyModule[methodName] !== 'function') {
                throw new Error(`Unknown method: ${methodName || '(empty)'}`);
              }
              let params;
              let output;
              if (inputs.length === 1) {
                output = await invokePushyMethod(methodName);
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
                output = await invokePushyMethod(methodName, params);
              }
              const message =
                output == null
                  ? ''
                  : typeof output === 'string'
                  ? output
                  : JSON.stringify(output);
              setResult({
                status: 'done',
                message,
              });
            } catch (e) {
              setResult({
                status: 'error',
                message: e?.message || String(e),
              });
            }
            setRunning(false);
          }}>
          <Text style={{color: 'white'}}>执行</Text>
        </TouchableOpacity>
        <Button title="重置" onPress={() => setText('')} />
        {result && (
          <View style={{marginTop: 10}}>
            <Text testID="command-status">{result.status}</Text>
            <Text testID="command-message">{result.message || '(empty)'}</Text>
            <TouchableOpacity
              testID="result-clear"
              onPress={() => setResult(null)}>
              <Text style={{color: '#007bff'}}>清空结果</Text>
            </TouchableOpacity>
          </View>
        )}
        <ScrollView
          style={{marginTop: 12}}
          contentContainerStyle={{paddingBottom: 24}}
          testID="shortcut-list">
          {shortCuts.map(({name, invoke}, i) => (
            <TouchableOpacity
              key={i}
              testID={name}
              onPress={() => {
                invoke();
              }}
              style={{paddingVertical: 6}}>
              <Text>{name}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}
