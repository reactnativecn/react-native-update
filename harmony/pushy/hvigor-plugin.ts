import fs from 'fs';
import path from 'path';

export function reactNativeUpdatePlugin() {
  return {
    pluginId: 'reactNativeUpdatePlugin',
    apply(_node) {
      const cwd = process.cwd();
      const metaFilePath = path.resolve(
        cwd,
        'entry/src/main/resources/rawfile/meta.json',
      );
      fs.mkdirSync(path.dirname(metaFilePath), { recursive: true });

      const moduleJsonPath = path.resolve(cwd, 'AppScope/app.json5');
      let versionName = '';
      if (fs.existsSync(moduleJsonPath)) {
        const content = fs.readFileSync(moduleJsonPath, 'utf-8');
        const match = content.match(
          /(?:"versionName"|versionName):\s*["']([^"']+)["']/,
        );
        versionName = match?.[1] || '';
      }

      const metaContent = {
        pushy_build_time: String(Date.now()),
        versionName,
      };

      fs.writeFileSync(metaFilePath, JSON.stringify(metaContent, null, 2));
      console.log(`Build time written to ${metaFilePath}`);
    },
  };
}
