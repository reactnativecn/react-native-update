import { describe, expect, test, mock, afterEach } from 'bun:test';

// Must set __DEV__ before importing context.ts
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
