package com.awesomeproject

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import cn.reactnative.modules.update.UpdateContext

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be auto-linked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        },
      jsBundleFilePath = UpdateContext.getBundleUrl(this),
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
