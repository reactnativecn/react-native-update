const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..'); // react-native-update module root
const expoConfigPath = path.resolve(projectRoot, 'expo-module.config.json');

function getExpoMajorVersion() {
  let resolvedExpoPackagePath;
  try {
    // Use require.resolve to find expo's package.json from the host project's perspective
    resolvedExpoPackagePath = require.resolve('expo/package.json', {
      paths: [path.resolve(projectRoot, '..', '..')],
    });
  } catch (e) {
    console.log(
      'Expo not found in project node_modules (via require.resolve).',
    );
    return null; // Expo not found or resolvable
  }

  // Check if the resolved path actually exists (belt-and-suspenders)
  if (!fs.existsSync(resolvedExpoPackagePath)) {
    console.log(
      `Expo package.json path resolved to ${resolvedExpoPackagePath}, but file does not exist.`,
    );
    return null;
  }

  try {
    const packageJson = JSON.parse(
      fs.readFileSync(resolvedExpoPackagePath, 'utf8'),
    );
    const version = packageJson.version;
    if (!version) {
      console.log('Expo package.json does not contain a version.');
      return null; // Version not found
    }

    // Extract the first number sequence as the major version
    const match = version.match(/\d+/);
    if (!match) {
      console.log(
        `Could not parse major version from Expo version string: ${version}`,
      );
      return null; // Cannot parse version
    }

    return parseInt(match[0], 10);
  } catch (error) {
    console.error('Error reading or parsing Expo package.json:', error);
    return null; // Error during processing
  }
}

function checkAndCleanExpoConfig() {
  const majorVersion = getExpoMajorVersion();

  // Condition: Expo not found OR major version is less than 50
  if (majorVersion === null || majorVersion < 50) {
    if (fs.existsSync(expoConfigPath)) {
      try {
        fs.unlinkSync(expoConfigPath);
        console.log(
          `Expo version (${
            majorVersion !== null ? majorVersion : 'not found'
          }) is < 50 or Expo not found. Deleted ${expoConfigPath}`,
        );
      } catch (error) {
        console.error(`Failed to delete ${expoConfigPath}:`, error);
      }
    } else {
      console.log(
        `Expo version (${
          majorVersion !== null ? majorVersion : 'not found'
        }) is < 50 or Expo not found. ${expoConfigPath} does not exist, no action needed.`,
      );
    }
  } else {
    console.log(
      `Expo version (${majorVersion}) is >= 50. Kept ${expoConfigPath}`,
    );
  }
}

checkAndCleanExpoConfig();
