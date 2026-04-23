/**
 * @format
 */

import 'react-native';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import App from '../src';

jest.mock('react-native-update', () => ({
  Pushy: function Pushy() {
    return {};
  },
  UpdateProvider: ({ children }) => children,
  useUpdate: () => ({
    checkUpdate: jest.fn(),
    client: {
      setOptions: jest.fn(),
      version: 'test-version',
    },
    packageVersion: '1.0.0',
    currentHash: '',
    lastError: null,
    progress: {},
    currentVersionInfo: null,
  }),
}));

it('renders correctly', async () => {
  let tree;

  await act(async () => {
    tree = renderer.create(<App />);
  });

  expect(tree.toJSON()).toBeTruthy();
});
