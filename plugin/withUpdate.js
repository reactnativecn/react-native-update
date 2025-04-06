const { withDangerousMod } = require('@expo/config-plugins');
const {
  mergeContents,
} = require('@expo/config-plugins/build/utils/generateCode');
const fs = require('fs');
const path = require('path');

const withUpdate = config => {
  config = withDangerousMod(config, [
    'ios',
    async config => {
      const projectName = config.modRequest.projectName;
      const appDelegatePath = path.join(
        config.modRequest.platformProjectRoot,
        projectName,
        'AppDelegate.mm',
      );
      const contents = fs.readFileSync(appDelegatePath, 'utf-8');

      const newContents = mergeContents({
        src: contents,
        newSrc: '#import "RCTPushy.h"',
        anchor: '#import <React/RCTBundleURLProvider.h>',
        offset: 1,
        tag: 'react-native-update-header',
        comment: '//',
      });

      const finalContents = newContents.contents.replace(
        'return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];',
        'return [RCTPushy bundleURL];',
      );

      fs.writeFileSync(appDelegatePath, finalContents);

      return config;
    },
  ]);

  config = withDangerousMod(config, [
    'android',
    async config => {
      const buildGradlePath = path.join(
        config.modRequest.platformProjectRoot,
        'app/build.gradle',
      );
      const gradleContents = fs.readFileSync(buildGradlePath, 'utf-8');

      const buildTimeConfig = `
int MILLIS_IN_MINUTE = 1000 * 60
int minutesSinceEpoch = System.currentTimeMillis() / MILLIS_IN_MINUTE

android {
    buildTypes {
        debug {
            resValue("string", "pushy_build_time", "0")
        }
        release {
            resValue("string", "pushy_build_time", "\${minutesSinceEpoch}")
        }
    }
}
`;

      const newContents = mergeContents({
        src: gradleContents,
        newSrc: buildTimeConfig,
        anchor: 'android {',
        offset: 0,
        tag: 'react-native-update-buildtime',
        comment: '//',
      });

      fs.writeFileSync(buildGradlePath, newContents.contents);

      const mainApplicationPath = path.join(
        config.modRequest.platformProjectRoot,
        'app/src/main/java',
        ...config.android.package.split('.'),
        'MainApplication.kt',
      );
      const mainApplicationContents = fs.readFileSync(
        mainApplicationPath,
        'utf-8',
      );

      const contentsWithImport = mergeContents({
        src: mainApplicationContents,
        newSrc: 'import cn.reactnative.modules.update.UpdateContext',
        anchor: 'package',
        offset: 1,
        tag: 'react-native-update-import',
        comment: '//',
      });

      const bundleMethodCode =
        'override fun getJSBundleFile(): String? = UpdateContext.getBundleUrl(this@MainApplication)';
      const finalContents = contentsWithImport.contents.replace(
        /override fun getJSMainModuleName\(\): String = "\.expo\/\.virtual-metro-entry"/,
        `$&\n\n          ${bundleMethodCode}`,
      );

      fs.writeFileSync(mainApplicationPath, finalContents);

      return config;
    },
  ]);

  return config;
};

module.exports = withUpdate;
