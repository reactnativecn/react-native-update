require 'json'
require 'rubygems' # Required for version comparison


new_arch_enabled = ENV['RCT_NEW_ARCH_ENABLED'] == '1'
package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
podspec_dir = File.dirname(__FILE__)

Pod::Spec.new do |s|

  is_expo_in_podfile = false
  begin
    # Check Podfile for use_expo_modules!
    podfile_path = File.join(Pod::Config.instance.installation_root, 'Podfile')
    if File.exist?(podfile_path)
      podfile_content = File.read(podfile_path)
      is_expo_in_podfile = podfile_content.include?('use_expo_modules!')
    end
  rescue => e
     # Silently ignore errors during check
  end

  # Determine final validity by checking Podfile presence AND Expo version
  valid_expo_project = false # Default
  if is_expo_in_podfile
    # Only check expo version if use_expo_modules! is present
    is_version_sufficient = false
    begin
        expo_version_str = `node --print \"require('expo/package.json').version\"`.strip
        if expo_version_str && !expo_version_str.empty?
          match = expo_version_str.match(/^\d+/)
          if match
            major_version = match[0].to_i
            is_version_sufficient = major_version >= 50
          end
        end
    rescue
        # Node command failed, version remains insufficient
    end
    
    # Final check
    valid_expo_project = is_version_sufficient
  end

  # Set platform based on whether it's a valid Expo project and if we can parse its target
  final_ios_deployment_target = '11.0' # Default target

  if valid_expo_project
    # --- Try to find and parse ExpoModulesCore.podspec only if it's an Expo project ---
    parsed_expo_ios_target = nil
    expo_modules_core_podspec_path = begin
        package_json_path = `node -p "require.resolve('expo-modules-core/package.json')"`.strip
        File.join(File.dirname(package_json_path), 'ExpoModulesCore.podspec') if $?.success? && package_json_path && !package_json_path.empty?
    rescue
        nil
    end

    if expo_modules_core_podspec_path && File.exist?(expo_modules_core_podspec_path)
      begin
        content = File.read(expo_modules_core_podspec_path)
        match = content.match(/s\.platforms\s*=\s*\{[\s\S]*?:ios\s*=>\s*'([^\']+)'/) # Match within s.platforms hash
        if match && match[1]
          parsed_expo_ios_target = match[1]
        else
          match = content.match(/s\.platform\s*=\s*:ios,\s*'([^\']+)'/) # Fallback to s.platform = :ios, 'version'
          if match && match[1]
            parsed_expo_ios_target = match[1]
          end
        end
      rescue => e
        # Pod::UI.warn "Failed to read or parse ExpoModulesCore.podspec content: #{e.message}"
      end
    end
    if parsed_expo_ios_target
        final_ios_deployment_target = parsed_expo_ios_target
    end
  end

  s.platforms = { :ios => final_ios_deployment_target }

  s.name         = package['name']
  s.version      = package['version']
  s.summary      = package['description']
  s.license      = package['license']

  s.authors      = package['author']
  s.homepage     = package['homepage']

  s.cocoapods_version = '>= 1.6.0'

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
    ss.public_header_files = ['ios/RCTPushy/*.h']
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

    # 1. Try executing node to get the version string
    expo_modules_core_version_str = begin
      # Use node to directly require expo-modules-core/package.json and get its version
      `node --print \"require('expo-modules-core/package.json').version\"` # Execute, keep raw output
    rescue
      # Node command failed (e.g., node not found, package not found). Return empty string.
      ''
    end

    # 2. Process the obtained version string (if not empty)
    if expo_modules_core_version_str && !expo_modules_core_version_str.empty?
        begin
            # Compare versions using Gem::Version (handles trailing newline)
            installed_version = Gem::Version.new(expo_modules_core_version_str)
            target_version = Gem::Version.new('1.12.0')
            supports_bundle_url_final = installed_version >= target_version
        rescue ArgumentError
            # If Gem::Version fails parsing, supports_bundle_url_final remains false.
        end
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
