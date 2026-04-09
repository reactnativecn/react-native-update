const path = require('path');

const { buildRoot, compileNodeTs } = require('./compile-node-ts');

module.exports = function loadCompiledE2EHook(relativeEntry) {
  compileNodeTs();
  return require(path.join(buildRoot, relativeEntry));
};
