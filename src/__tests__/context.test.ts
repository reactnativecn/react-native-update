import { describe, expect, test, mock, afterEach, afterAll } from 'bun:test';

// Must set __DEV__ before importing context.ts
const _origDEV = (globalThis as any).__DEV__;
(globalThis as any).__DEV__ = true;

const mockUseContext = mock(() => ({}));

mock.module('react', () => {
  return {
    createContext: mock((defaultValue) => defaultValue),
    useContext: mockUseContext,
  };
});

// Import context after setting up mocks
const { useUpdate } = await import('../context');
const { default: i18n } = await import('../i18n');

describe('context', () => {
  afterAll(() => {
    (globalThis as any).__DEV__ = _origDEV;
  });

  afterEach(() => {
    mockUseContext.mockClear();
  });

  test('useUpdate throws error when used outside UpdateProvider in __DEV__', () => {
    mockUseContext.mockReturnValue({});

    expect(() => useUpdate()).toThrow(i18n.t('error_use_update_outside_provider'));
  });

  test('useUpdate returns context when used inside UpdateProvider', () => {
    const mockContext = { client: {} };
    mockUseContext.mockReturnValue(mockContext);

    expect(useUpdate()).toBe(mockContext as any);
  });
});
