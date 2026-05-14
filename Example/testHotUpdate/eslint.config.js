const {fixupConfigRules} = require('@eslint/compat');
const reactNativeConfig = require('@react-native/eslint-config/flat');

module.exports = [
  {
    ignores: [
      'android/build/**',
      'android/.gradle/**',
      'ios/build/**',
      'ios/Pods/**',
      'artifacts/**',
      '.e2e-artifacts/**',
      '.cresc.temp/**',
    ],
  },
  ...fixupConfigRules(reactNativeConfig),
];
