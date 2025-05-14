import React, { PureComponent, ComponentType } from 'react';
import {
  Platform,
  Alert,
  Linking,
  AppState,
  NativeEventSubscription,
} from 'react-native';

import {
  isFirstTime,
  isRolledBack,
  checkUpdate,
  downloadUpdate,
  switchVersion,
  switchVersionLater,
  markSuccess,
  downloadAndInstallApk,
  onPushyEvents,
} from './main';
import { UpdateEventsListener } from './type';

export function simpleUpdate(
  WrappedComponent: ComponentType,
  options: { appKey?: string; onPushyEvents?: UpdateEventsListener } = {},
) {
  const { appKey, onPushyEvents: eventListeners } = options;
  if (!appKey) {
    throw new Error('appKey is required for simpleUpdate()');
  }
  if (typeof eventListeners === 'function') {
    onPushyEvents(eventListeners);
  }
  return __DEV__
    ? WrappedComponent
    : class AppUpdate extends PureComponent {
        stateListener: NativeEventSubscription | null = null;
        componentDidMount() {
          if (isRolledBack) {
            Alert.alert('抱歉', '刚刚更新遭遇错误，已为您恢复到更新前版本');
          } else if (isFirstTime) {
            markSuccess();
          }
          this.stateListener = AppState.addEventListener(
            'change',
            (nextAppState) => {
              if (nextAppState === 'active') {
                this.checkUpdate();
              }
            },
          );
          this.checkUpdate();
        }
        componentWillUnmount() {
          this.stateListener && this.stateListener.remove();
        }
        doUpdate = async (info) => {
          try {
            const hash = await downloadUpdate(info);
            if (!hash) {
              return;
            }
            this.stateListener && this.stateListener.remove();
            Alert.alert('提示', '下载完毕，是否立即更新?', [
              {
                text: '以后再说',
                style: 'cancel',
                onPress: () => {
                  switchVersionLater(hash);
                },
              },
              {
                text: '立即更新',
                style: 'default',
                onPress: () => {
                  switchVersion(hash);
                },
              },
            ]);
          } catch (err: any) {
            Alert.alert('更新失败', err.message);
          }
        };

        checkUpdate = async () => {
          let info;
          try {
            info = await checkUpdate(appKey!);
          } catch (err: any) {
            Alert.alert('更新检查失败', err.message);
            return;
          }
          if (info.expired) {
            Alert.alert('提示', '您的应用版本已更新，点击确定下载安装新版本', [
              {
                text: '确定',
                onPress: () => {
                  if (info.downloadUrl) {
                    if (
                      Platform.OS === 'android' &&
                      info.downloadUrl.endsWith('.apk')
                    ) {
                      downloadAndInstallApk({
                        url: info.downloadUrl,
                      });
                    } else {
                      Linking.openURL(info.downloadUrl);
                    }
                  }
                },
              },
            ]);
          } else if (info.update) {
            Alert.alert(
              '提示',
              '检查到新的版本' + info.name + ',是否下载?\n' + info.description,
              [
                { text: '否', style: 'cancel' },
                {
                  text: '是',
                  style: 'default',
                  onPress: () => {
                    this.doUpdate(info);
                  },
                },
              ],
            );
          }
        };

        render() {
          return <WrappedComponent {...this.props} />;
        }
      };
}
