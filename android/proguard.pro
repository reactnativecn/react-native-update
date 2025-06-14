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
-keepclassmembers class com.facebook.react.ReactInstanceManager {
    private JSBundleLoader mBundleLoader;
    private String mJSBundleFile;
}

-keepclassmembers class com.facebook.react.ReactDelegate {
    private ReactHost mReactHost;
}

-keepclassmembers class com.facebook.react.ReactHost {
    private boolean mUseDevSupport;
    private ReactHostDelegate mReactHostDelegate;
}

# Keep Expo related classes
-keepnames class expo.modules.ExpoReactHostFactory$ExpoReactHostDelegate { *; }

# Keep methods used in reflection
-keepclassmembers class com.facebook.react.ReactActivity {
    public ReactDelegate getReactDelegate();
}

-keepclassmembers class com.facebook.react.ReactHost {
    public void reload(java.lang.String);
}