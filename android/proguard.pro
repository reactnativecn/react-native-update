# Keep our update module classes
-keepnames class cn.reactnative.modules.update.DownloadTask { *; }
-keepnames class cn.reactnative.modules.update.UpdateModuleImpl { *; }
-keepnames class cn.reactnative.modules.update.** { *; }

# Keep React Native classes
-keepnames class com.facebook.react.ReactInstanceManager { *; }
-keepnames class com.facebook.react.** { *; }
-keepnames class com.facebook.react.bridge.** { *; }
-keepnames class com.facebook.react.devsupport.** { *; }

# Keep fields used in reflection
-keepclassmembers class com.facebook.react.ReactActivity { *; }
-keepclassmembers class com.facebook.react.ReactInstanceManager { *; }
-keepclassmembers class com.facebook.react.ReactDelegate { *; }
-keepclassmembers class com.facebook.react.ReactHost { *; }

-keepnames class expo.modules.ExpoReactHostFactory$ExpoReactHostDelegate { *; }
