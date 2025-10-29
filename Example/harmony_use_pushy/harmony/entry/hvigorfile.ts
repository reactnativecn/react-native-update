import {hapTasks} from '@ohos/hvigor-ohos-plugin';
import {reactNativeUpdatePlugin} from 'pushy/hvigor-plugin';

export default {
  system: hapTasks /* Built-in plugin of Hvigor. It cannot be modified. */,
  plugins: [
    reactNativeUpdatePlugin(),
  ] /* Custom plugin to extend the functionality of Hvigor. */,
};
