require 'json'
require 'rubygems' # Required for version comparison


new_arch_enabled = ENV['RCT_NEW_ARCH_ENABLED'] == '1'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
podspec_dir = File.dirname(__FILE__)

Pod::Spec.new do |s|

  is_expo_in_podfile = false
  is_version_sufficient = false
  begin
    # Check Podfile for use_expo_modules!
    podfile_path = File.join(Pod::Config.instance.installation_root, 'Podfile')
    if File.exist?(podfile_path)
      podfile_content = File.read(podfile_path)
      is_expo_in_podfile = podfile_content.include?('use_expo_modules!')
    end
    # Check root package.json for Expo version >= 50
    root_package_json_path = File.join(podspec_dir, '..', '..', 'package.json')
    if File.exist?(root_package_json_path)
        pkg_json = JSON.parse(File.read(root_package_json_path))
        expo_version_string = pkg_json['dependencies']&.[]('expo') || pkg_json['devDependencies']&.[]('expo')
        if expo_version_string
          match = expo_version_string.match(/\d+/)
          if match
            major_version = match[0].to_i
            is_version_sufficient = major_version >= 50
          end
        end
    end
  rescue => e
     # Silently ignore errors during check
  end
  # Determine final validity
  valid_expo_project = is_expo_in_podfile && is_version_sufficient

  s.name         = package['name']
  s.version      = package['version']
  s.summary      = package['description']
  s.license      = package['license']

  s.authors      = package['author']
  s.homepage     = package['homepage']

  s.cocoapods_version = '>= 1.6.0'
  s.platform = :ios, "8.0"
  s.platforms = { :ios => "11.0" }
  s.source = { :git => 'https://github.com/reactnativecn/react-native-update.git', :tag => '#{s.version}' }

  # Conditionally set source files
  if valid_expo_project
    s.source_files = Dir.glob("ios/**/*.{h,m,mm,swift}") # Include Expo files
  else
    s.source_files = Dir.glob("ios/**/*.{h,m,mm,swift}").reject { |f| f.start_with?("ios/Expo/") } # Exclude Expo files
  end

  s.libraries = 'bz2', 'z'
  s.vendored_libraries = 'RCTPushy/libRCTPushy.a'
  s.pod_target_xcconfig = { 
    'USER_HEADER_SEARCH_PATHS' => "#{podspec_dir}/ios", 
    "DEFINES_MODULE" => "YES" 
  }
  s.resource = 'ios/pushy_build_time.txt'
  s.script_phase = { :name => 'Generate build time', :script => "set -x;date +%s > \"#{podspec_dir}/ios/pushy_build_time.txt\"", :execution_position => :before_compile }

  s.dependency 'React'
  s.dependency "React-Core"
  s.dependency 'SSZipArchive'

  # Conditionally add Expo dependency
  if valid_expo_project
    s.dependency 'ExpoModulesCore'
  end

  s.subspec 'RCTPushy' do |ss|
    ss.source_files = 'ios/RCTPushy/*.{h,m,mm,swift}'
    ss.public_header_files = ['ios/RCTPushy/RCTPushy.h']
  end

  s.subspec 'HDiffPatch' do |ss|
    ss.source_files = ['ios/RCTPushy/HDiffPatch/**/*.{h,m,c}',
                       'android/jni/hpatch.{h,c}',
                       'android/jni/HDiffPatch/libHDiffPatch/HPatch/*.{h,c}',
                       'android/jni/HDiffPatch/file_for_patch.{h,c}',
                       'android/jni/lzma/C/LzmaDec.{h,c}',
                       'android/jni/lzma/C/Lzma2Dec.{h,c}']
    ss.public_header_files = 'ios/RCTPushy/HDiffPatch/**/*.h'
  end

  # Conditionally add Expo subspec and check ExpoModulesCore version
  if valid_expo_project
    supports_bundle_url_final = false # Default
    begin
      # Check installed ExpoModulesCore version for bundle URL support
      expo_core_package_json_path = File.join(podspec_dir, '..', 'expo-modules-core', 'package.json')
      if File.exist?(expo_core_package_json_path)
          core_package_json = JSON.parse(File.read(expo_core_package_json_path))
          installed_version_str = core_package_json['version']
          if installed_version_str
            installed_version = Gem::Version.new(installed_version_str)
            target_version = Gem::Version.new('1.12.0')
            supports_bundle_url_final = installed_version >= target_version
          end
      end
    rescue JSON::ParserError, Errno::ENOENT, ArgumentError, StandardError => e
      # Pod::UI.warn "Could not check ExpoModulesCore version: #{e.message}"
    end

    s.subspec 'Expo' do |ss|
      ss.source_files = 'ios/Expo/**/*.{h,m,mm,swift}'
      if supports_bundle_url_final
        ss.pod_target_xcconfig = { 'SWIFT_ACTIVE_COMPILATION_CONDITIONS' => 'EXPO_SUPPORTS_BUNDLEURL' }
      end
    end
  end

  if defined?(install_modules_dependencies()) != nil
    install_modules_dependencies(s);
  else
    if new_arch_enabled
      folly_compiler_flags = '-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1 -Wno-comma -Wno-shorten-64-to-32'

      s.compiler_flags = folly_compiler_flags + " -DRCT_NEW_ARCH_ENABLED=1"

      s.pod_target_xcconfig = {
          "HEADER_SEARCH_PATHS" => "\"$(PODS_ROOT)/boost\"",
          "CLANG_CXX_LANGUAGE_STANDARD" => "c++17"
      }.merge(s.pod_target_xcconfig)
      s.dependency "React-Codegen"
      s.dependency "RCT-Folly"
      s.dependency "RCTRequired"
      s.dependency "RCTTypeSafety"
      s.dependency "ReactCommon/turbomodule/core"
    end
  end
end
