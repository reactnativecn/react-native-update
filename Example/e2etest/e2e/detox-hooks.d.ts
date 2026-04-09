declare module 'detox/runners/jest/globalSetup.js' {
  const detoxGlobalSetup: () => Promise<void>;
  export default detoxGlobalSetup;
}

declare module 'detox/runners/jest/globalTeardown.js' {
  const detoxGlobalTeardown: () => Promise<void>;
  export default detoxGlobalTeardown;
}
