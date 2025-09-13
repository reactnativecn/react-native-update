export default {
  // Common messages
  checking_update: 'Checking for updates...',
  downloading_update: 'Downloading update package...',
  installing_update: 'Installing update...',
  update_available: 'Update available',
  update_downloaded: 'Update downloaded successfully',
  update_installed: 'Update installed successfully',
  no_update_available: 'You are up to date',
  update_failed: 'Update failed',
  network_error: 'Network connection error',
  download_failed: 'Download failed',
  install_failed: 'Installation failed',

  // Progress messages with interpolation
  download_progress: 'Download progress: {{progress}}%',
  download_speed: 'Download speed: {{speed}}/s',
  file_size: 'File size: {{size}}',
  time_remaining: 'Time remaining: {{time}}',

  // Error messages
  error_code: 'Error code: {{code}}',
  error_message: 'Error message: {{message}}',
  retry_count: 'Retry attempt: {{count}}/{{max}}',

  // Update info
  version_info: 'Version {{version}} ({{build}})',
  release_notes: 'Release notes: {{notes}}',
  update_size: 'Update size: {{size}}MB',

  // Alert messages
  alert_title: 'Notice',
  alert_update_ready: 'Download completed. Update now?',
  alert_next_time: 'Later',
  alert_update_now: 'Update Now',
  alert_app_updated:
    'Your app version has been updated. Click update to download and install the new version',
  alert_update_button: 'Update',
  alert_cancel: 'Cancel',
  alert_confirm: 'OK',
  alert_info: 'Info',
  alert_no_update_wait:
    'No update found, please wait 10s for the server to generate the patch package',

  // Error messages
  error_appkey_required: 'appKey is required',
  error_update_check_failed: 'Update check failed',
  error_cannot_connect_server:
    'Can not connect to update server. Please check your network.',
  error_cannot_connect_backup:
    'Can not connect to update server: {{message}}. Trying backup endpoints.',
  error_diff_failed: 'diff error: {{message}}',
  error_pdiff_failed: 'pdiff error: {{message}}',
  error_full_patch_failed: 'full patch error: {{message}}',
  error_all_promises_rejected: 'All promises were rejected',
  error_ping_failed: 'Ping failed',
  error_ping_timeout: 'Ping timeout',
  error_http_status: '{{status}} {{statusText}}',

  // Development messages
  dev_debug_disabled:
    'You are currently in the development environment and have not enabled debug mode. {{matter}} will not be performed. If you need to debug {{matter}} in the development environment, please set debug to true in the client.',
  dev_log_prefix: 'react-native-update: ',
  dev_web_not_supported:
    'react-native-update does not support the Web platform and will not perform any operations',

  // More alert messages
  alert_new_version_found:
    'New version {{name}} found. Download now?\n{{description}}',
};
