/**
 * @format
 */

import 'react-native';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import App from '../src';

jest.mock('react-native-camera-kit', () => ({
  Camera: 'Camera',
}));

jest.mock('react-native-svg/css', () => ({
  LocalSvg: 'LocalSvg',
}));

jest.mock('../src/TestConsole', () => 'TestConsole');

jest.mock('react-native-paper', () => {
  const React = require('react');
  const { Text, TouchableOpacity, View } = require('react-native');

  return {
    Icon: props => <View {...props} />,
    PaperProvider: ({ children }) => <>{children}</>,
    Snackbar: ({ children }) => <View>{children}</View>,
    Banner: ({ children }) => <View>{children}</View>,
    Button: ({ children, onPress, title, ...props }) => (
      <TouchableOpacity onPress={onPress} {...props}>
        <Text>{children ?? title}</Text>
      </TouchableOpacity>
    ),
    Modal: ({ children, visible }) => (visible ? <View>{children}</View> : null),
    Portal: ({ children }) => <>{children}</>,
  };
});

jest.mock('react-native-update', () => {
  const React = require('react');

  return {
    Pushy: function Pushy() {
      return {
        setOptions: jest.fn(),
        version: 'test-version',
      };
    },
    UpdateProvider: ({ children }) => children,
    useUpdate: () => ({
      client: {
        setOptions: jest.fn(),
        version: 'test-version',
      },
      checkUpdate: jest.fn(),
      downloadUpdate: jest.fn(),
      switchVersionLater: jest.fn(),
      switchVersion: jest.fn(),
      updateInfo: null,
      packageVersion: '1.0.0',
      currentHash: '',
      parseTestQrCode: jest.fn(),
      progress: {},
      currentVersionInfo: null,
    }),
  };
});

it('renders correctly', async () => {
  let tree;

  await act(async () => {
    tree = renderer.create(<App />);
  });

  expect(tree.toJSON()).toBeTruthy();
});
