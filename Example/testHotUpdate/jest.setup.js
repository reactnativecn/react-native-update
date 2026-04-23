global.window = global.window || global;

if (typeof global.window.dispatchEvent !== 'function') {
  global.window.dispatchEvent = () => false;
}
