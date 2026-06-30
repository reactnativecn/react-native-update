const fs = require("fs");
const path = require("path");

function requireConfigPlugins() {
  try {
    return require("@expo/config-plugins");
  } catch {
    return require(require.resolve("@expo/config-plugins", {
      paths: [process.cwd()],
    }));
  }
}

const { withDangerousMod } = requireConfigPlugins();

const RCT_BRIDGE_IMPORT = "#import <React/RCTBridge.h>";

function withPushyRCTBridgeImport(config) {
  return withDangerousMod(config, [
    "ios",
    (config) => {
      const { platformProjectRoot, projectName } = config.modRequest;
      const bridgingHeaderPath = path.join(
        platformProjectRoot,
        projectName,
        `${projectName}-Bridging-Header.h`
      );

      const contents = fs.readFileSync(bridgingHeaderPath, "utf8");

      if (!contents.includes(RCT_BRIDGE_IMPORT)) {
        fs.writeFileSync(
          bridgingHeaderPath,
          `${contents.trimEnd()}\n\n${RCT_BRIDGE_IMPORT}\n`
        );
      }

      return config;
    },
  ]);
}

module.exports = withPushyRCTBridgeImport;
